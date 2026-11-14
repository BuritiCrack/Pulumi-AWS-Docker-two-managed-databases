import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface NetworkArgs {
  availabilityZones: [string, string];
}

/** Two-AZ lab network: public compute, isolated managed data, no NAT charges. */
export class Network extends pulumi.ComponentResource {
  readonly vpcId: pulumi.Output<string>;
  readonly publicSubnetIds: pulumi.Output<string[]>;
  readonly dataSubnetIds: pulumi.Output<string[]>;
  readonly applicationSecurityGroupId: pulumi.Output<string>;

  constructor(name: string, args: NetworkArgs, opts?: pulumi.ComponentResourceOptions) {
    super("prestashop:network:Network", name, {}, opts);
    if (args.availabilityZones[0] === args.availabilityZones[1]) {
      throw new Error("Two distinct availability zones are required");
    }
    const child = { parent: this };
    const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
      cidrBlock: "10.42.0.0/16", enableDnsHostnames: true, enableDnsSupport: true,
    }, child);
    const gateway = new aws.ec2.InternetGateway(`${name}-igw`, { vpcId: vpc.id }, child);
    const publicRoutes = new aws.ec2.RouteTable(`${name}-public`, { vpcId: vpc.id }, child);
    const internetRoute = new aws.ec2.Route(`${name}-internet`, {
      routeTableId: publicRoutes.id, destinationCidrBlock: "0.0.0.0/0", gatewayId: gateway.id,
    }, child);
    const dataRoutes = new aws.ec2.RouteTable(`${name}-isolated`, { vpcId: vpc.id }, child);
    const publicSubnets: aws.ec2.Subnet[] = [];
    const dataSubnets: aws.ec2.Subnet[] = [];
    const publicAssociations: aws.ec2.RouteTableAssociation[] = [];
    args.availabilityZones.forEach((zone, index) => {
      const publicSubnet = new aws.ec2.Subnet(`${name}-public-${index}`, {
        vpcId: vpc.id, availabilityZone: zone,
        cidrBlock: `10.42.${index}.0/24`, mapPublicIpOnLaunch: true,
      }, child);
      const dataSubnet = new aws.ec2.Subnet(`${name}-data-${index}`, {
        vpcId: vpc.id, availabilityZone: zone,
        cidrBlock: `10.42.${index + 10}.0/24`, mapPublicIpOnLaunch: false,
      }, child);
      const publicAssociation = new aws.ec2.RouteTableAssociation(`${name}-public-${index}`, {
        subnetId: publicSubnet.id, routeTableId: publicRoutes.id,
      }, { ...child, dependsOn: internetRoute });
      new aws.ec2.RouteTableAssociation(`${name}-data-${index}`, {
        subnetId: dataSubnet.id, routeTableId: dataRoutes.id,
      }, child);
      publicAssociations.push(publicAssociation);
      publicSubnets.push(publicSubnet);
      dataSubnets.push(dataSubnet);
    });
    const application = new aws.ec2.SecurityGroup(`${name}-application`, {
      vpcId: vpc.id, description: "PrestaShop tasks; ingress is owned by Storefront",
      egress: [
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
        ...[3306, 6379, 2049].map(port => ({
          protocol: "tcp", fromPort: port, toPort: port,
          cidrBlocks: ["10.42.10.0/24", "10.42.11.0/24"],
        })),
      ],
    }, child);
    this.vpcId = vpc.id;
    this.publicSubnetIds = pulumi.all({
      ids: pulumi.all(publicSubnets.map(subnet => subnet.id)),
      ready: pulumi.all(publicAssociations.map(association => association.id)),
    }).apply(result => result.ids);
    this.dataSubnetIds = pulumi.all(dataSubnets.map(subnet => subnet.id));
    this.applicationSecurityGroupId = application.id;
    this.registerOutputs({
      vpcId: this.vpcId, publicSubnetIds: this.publicSubnetIds,
      dataSubnetIds: this.dataSubnetIds, applicationSecurityGroupId: this.applicationSecurityGroupId,
    });
  }
}
