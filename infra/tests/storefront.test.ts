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
  // Keep persistent shop files on the original encrypted, IAM-authorized EFS root.
  assert.deepEqual(container.mountPoints, [
    { sourceVolume: "shop", containerPath: "/var/www/html", readOnly: false },
    { sourceVolume: "symfony-cache", containerPath: "/var/www/html/var/cache", readOnly: false },
  ]);
  const filesystem = resources.find(r => r.type === "aws:efs/fileSystem:FileSystem")!;
  const access = resources.find(r => r.type === "aws:efs/accessPoint:AccessPoint")!;
  assert.deepEqual(task.inputs.volumes, [
    { name: "shop", efsVolumeConfiguration: {
      fileSystemId: filesystem.name + "-id", transitEncryption: "ENABLED",
      authorizationConfig: { accessPointId: access.name + "-id", iam: "ENABLED" },
    } },
    { name: "symfony-cache" },
  ]);
  assert.deepEqual(access.inputs.posixUser, { uid: 0, gid: 0 });
  assert.deepEqual(access.inputs.rootDirectory, {
    path: "/prestashop", creationInfo: { ownerUid: 33, ownerGid: 33, permissions: "0775" },
  });
  assert.equal(filesystem.inputs.encrypted, true);
  // Storage isolation must not change installation, health, secrets or capacity.
  assert.deepEqual(Object.fromEntries(container.environment.map((e: { name: string; value: string }) => [e.name, e.value])), {
    DB_SERVER: "mysql.internal", DB_NAME: "prestashop", DB_USER: "prestashop_admin", DB_PORT: "3306",
    PS_DOMAIN: "shop.example.test", PS_INSTALL_AUTO: "1", PS_ERASE_DB: "0", PS_INSTALL_DB: "0",
    PS_DEV_MODE: "0", PS_ENABLE_SSL: "0", PS_FOLDER_ADMIN: "backoffice", ADMIN_MAIL: "admin@example.test",
    REDIS_HOST: "redis.internal", REDIS_PREFIX: "shop:",
  });
  assert.deepEqual(container.secrets.map((s: { valueFrom: string }) => s.valueFrom), [
    "arn:aws:secretsmanager:db", "arn:aws:secretsmanager:redis", "arn:aws:mock:shop-admin",
  ]);
  assert.equal(task.inputs.cpu, "512");
  assert.equal(task.inputs.memory, "1024");
  assert.equal(task.inputs.ephemeralStorage, undefined);
  assert.equal(service.inputs.healthCheckGracePeriodSeconds, 1800);
  assert.deepEqual(service.inputs.deploymentCircuitBreaker, { enable: true, rollback: true });
  const target = resources.find(r => r.type === "aws:lb/targetGroup:TargetGroup")!;
  assert.deepEqual(target.inputs.healthCheck, { path: "/health.php", matcher: "200", interval: 60, timeout: 10 });
  const ingress = resources.find(r => r.type === "aws:ec2/securityGroupRule:SecurityGroupRule")!;
  assert.equal(ingress.inputs.fromPort, 80);
  assert.equal(ingress.inputs.securityGroupId, "sg-app");
  assert.ok(ingress.inputs.sourceSecurityGroupId);
  const lb = resources.find(r => r.type === "aws:ec2/securityGroup:SecurityGroup" && r.name.endsWith("-lb-access"))!;
  assert.deepEqual(lb.inputs.ingress[0].cidrBlocks, ["203.0.113.4/32"]);
});
