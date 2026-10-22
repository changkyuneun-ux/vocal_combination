import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, setSodRules } from "../helpers.ts";
import { sodEnabled } from "../../src/platform/sod.ts";

// 직무 분리 규칙(총괄 운영과 권한 구조 RS3, 결정 RD6): 현 단계는 모두 꺼짐. 켜면 지금 검사가 그대로 돈다.
const { db, adminUrl, drop } = await freshDb();
after(drop);

const RULES = ["policy.edit-approve-activate", "settlement.run-confirm", "contract-template.author-approve", "policy-template.author-approve",
  "validation.request-approve", "link.propose-confirm", "payout.account-run"] as const;

test("all separation-of-duty rules start disabled", async () => {
  for (const r of RULES) assert.equal(await db.tx((tx) => sodEnabled(tx, r)), false, r);
  const rows = (await db.pool.query("SELECT rule_id FROM sod_rule ORDER BY rule_id COLLATE \"C\"")).rows.map((x) => x.rule_id);
  assert.deepEqual(rows, [...RULES, "integrity.investigate-judge", "monitor.observe-audit"].sort());
});

test("setSodRules turns rules on for tests that check the rejection", async () => {
  await setSodRules(adminUrl, ["settlement.run-confirm"]);
  assert.equal(await db.tx((tx) => sodEnabled(tx, "settlement.run-confirm")), true);
  assert.equal(await db.tx((tx) => sodEnabled(tx, "payout.account-run")), false);
  await setSodRules(adminUrl, "all", false);
});

test("the app role cannot change rules", async () => {
  await assert.rejects(db.pool.query("UPDATE sod_rule SET enabled = true"), /permission denied/);
});

test("same-person constraints that are separation of duty are gone from the schema; independent verification stays", async () => {
  const defs = (await db.pool.query(
    "SELECT conrelid::regclass::text AS t, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE contype = 'c' AND conrelid::regclass::text IN ('settlement_batch','contract_template','policy_template','validation_issue','settlement_run')",
  )).rows;
  const sod = defs.filter((r) => /confirmed_by.*<>.*executed_by|approved_by.*<>.*authored_by|accepted_by.*<>.*accept_requested_by/.test(r.d));
  assert.deepEqual(sod, []);
  assert.ok(defs.some((r) => r.t === "settlement_run" && /verified_by.*<>.*executed_by/.test(r.d)), "verifier ≠ executor stays");
});
