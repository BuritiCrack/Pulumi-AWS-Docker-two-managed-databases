import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as pulumi from "@pulumi/pulumi";
const resources: pulumi.runtime.MockResourceArgs[] = [];
pulumi.runtime.setMocks({
  newResource: args => { resources.push(args); return { id: args.name + "-id", state: args.inputs }; },
  call: args => args.inputs,
}, "prestashop", "test", false);
test("Network isolates data subnets and exposes typed outputs", async () => {
  const { Network } = await import("../components/network");
  await pulumi.runtime.runInPulumiStack(async () => {
    const network = new Network("test", { availabilityZones: ["us-east-1a", "us-east-1b"] });
    const ids = await new Promise<string[]>(resolve => network.dataSubnetIds.apply(resolve));
    assert.equal(ids.length, 2);
    await new Promise(resolve => network.publicSubnetIds.apply(resolve));
  });
  const subnets = resources.filter(r => r.type === "aws:ec2/subnet:Subnet");
  assert.equal(subnets.length, 4);
  assert.equal(subnets.filter(r => r.inputs.mapPublicIpOnLaunch === true).length, 2);
  assert.equal(subnets.filter(r => r.inputs.mapPublicIpOnLaunch === false).length, 2);
  const routes = resources.filter(r => r.type === "aws:ec2/route:Route");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].inputs.destinationCidrBlock, "0.0.0.0/0");
  assert.equal(resources.filter(r => r.type === "aws:ec2/natGateway:NatGateway").length, 0);
});
