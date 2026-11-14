import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as pulumi from "@pulumi/pulumi";
const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource: args => { resources.push(args); return { id: args.name + "-id", state: {
    ...args.inputs, arn: "arn:aws:mock:" + args.name, name: args.name,
    dnsName: "shop.example.test", repositoryUrl: "123.dkr.ecr.us-east-1.amazonaws.com/shop",
    imageName: "shop@sha256:test", repoDigest: "shop@sha256:test",
  } }; },
  call: args => args.token.includes("getAuthorizationToken")
    ? { authorizationToken: "QVdTOnRlc3Q=", proxyEndpoint: "https://123.dkr.ecr.us-east-1.amazonaws.com", userName: "AWS", password: "test" }
    : args.inputs,
}, "prestashop", "test", false);
test("Storefront restricts ingress, injects secrets, persists files and avoids concurrent installers", async () => {
  const { Storefront } = await import("../components/storefront");
  const shop = new Storefront("shop", {
    vpcId: "vpc-test", publicSubnetIds: ["public-a", "public-b"],
    dataSubnetIds: ["data-a", "data-b"], applicationSecurityGroupId: "sg-app",
    databaseHost: "mysql.internal", databaseName: "prestashop", databaseUser: "prestashop_admin",
    databasePasswordSecretArn: "arn:aws:secretsmanager:db", cacheHost: "redis.internal",
    cacheTokenSecretArn: "arn:aws:secretsmanager:redis", adminEmail: "admin@example.test",
    adminPassword: pulumi.secret("AdminPassword123!"), allowedCidrs: ["203.0.113.4/32"],
    region: "us-east-1", labMode: true,
  });
  await new Promise(resolve => shop.serviceName.apply(resolve));
  const service = resources.find(r => r.type === "aws:ecs/service:Service")!;
  assert.equal(service.inputs.desiredCount, 1);
  assert.equal(service.inputs.deploymentMaximumPercent, 100);
  assert.equal(service.inputs.deploymentMinimumHealthyPercent, 0);
  assert.equal(service.inputs.networkConfiguration.assignPublicIp, true);
  const task = resources.find(r => r.type === "aws:ecs/taskDefinition:TaskDefinition")!;
  const container = JSON.parse(task.inputs.containerDefinitions)[0];
  assert.deepEqual(container.secrets.map((s: { name: string }) => s.name).sort(), ["ADMIN_PASSWD", "DB_PASSWD", "REDIS_AUTH"]);
  assert.equal(container.environment.some((e: { name: string }) => /PASSWD|AUTH/.test(e.name)), false);
  assert.equal(container.mountPoints[0].containerPath, "/var/www/html");
  assert.equal(task.inputs.volumes[0].efsVolumeConfiguration.transitEncryption, "ENABLED");
  const ingress = resources.find(r => r.type === "aws:ec2/securityGroupRule:SecurityGroupRule")!;
  assert.equal(ingress.inputs.fromPort, 80);
  assert.equal(ingress.inputs.securityGroupId, "sg-app");
  assert.ok(ingress.inputs.sourceSecurityGroupId);
  const lb = resources.find(r => r.type === "aws:ec2/securityGroup:SecurityGroup" && r.name.endsWith("-lb-access"))!;
  assert.deepEqual(lb.inputs.ingress[0].cidrBlocks, ["203.0.113.4/32"]);
});
