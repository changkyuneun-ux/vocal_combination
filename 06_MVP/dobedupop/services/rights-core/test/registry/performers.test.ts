import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { freshDb } from "../helpers.ts";
import { SCOPE, T0, seedSong } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { createUser } from "../../src/platform/actor.ts";
import { tenantPerformers } from "../../src/registry/performers.ts";

// 실연자 · 본인 관리(PT2·PT5): 이 테넌트 곡에 오른 실연자만, 공유 규칙의 값만(지급 정보·계좌·세금·연락처 없음).
const { db, adminUrl, drop } = await freshDb();
after(drop);
await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  await createUser(tx, fixedClock(T0, 0), { userId: "usr_perf_ops", displayName: "ops", roles: ["SPACE_SETTLE"] });
  for (const t of ["tnt_perf_x", "tnt_perf_y"]) await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ($1, 'LABEL', $2, $3)", [t, t, T0]);
});
const admin = async (sql: string, p: unknown[]) => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql, p); } finally { await c.end(); }
};
// 곡 fsc_nova는 tnt_perf_x의 곡. 멤버 a에게는 지급 정보·연락처가 있다(실연자 구역에 나오면 안 된다).
await admin("UPDATE facts_scope SET owner_tenant_id = 'tnt_perf_x' WHERE facts_scope_id = $1", [SCOPE]);
await admin("SET session_replication_role = replica; UPDATE party SET contact_email = 'member-a@example.com' WHERE party_id = 'pty_member_a'", []); // 관리 주체 트리거를 건너뛰어 시험 값만 넣는다
await admin("INSERT INTO party_payout_profile (party_id, tax_type, payout_account_ref, kyc_verified, first_payable_at, updated_at, account_changed_at, account_changed_by) VALUES ('pty_member_a', 'DOMESTIC_INDIVIDUAL', 'tok_secret_1234', true, $1, $1, $1, 'usr_perf_ops')", [T0]);
const now = "2026-02-01T00:00:00.000Z";

test("a rights tenant sees the performers named on its songs (voice owners, original part holders)", async () => {
  const rows = await db.tx((tx) => tenantPerformers(tx, "tnt_perf_x", now));
  assert.deepEqual(rows.map((r) => [r.partyId, r.kind, r.songs.map((s) => s.title)]), [["pty_member_a", "멤버", ["Nova"]], ["pty_member_b", "멤버", ["Nova"]]]);
  for (const r of rows) assert.ok(typeof r.status.label === "string" && r.status.label !== "" && typeof r.receiver === "string" && r.receiver !== "");
});

test("another tenant does not see performers of a song it does not own", async () => {
  assert.deepEqual(await db.tx((tx) => tenantPerformers(tx, "tnt_perf_y", now)), []);
});

test("no payout profile, account, tax or contact fields leave the performer list", async () => {
  const rows = await db.tx((tx) => tenantPerformers(tx, "tnt_perf_x", now));
  assert.deepEqual(Object.keys(rows[0]!).sort(), ["displayName", "kind", "partyId", "partyType", "receiver", "songs", "status"]);
  const text = JSON.stringify(rows);
  for (const leak of ["tok_secret_1234", "DOMESTIC_INDIVIDUAL", "member-a@example.com", "payout", "tax", "account", "contact"]) assert.ok(!text.includes(leak), `leaked ${leak}`);
});
