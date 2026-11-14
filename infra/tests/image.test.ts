import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
const resources: pulumi.runtime.MockResourceArgs[] = [];
const invokes: string[] = [];
pulumi.runtime.setMocks({
  newResource: args => {
    resources.push(args);
    return { id: args.name + "-id", state: { ...args.inputs,
      repositoryUrl: "000000000000.dkr.ecr.us-east-1.amazonaws.com/shop",
      registryId: "000000000000", repoDigest: "shop@sha256:test",
    } };
  },
  call: args => {
    invokes.push(args.token);
    return { ...args.inputs, proxyEndpoint: "https://example.test", userName: "AWS", password: "synthetic" };
  },
}, "prestashop", "test", false);

test("Image uses runtime Docker auth, preserving repository, qualified tag, build and digest", async () => {
  const { ContainerImage } = await import("../components/image");
  for (const labMode of [true, false]) {
    const name = labMode ? "shop-image" : "retained-image";
    const image = new ContainerImage(name, labMode);
    assert.equal(await new Promise(resolve => image.digest.apply(resolve)), "shop@sha256:test");
    const repository = resources.find(r => r.type === "aws:ecr/repository:Repository" && r.name === name)!;
    assert.equal(repository.inputs.forceDelete, labMode);
    assert.deepEqual(repository.inputs.imageScanningConfiguration, { scanOnPush: true });
    const built = resources.find(r => r.type === "docker:index/image:Image" && r.name === name)!;
    assert.equal(built.inputs.imageName, "000000000000.dkr.ecr.us-east-1.amazonaws.com/shop:prestashop-8.2.1");
    assert.deepEqual(built.inputs.build, {
      context: path.resolve(__dirname, "../../docker/prestashop"), platform: "linux/amd64",
    });
    assert.equal(Object.hasOwn(built.inputs, "registry"), false);
  }
  assert.deepEqual(invokes, [], "No token lookup may become a plan input");
});
