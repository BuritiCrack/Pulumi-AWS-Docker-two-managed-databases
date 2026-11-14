import * as pulumi from "@pulumi/pulumi";
import { isIP } from "node:net";

interface Settings { adminEmail: string; allowedCidrs: string[]; }
export function validateSettings(settings: Settings): Settings {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.adminEmail)) {
    throw new Error("A valid administrator email is required");
  }
  if (!Array.isArray(settings.allowedCidrs) || settings.allowedCidrs.length === 0) {
    throw new Error("allowedCidrs must restrict access to your client IPv4 CIDRs");
  }
  for (const cidr of settings.allowedCidrs) {
    if (typeof cidr !== "string") throw new Error("Invalid IPv4 CIDR");
    const parts = cidr.split("/");
    if (parts.length !== 2 || isIP(parts[0]) !== 4 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1])) {
      throw new Error("Invalid IPv4 CIDR");
    }
    if (parts[1] === "0") throw new Error("Unrestricted public access is not supported");
  }
  return settings;
}
export function validateDatabasePassword(password: string): string {
  if (!/^[A-Za-z0-9!#$%^&*_-]{16,41}$/.test(password)) {
    throw new Error("Database password requires 16-41 letters, digits or !#$%^&*_-");
  }
  return password;
}
export function validateRedisToken(token: string): string {
  if (!/^[A-Za-z0-9!&#$^<>-]{16,128}$/.test(token)) {
    throw new Error("Redis token requires 16-128 letters, digits or !&#$^<>-");
  }
  return token;
}
export function loadSettings() {
  const config = new pulumi.Config();
  const settings = validateSettings({ adminEmail: config.require("adminEmail"),
    allowedCidrs: config.requireObject<string[]>("allowedCidrs") });
  return { ...settings, labMode: config.getBoolean("labMode") ?? true,
    dbPassword: config.requireSecret("dbPassword").apply(validateDatabasePassword),
    redisToken: config.requireSecret("redisToken").apply(validateRedisToken),
    adminPassword: config.requireSecret("adminPassword").apply(value => {
      if (value.length < 12) throw new Error("Administrator password must have at least 12 characters");
      return value;
    }),
  };
}
