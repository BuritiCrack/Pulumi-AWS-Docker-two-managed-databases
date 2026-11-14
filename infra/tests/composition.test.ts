import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as pulumi from "@pulumi/pulumi";
const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource: args => { resources.push(args); return { id: args.name + "-id", state: {
    ...args.inputs, arn: "arn:aws:mock:" + args.name, name: args.name,
    address: "mysql.internal", primaryEndpointAddress: "redis.internal",
    dnsName: "shop.example.test", repositoryUrl: "123.dkr.ecr.us-east-1.amazonaws.com/shop",
    registryId: "123", repoDigest: "shop@sha256:test",
  } }; },
  call: args => args.token.includes("getAvailabilityZones") ? { names: ["us-east-1a", "us-east-1b"], zoneIds: ["use1-az1", "use1-az2"] }
    : args.token.includes("getAuthorizationToken") ? { userName: "AWS", password: "test", proxyEndpoint: "https://123.dkr.ecr.us-east-1.amazonaws.com" }
    : args.inputs,
}, "prestashop", "test", false);
pulumi.runtime.setAllConfig({
  "aws:region": "us-east-1", "prestashop:adminEmail": "admin@example.test",
  "prestashop:allowedCidrs": '["203.0.113.4/32"]',
  "prestashop:dbPassword": "MysqlPassword123!", "prestashop:redisToken": "RedisPassword123!",
  "prestashop:adminPassword": "AdminPassword123!",
}, ["prestashop:dbPassword", "prestashop:redisToken", "prestashop:adminPassword"]);
test("Entry point composes all blocks and exports only operational outputs", async () => {
  const entrypoint = (await import("../index")).default;
  const result = await entrypoint();
  assert.deepEqual(Object.keys(result).sort(), ["adminUrl", "clusterName", "serviceName", "url"]);
  assert.equal(await new Promise(resolve => result.url.apply(resolve)), "http://shop.example.test");
  await new Promise(resolve => result.serviceName.apply(resolve));
  for (const type of ["prestashop:network:Network", "prestashop:data:Database", "prestashop:data:Cache", "prestashop:compute:Storefront", "prestashop:compute:ContainerImage"]) {
    assert.equal(resources.filter(resource => resource.type === type).length, 1);
  }
  const task = resources.find(resource => resource.type === "aws:ecs/taskDefinition:TaskDefinition")!;
  const definition = JSON.parse(task.inputs.containerDefinitions)[0];
  assert.equal(definition.environment.find((item: { name: string }) => item.name === "DB_SERVER").value, "mysql.internal");
  assert.equal(definition.environment.find((item: { name: string }) => item.name === "REDIS_HOST").value, "redis.internal");
});
