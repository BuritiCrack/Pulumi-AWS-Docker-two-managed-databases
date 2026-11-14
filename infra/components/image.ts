import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import * as path from "node:path";

export class ContainerImage extends pulumi.ComponentResource {
  readonly digest: pulumi.Output<string>;
  constructor(name: string, labMode: boolean, opts?: pulumi.ComponentResourceOptions) {
    super("prestashop:compute:ContainerImage", name, {}, opts);
    const child = { parent: this };
    const repository = new aws.ecr.Repository(name, {
      forceDelete: labMode, imageScanningConfiguration: { scanOnPush: true },
    }, child);
    const image = new docker.Image(name, {
      imageName: pulumi.interpolate`${repository.repositoryUrl}:prestashop-8.2.1`,
      build: { context: path.resolve(__dirname, "../../docker/prestashop"), platform: "linux/amd64" },
    }, child);
    this.digest = image.repoDigest;
    this.registerOutputs({ digest: this.digest });
  }
}
