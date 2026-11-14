import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface DatabaseArgs {
  vpcId: pulumi.Input<string>;
  subnetIds: pulumi.Input<pulumi.Input<string>[]>;
  applicationSecurityGroupId: pulumi.Input<string>;
  password: pulumi.Input<string>;
  identifier?: pulumi.Input<string>;
  labMode: boolean;
}

export class Database extends pulumi.ComponentResource {
  readonly host: pulumi.Output<string>;
  readonly port: pulumi.Output<number>;
  readonly databaseName = "prestashop";
  readonly username = "prestashop_admin";
  readonly passwordSecretArn: pulumi.Output<string>;

  constructor(name: string, args: DatabaseArgs, opts?: pulumi.ComponentResourceOptions) {
    super("prestashop:data:Database", name, {}, opts);
    const child = { parent: this };
    const group = new aws.ec2.SecurityGroup(`${name}-access`, {
      vpcId: args.vpcId, description: "MySQL from PrestaShop tasks only",
      ingress: [{ protocol: "tcp", fromPort: 3306, toPort: 3306,
        securityGroups: [args.applicationSecurityGroupId] }], egress: [],
    }, child);
    const subnets = new aws.rds.SubnetGroup(`${name}-subnets`, { subnetIds: args.subnetIds }, child);
    const password = pulumi.secret(args.password);
    const secret = new aws.secretsmanager.Secret(`${name}-password`, {
      recoveryWindowInDays: args.labMode ? 0 : 7,
    }, child);
    const version = new aws.secretsmanager.SecretVersion(`${name}-password`, {
      secretId: secret.id, secretString: password,
    }, child);
    const database = new aws.rds.Instance(name, {
      identifier: args.identifier,
      engine: "mysql", engineVersion: "8.0", instanceClass: "db.t3.micro",
      allocatedStorage: 20, storageType: "gp3", storageEncrypted: true,
      dbName: this.databaseName, username: this.username, password,
      dbSubnetGroupName: subnets.name, vpcSecurityGroupIds: [group.id],
      publiclyAccessible: false, multiAz: !args.labMode,
      backupRetentionPeriod: args.labMode ? 0 : 7,
      deletionProtection: !args.labMode, skipFinalSnapshot: args.labMode,
      finalSnapshotIdentifier: args.labMode ? undefined : `${name}-final`,
    }, child);
    this.host = database.address;
    this.port = database.port;
    this.passwordSecretArn = pulumi.all([secret.arn, version.id]).apply(([arn]) => arn);
    this.registerOutputs({ host: this.host, port: this.port,
      databaseName: this.databaseName, username: this.username,
      passwordSecretArn: this.passwordSecretArn });
  }
}
