import { test } from "node:test";
import assert from "node:assert/strict";
import { devModeFromEnv } from "../../src/dev/env.ts";

const ok = { RC_DEV: "1", DATABASE_URL: "postgres://rc_app:rc_app@localhost:54329/rights_core_dev", RC_ADMIN_URL: "postgres://rc:rc@localhost:54329/rights_core_dev" };

test("RC_DEV unset is false", () => {
  assert.equal(devModeFromEnv({}), false);
  assert.equal(devModeFromEnv({ RC_DEV: "0", DATABASE_URL: "postgres://x/rights_core" }), false);
});
test("RC_DEV=1 with the production database name is refused", () => {
  assert.throws(() => devModeFromEnv({ ...ok, DATABASE_URL: "postgres://rc_app:rc_app@localhost:54329/rights_core" }), /DEV_ONLY/);
});
test("RC_ADMIN_URL on a different host, port or database than DATABASE_URL is refused", () => {
  assert.throws(() => devModeFromEnv({ ...ok, RC_ADMIN_URL: "postgres://rc:rc@db.example.com:54329/rights_core_dev" }), /DEV_ONLY/);
  assert.throws(() => devModeFromEnv({ ...ok, RC_ADMIN_URL: "postgres://rc:rc@localhost:5432/rights_core_dev" }), /DEV_ONLY/);
  assert.throws(() => devModeFromEnv({ ...ok, RC_ADMIN_URL: "postgres://rc:rc@localhost:54329/postgres" }), /DEV_ONLY/);
});
test("RC_PSP other than fake is refused", () => {
  assert.throws(() => devModeFromEnv({ ...ok, RC_PSP: "stripe" }), /DEV_ONLY/);
});
test("missing RC_ADMIN_URL or DATABASE_URL is refused", () => {
  const { RC_ADMIN_URL: _a, ...noAdmin } = ok;
  assert.throws(() => devModeFromEnv(noAdmin), /DEV_ONLY/);
  const { DATABASE_URL: _d, ...noDb } = ok;
  assert.throws(() => devModeFromEnv(noDb), /DEV_ONLY/);
});
test("valid dev environment is true", () => {
  assert.equal(devModeFromEnv(ok), true);
  assert.equal(devModeFromEnv({ ...ok, RC_PSP: "fake" }), true);
  assert.equal(devModeFromEnv({ ...ok, RC_PSP: "" }), true);
});
