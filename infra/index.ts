import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { loadSettings } from "./config";
import { Network } from "./components/network";
import { Database } from "./components/database";
import { Cache } from "./components/cache";
import { Storefront } from "./components/storefront";

export = async () => {
  const config = loadSettings();
  const region = aws.config.region;
  if (!region) throw new Error("Set aws:region before previewing");
  const provider = new aws.Provider("aws", { region, defaultTags: { tags: {
    Project: "prestashop", Stack: pulumi.getStack(), ManagedBy: "Pulumi",
  } } });
  const opts = { providers: [provider] };
  const zones = await aws.getAvailabilityZones({ state: "available" }, { provider });
  if (zones.names.length < 2) throw new Error("Two available availability zones are required");
  const network = new Network("shop-network", { availabilityZones: [zones.names[0], zones.names[1]] }, opts);
  const dataArgs = { vpcId: network.vpcId, subnetIds: network.dataSubnetIds,
    applicationSecurityGroupId: network.applicationSecurityGroupId, labMode: config.labMode };
  const database = new Database("shop-mysql", {
    ...dataArgs, password: config.dbPassword, identifier: `shop-mysql-${pulumi.getStack()}`,
  }, opts);
  const cache = new Cache("shop-redis", { ...dataArgs, authToken: config.redisToken }, opts);
  const shop = new Storefront("shop", {
    ...config, vpcId: network.vpcId, publicSubnetIds: network.publicSubnetIds,
    dataSubnetIds: network.dataSubnetIds, applicationSecurityGroupId: network.applicationSecurityGroupId,
    databaseHost: database.host, databaseName: database.databaseName, databaseUser: database.username,
    databasePasswordSecretArn: database.passwordSecretArn, cacheHost: cache.host,
    cacheTokenSecretArn: cache.authTokenSecretArn, region,
  }, opts);
  return { url: shop.url, adminUrl: pulumi.interpolate`${shop.url}/backoffice`,
    clusterName: shop.clusterName, serviceName: shop.serviceName };
};
