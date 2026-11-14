import { strict as assert } from "node:assert";
import { test } from "node:test";
test("Configuration rejects missing access restrictions and invalid credentials", async () => {
  const { validateSettings, validateDatabasePassword, validateRedisToken } = await import("../config");
  const valid = { adminEmail: "admin@example.test", allowedCidrs: ["203.0.113.4/32"] };
  assert.deepEqual(validateSettings(valid), valid);
  assert.throws(() => validateSettings({ ...valid, allowedCidrs: [] }), /allowedCidrs/);
  assert.throws(() => validateSettings({ ...valid, allowedCidrs: ["0.0.0.0/0"] }), /public/);
  assert.throws(() => validateSettings({ ...valid, allowedCidrs: ["999.0.0.0\/32"] }), /CIDR/);
  assert.throws(() => validateSettings({ ...valid, adminEmail: "invalid" }), /email/);
  assert.throws(() => validateDatabasePassword("short"), /password/);
  assert.throws(() => validateRedisToken("invalid/token/123456"), /token/);
  assert.equal(validateDatabasePassword("MysqlPassword123!"), "MysqlPassword123!");
  assert.equal(validateRedisToken("RedisPassword123!"), "RedisPassword123!");
});
