import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as pulumi from "@pulumi/pulumi";
const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource: args => {
    resources.push(args);
    return { id: args.name + "-id", state: {
      ...args.inputs, arn: "arn:aws:mock:" + args.name,
      address: "mysql.internal", primaryEndpointAddress: "redis.internal",
    } };
  },
  call: args => args.inputs,
}, "prestashop", "test", false);
test("Managed data is private, encrypted and restricted to application tasks", async () => {
  const { Database } = await import("../components/database");
  const { Cache } = await import("../components/cache");
  await pulumi.runtime.runInPulumiStack(async () => {
    const shared = { vpcId: "vpc-test", subnetIds: ["data-a", "data-b"], applicationSecurityGroupId: "sg-app" };
    const db = new Database("mysql", { ...shared, password: pulumi.secret("TestPassword123456789!"), labMode: true });
    const cache = new Cache("redis", { ...shared, authToken: pulumi.secret("RedisPassword123456789!"), labMode: true });
    assert.equal(await pulumi.isSecret(db.passwordSecretArn), false);
    await new Promise(resolve => db.host.apply(resolve));
    await new Promise(resolve => cache.host.apply(resolve));
    await new Promise(resolve => db.passwordSecretArn.apply(resolve));
    await new Promise(resolve => cache.authTokenSecretArn.apply(resolve));
  });
  const db = resources.find(r => r.type === "aws:rds/instance:Instance")!;
  assert.equal(db.inputs.engine, "mysql");
  assert.equal(db.inputs.publiclyAccessible, false);
  assert.equal(db.inputs.storageEncrypted, true);
  assert.equal(db.inputs.skipFinalSnapshot, true);
  const redis = resources.find(r => r.type === "aws:elasticache/replicationGroup:ReplicationGroup")!;
  assert.equal(redis.inputs.engine, "redis");
  assert.equal(redis.inputs.transitEncryptionEnabled, true);
  assert.equal(redis.inputs.atRestEncryptionEnabled, true);
  assert.equal(redis.inputs.numCacheClusters, 1);
  const groups = resources.filter(r => r.type === "aws:ec2/securityGroup:SecurityGroup");
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.deepEqual(group.inputs.ingress[0].securityGroups, ["sg-app"]);
    assert.equal(group.inputs.ingress[0].cidrBlocks, undefined);
  }
  assert.equal(resources.filter(r => r.type === "aws:secretsmanager/secretVersion:SecretVersion").length, 2);
});
