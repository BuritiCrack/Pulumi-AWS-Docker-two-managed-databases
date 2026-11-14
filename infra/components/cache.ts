import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface CacheArgs {
  vpcId: pulumi.Input<string>;
  subnetIds: pulumi.Input<pulumi.Input<string>[]>;
  applicationSecurityGroupId: pulumi.Input<string>;
  authToken: pulumi.Input<string>;
  labMode: boolean;
}

export class Cache extends pulumi.ComponentResource {
  readonly host: pulumi.Output<string>;
  readonly port = pulumi.output(6379);
  readonly authTokenSecretArn: pulumi.Output<string>;

  constructor(name: string, args: CacheArgs, opts?: pulumi.ComponentResourceOptions) {
    super("prestashop:data:Cache", name, {}, opts);
    const child = { parent: this };
    const group = new aws.ec2.SecurityGroup(`${name}-access`, {
      vpcId: args.vpcId, description: "Redis TLS from PrestaShop tasks only",
      ingress: [{ protocol: "tcp", fromPort: 6379, toPort: 6379,
        securityGroups: [args.applicationSecurityGroupId] }], egress: [],
    }, child);
    const subnets = new aws.elasticache.SubnetGroup(`${name}-subnets`, { subnetIds: args.subnetIds }, child);
    const token = pulumi.secret(args.authToken);
    const secret = new aws.secretsmanager.Secret(`${name}-token`, {
      recoveryWindowInDays: args.labMode ? 0 : 7,
    }, child);
    const version = new aws.secretsmanager.SecretVersion(`${name}-token`, {
      secretId: secret.id, secretString: token,
    }, child);
    const cache = new aws.elasticache.ReplicationGroup(name, {
      description: "PrestaShop managed Redis OSS cache", engine: "redis", engineVersion: "7.1",
      nodeType: "cache.t3.micro", port: 6379, numCacheClusters: args.labMode ? 1 : 2,
      automaticFailoverEnabled: !args.labMode, multiAzEnabled: !args.labMode,
      subnetGroupName: subnets.name, securityGroupIds: [group.id],
      atRestEncryptionEnabled: true, transitEncryptionEnabled: true,
      transitEncryptionMode: "required", authToken: token,
      snapshotRetentionLimit: args.labMode ? 0 : 1,
    }, child);
    this.host = cache.primaryEndpointAddress;
    this.authTokenSecretArn = pulumi.all([secret.arn, version.id]).apply(([arn]) => arn);
    this.registerOutputs({ host: this.host, port: this.port,
      authTokenSecretArn: this.authTokenSecretArn });
  }
}
