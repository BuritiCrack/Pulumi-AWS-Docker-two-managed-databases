import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { ContainerImage } from "./image";

export interface StorefrontArgs {
  vpcId: pulumi.Input<string>;
  publicSubnetIds: pulumi.Input<pulumi.Input<string>[]>;
  dataSubnetIds: pulumi.Input<pulumi.Input<string>[]>;
  applicationSecurityGroupId: pulumi.Input<string>;
  databaseHost: pulumi.Input<string>;
  databaseName: pulumi.Input<string>;
  databaseUser: pulumi.Input<string>;
  databasePasswordSecretArn: pulumi.Input<string>;
  cacheHost: pulumi.Input<string>;
  cacheTokenSecretArn: pulumi.Input<string>;
  adminEmail: string;
  adminPassword: pulumi.Input<string>;
  allowedCidrs: string[];
  region: string;
  labMode: boolean;
}

export class Storefront extends pulumi.ComponentResource {
  readonly url: pulumi.Output<string>;
  readonly clusterName: pulumi.Output<string>;
  readonly serviceName: pulumi.Output<string>;

  constructor(name: string, args: StorefrontArgs, opts?: pulumi.ComponentResourceOptions) {
    super("prestashop:compute:Storefront", name, {}, opts);
    const child = { parent: this };
    const image = new ContainerImage(`${name}-image`, args.labMode, child);
    const lbGroup = new aws.ec2.SecurityGroup(`${name}-lb-access`, {
      vpcId: args.vpcId, ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: args.allowedCidrs }],
      egress: [{ protocol: "tcp", fromPort: 80, toPort: 80, securityGroups: [args.applicationSecurityGroupId] }],
    }, child);
    const taskIngress = new aws.ec2.SecurityGroupRule(`${name}-http`, {
      type: "ingress", protocol: "tcp", fromPort: 80, toPort: 80,
      securityGroupId: args.applicationSecurityGroupId, sourceSecurityGroupId: lbGroup.id,
    }, child);
    const loadBalancer = new aws.lb.LoadBalancer(name, {
      loadBalancerType: "application", internal: false,
      subnets: args.publicSubnetIds, securityGroups: [lbGroup.id],
      enableDeletionProtection: !args.labMode,
    }, child);
    const target = new aws.lb.TargetGroup(name, {
      vpcId: args.vpcId, port: 80, protocol: "HTTP", targetType: "ip",
      healthCheck: { path: "/health.php", matcher: "200", interval: 60, timeout: 10 },
      deregistrationDelay: 30,
    }, child);
    const listener = new aws.lb.Listener(name, {
      loadBalancerArn: loadBalancer.arn, port: 80, protocol: "HTTP",
      defaultActions: [{ type: "forward", targetGroupArn: target.arn }],
    }, child);
    const fileGroup = new aws.ec2.SecurityGroup(`${name}-files-access`, {
      vpcId: args.vpcId, ingress: [{ protocol: "tcp", fromPort: 2049, toPort: 2049,
        securityGroups: [args.applicationSecurityGroupId] }], egress: [],
    }, child);
    const filesystem = new aws.efs.FileSystem(name, {
      encrypted: true, performanceMode: "generalPurpose",
    }, child);
    const access = new aws.efs.AccessPoint(name, {
      fileSystemId: filesystem.id,
      // Official image initializes ownership as root before Apache serves as www-data.
      posixUser: { uid: 0, gid: 0 },
      rootDirectory: { path: "/prestashop", creationInfo: { ownerUid: 33, ownerGid: 33, permissions: "0775" } },
    }, child);
    const mounts = [0, 1].map(index => new aws.efs.MountTarget(`${name}-files-${index}`, {
      fileSystemId: filesystem.id,
      subnetId: pulumi.output(args.dataSubnetIds).apply(ids => ids[index]),
      securityGroups: [fileGroup.id],
    }, child));
    const assumeRolePolicy = aws.iam.assumeRolePolicyForPrincipal({ Service: "ecs-tasks.amazonaws.com" });
    const execution = new aws.iam.Role(`${name}-execution`, { assumeRolePolicy }, child);
    const executionBase = new aws.iam.RolePolicyAttachment(`${name}-execution`, {
      role: execution.name, policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
    }, child);
    const adminSecret = new aws.secretsmanager.Secret(`${name}-admin`, {
      recoveryWindowInDays: args.labMode ? 0 : 7,
    }, child);
    const adminVersion = new aws.secretsmanager.SecretVersion(`${name}-admin`, {
      secretId: adminSecret.id, secretString: pulumi.secret(args.adminPassword),
    }, child);
    const secretArns = pulumi.all([args.databasePasswordSecretArn, args.cacheTokenSecretArn, adminSecret.arn]);
    const secretPolicy = new aws.iam.RolePolicy(`${name}-secrets`, {
      role: execution.id, policy: secretArns.apply(Resource => JSON.stringify({ Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource }] })),
    }, child);
    const taskRole = new aws.iam.Role(`${name}-task`, { assumeRolePolicy }, child);
    const filesPolicy = new aws.iam.RolePolicy(`${name}-files`, {
      role: taskRole.id, policy: pulumi.all([filesystem.arn, access.arn]).apply(([fs, ap]) => JSON.stringify({
        Version: "2012-10-17", Statement: [{ Effect: "Allow",
          Action: ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite", "elasticfilesystem:ClientRootAccess"],
          Resource: fs, Condition: { StringEquals: { "elasticfilesystem:AccessPointArn": ap },
            Bool: { "aws:SecureTransport": "true" } } }],
      })),
    }, child);
    const logs = new aws.cloudwatch.LogGroup(name, { retentionInDays: 7 }, child);
    const cluster = new aws.ecs.Cluster(name, {}, child);
    const containers = pulumi.all({ image: image.digest, host: loadBalancer.dnsName,
      dbHost: args.databaseHost, dbName: args.databaseName, dbUser: args.databaseUser,
      redisHost: args.cacheHost, secrets: secretArns, logGroup: logs.name,
    }).apply(values => JSON.stringify([{
      name: "prestashop", image: values.image, essential: true,
      portMappings: [{ containerPort: 80, protocol: "tcp" }],
      environment: Object.entries({ DB_SERVER: values.dbHost, DB_NAME: values.dbName,
        DB_USER: values.dbUser, DB_PORT: "3306", PS_DOMAIN: values.host, PS_INSTALL_AUTO: "1",
        PS_ERASE_DB: "0", PS_INSTALL_DB: "0", PS_DEV_MODE: "0", PS_ENABLE_SSL: "0",
        PS_FOLDER_ADMIN: "backoffice", ADMIN_MAIL: args.adminEmail,
        REDIS_HOST: values.redisHost, REDIS_PREFIX: `${name}:`,
      }).map(([name, value]) => ({ name, value })),
      secrets: ["DB_PASSWD", "REDIS_AUTH", "ADMIN_PASSWD"].map((name, index) => ({ name, valueFrom: values.secrets[index] })),
      mountPoints: [{ sourceVolume: "shop", containerPath: "/var/www/html", readOnly: false }],
      logConfiguration: { logDriver: "awslogs", options: {
        "awslogs-group": values.logGroup, "awslogs-region": args.region, "awslogs-stream-prefix": "prestashop",
      } },
    }]));
    const task = new aws.ecs.TaskDefinition(name, {
      family: name, cpu: "512", memory: "1024", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"],
      executionRoleArn: execution.arn, taskRoleArn: taskRole.arn, containerDefinitions: containers,
      volumes: [{ name: "shop", efsVolumeConfiguration: { fileSystemId: filesystem.id,
        transitEncryption: "ENABLED", authorizationConfig: { accessPointId: access.id, iam: "ENABLED" } } }],
    }, child);
    const service = new aws.ecs.Service(name, {
      cluster: cluster.arn, taskDefinition: task.arn, launchType: "FARGATE", platformVersion: "1.4.0",
      desiredCount: 1, deploymentMaximumPercent: 100, deploymentMinimumHealthyPercent: 0,
      deploymentCircuitBreaker: { enable: true, rollback: true }, healthCheckGracePeriodSeconds: 1800,
      networkConfiguration: { subnets: args.publicSubnetIds, assignPublicIp: true,
        securityGroups: [args.applicationSecurityGroupId] },
      loadBalancers: [{ targetGroupArn: target.arn, containerName: "prestashop", containerPort: 80 }],
    }, { ...child, dependsOn: [
      ...mounts, listener, taskIngress, executionBase, secretPolicy, filesPolicy, adminVersion,
    ] });
    this.url = pulumi.interpolate`http://${loadBalancer.dnsName}`;
    this.clusterName = cluster.name;
    this.serviceName = service.name;
    this.registerOutputs({ url: this.url, clusterName: this.clusterName, serviceName: this.serviceName });
  }
}
