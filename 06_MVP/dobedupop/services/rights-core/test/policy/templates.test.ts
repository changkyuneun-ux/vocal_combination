import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb, setSodRules } from "../helpers.ts";
import { DECLARED, PACK, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { createUser, loadActor } from "../../src/platform/actor.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { approveTemplate, draftTemplate, getTemplate, listTemplates, templateText } from "../../src/policy/templates.ts";
import { signersOf } from "../../src/engine-bridge/attest.ts";

// 표준 분배 규칙 템플릿(테넌트 정책 결정 TD13): 1인 테넌트는 법무 승인 템플릿을 값 그대로 쓴 정책만 혼자 편집·승인·활성화한다.
const { db, adminUrl, drop } = await freshDb();
await setSodRules(adminUrl, ["policy.edit-approve-activate", "policy-template.author-approve"]); // 이 파일은 직무 분리 거부를 확인한다(규칙 기본 꺼짐, 결정 RD6)
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const ALL = ["EDITOR", "WORK_APPROVER", "ACTIVATOR"] as const;
const { indie, label, legal, legal2 } = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova pack", factsScopeId: "fsc_nova" });
  await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_indie', 'INDEPENDENT_ARTIST', 'indie', $1), ('tnt_lbl', 'LABEL', 'label', $1)", [T0]);
  await createUser(tx, clock, { userId: "usr_indie", displayName: "indie", roles: [...ALL], tenantId: "tnt_indie" });
  await createUser(tx, clock, { userId: "usr_lbl_all", displayName: "label all roles", roles: [...ALL], tenantId: "tnt_lbl" });
  await createUser(tx, clock, { userId: "usr_legal_a", displayName: "legal a", roles: ["LEGAL"] });
  await createUser(tx, clock, { userId: "usr_legal_b", displayName: "legal b", roles: ["LEGAL"] });
  return { indie: await loadActor(tx, "usr_indie"), label: await loadActor(tx, "usr_lbl_all"), legal: await loadActor(tx, "usr_legal_a"), legal2: await loadActor(tx, "usr_legal_b") };
});

test("seeded templates are approved legal drafts; new templates need a second lawyer and name no party", async () => {
  const seeded = await db.tx((tx) => listTemplates(tx, { status: "APPROVED" }));
  assert.deepEqual(seeded.map((t) => t.templateId), ["ptpl_indie_simple", "ptpl_indie_standard"]);
  assert.ok(seeded.every((t) => t.seeded && t.explanation.length > 0));
  const form = { ...seeded[1]!.form };
  await assert.rejects(db.tx((tx) => draftTemplate(tx, clock, legal, { templateId: "ptpl_x", title: "x", description: "x", form: { ...form, contracts: [{ name: "agency", partyId: "pty_agency", bps: 1000, role: "AGENCY" }] } })), { code: "TEMPLATE_HAS_PARTY" });
  const d = await db.tx((tx) => draftTemplate(tx, clock, legal, { templateId: "ptpl_custom", title: "사용자 정의", description: "시험", form }));
  assert.equal(d.status, "DRAFT");
  await assert.rejects(db.tx((tx) => approveTemplate(tx, clock, legal, "ptpl_custom", 1)), { code: "SOD_VIOLATION" });
  assert.equal((await db.tx((tx) => approveTemplate(tx, clock, legal2, "ptpl_custom", 1))).approvedBy, "usr_legal_b");
});

test("with policy-template.author-approve disabled the author may approve their own template (MVP 총괄 운영, 결정 RD6)", async () => {
  await setSodRules(adminUrl, ["policy-template.author-approve"], false);
  try {
    const form = { ...(await db.tx((tx) => getTemplate(tx, "ptpl_indie_standard"))).form };
    await db.tx((tx) => draftTemplate(tx, clock, legal, { templateId: "ptpl_self", title: "본인 승인", description: "시험", form }));
    assert.equal((await db.tx((tx) => approveTemplate(tx, clock, legal, "ptpl_self", 1))).approvedBy, "usr_legal_a");
  } finally {
    await setSodRules(adminUrl, ["policy-template.author-approve"], true);
  }
});

test("a one-person tenant edits, approves and activates a template policy alone; the exemption is audited", async () => {
  const r = await db.tx((tx) => policy.compileFromTemplate(ctx, tx, clock, indie, { policyId: "pol_indie", packId: PACK, templateId: "ptpl_indie_standard" }));
  assert.deepEqual([r.templateId, r.templateVersion], ["ptpl_indie_standard", 1]);
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, indie, r));
  const act = await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, indie, r)).then(() => "ACTIVE", (e) => e.code as string);
  assert.notEqual(act, "SOD_VIOLATION", "activation is not blocked by separation of duties (other checks may still apply)");
  const roles = (await db.tx((tx) => signersOf(tx, r.policyDigest))).filter((s) => s.signerId === "usr_indie").map((s) => s.role);
  assert.ok(roles.includes("EDITOR") && roles.includes("WORK_APPROVER"));
  const audit = (await db.pool.query("SELECT after_json FROM audit_log WHERE action_name = 'SOD_TEMPLATE_EXEMPTION' AND entity_id = $1 ORDER BY audit_id", [`pol_indie@${r.version}`])).rows;
  assert.ok(audit.length >= 1);
  assert.equal(audit[0].after_json.template, "ptpl_indie_standard@1");
});

test("changing the template values, or a multi-person tenant, keeps separation of duties", async () => {
  const t = await db.tx((tx) => getTemplate(tx, "ptpl_indie_standard"));
  const changed = templateText(t, PACK, "pol_changed").replace("work = graph(WORK_AUTHOR) via mandate : 15%", "work = graph(WORK_AUTHOR) via mandate : 14%").replace("master = graph(MASTER_OWNER) : 40%", "master = graph(MASTER_OWNER) : 41%");
  const c = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, indie, { policyId: "pol_changed", packId: PACK, sourceText: changed }));
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, indie, c)), { code: "SOD_VIOLATION" });
  const l = await db.tx((tx) => policy.compileFromTemplate(ctx, tx, clock, label, { policyId: "pol_label_tpl", packId: PACK, templateId: "ptpl_indie_standard" }));
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, label, l)), { code: "SOD_VIOLATION" }, "a label has several people: templates do not lift the rule");
});
