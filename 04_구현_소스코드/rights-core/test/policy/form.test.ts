import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { checkForm, explainForm, formToText, textToForm, type PolicyForm } from "../../src/engine-bridge/policy-form.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";
import { POLICY_TEXT } from "../fixtures.ts";

// 분배 규칙 폼(원천 문서 설계 S2): 폼 ↔ MDRL 텍스트, 쉬운 말 설명, 엔진 예시 계산(봉인 없음).
const w = await settlementWorld();
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-03-01T00:00:00.000Z", 1000), jobs: recordingJobs() });
after(async () => { await app.close(); await w.drop(); });
const json = async (url: string, status: number, payload: object, actor = "usr_editor"): Promise<any> => {
  const r = await app.inject({ method: "POST", url, headers: { "x-actor": actor }, payload });
  assert.equal(r.statusCode, status, `${url}: ${r.body}`);
  return r.json();
};

const EXPECTED: PolicyForm = {
  packId: "pak_nova", events: ["PRIMARY"],
  tier1: { platformBps: 2500, opsBps: 500, rightsBps: 7000 },
  master: { bps: 4000 },
  performer: { bps: 4000, mode: "HYBRID", fixedBps: 4000, usageBps: 6000, featuredWeightBps: 7000, capBps: 5000, viaMandate: false },
  work: { bps: 1000, viaMandate: true },
  contracts: [{ name: "agency", partyId: "pty_agency", bps: 1000, role: "AGENCY" }],
};

test("an existing MDRL policy reads back as a form, and the form writes the same policy", () => {
  const back = textToForm(POLICY_TEXT);
  assert.deepEqual(back.form, EXPECTED);
  const again = textToForm(formToText(EXPECTED, "pol_x"));
  assert.deepEqual(again.form, EXPECTED, "form → text → form is lossless");
});

test("form checks catch totals and missing choices before the engine", () => {
  assert.deepEqual(checkForm(EXPECTED), []);
  const bad = structuredClone(EXPECTED);
  bad.tier1.opsBps = 1000;
  bad.performer.usageBps = 5000;
  assert.deepEqual(checkForm(bad).map((d) => d.path), ["$.tier1", "$.performer"]);
  assert.match(checkForm(bad)[0]!.message, /105%/);
});

test("policies the form cannot express say why instead of guessing", () => {
  const mixed = POLICY_TEXT.replace("master = graph(MASTER_OWNER) : 40%;", "master = mix(50%: graph(MASTER_OWNER), 50%: contract(pty_label)) : 40% as MASTER_OWNER;");
  const r = textToForm(mixed);
  assert.equal(r.form, null);
  assert.match((r as { reason: string }).reason, /master/);
});

test("plain-language explanation", () => {
  const lines = explainForm(EXPECTED, { pty_agency: "소속사 A" });
  assert.ok(lines.includes("매출의 70%는 권리자 몫이고, 플랫폼 25%, 운영 5%이다."));
  assert.ok(lines.some((l) => l.includes("10%는 계약에 따라 소속사 A에게")));
  assert.ok(lines.some((l) => l.includes("한 사람은 실연 몫의 50%를 넘지 못하고")));
  assert.ok(lines.some((l) => l.includes("작품 몫은 작가가 위임한 곳")));
});

test("form → text via the API compiles as a real policy version", async () => {
  const { sourceText } = await json("/ops/policies/form/text", 200, { form: EXPECTED, policyId: "pol_form" });
  const v = await json("/ops/policies/pol_form/compile", 201, { packId: "pak_nova", sourceText });
  assert.equal(v.version, 1);
  assert.equal((await json("/ops/policies/form/text", 422, { form: { ...EXPECTED, master: { bps: 0 } } })).code, "FORM_INVALID");
});

test("example calculation without an issued combination uses a default arrangement and conserves the amount", async () => {
  const p = await json("/ops/policies/preview", 200, { packId: "pak_nova", form: EXPECTED, amountKrw: 10000 });
  assert.equal(p.combination.source, "DEFAULT");
  assert.deepEqual(p.diagnostics, []);
  const pools = Object.fromEntries(p.pools.map((x: any) => [x.bucket, x.amount]));
  assert.deepEqual(pools, { ops: "500", platform: "2500", rights: "7000" });
  const by = (party: string) => p.parties.filter((x: any) => x.partyId === party).reduce((a: number, x: any) => a + Number(x.amount), 0);
  assert.equal(by("pty_label"), 2800, "master 40% of 7,000");
  assert.equal(by("pty_agency"), 700, "contract 10% of 7,000");
  assert.equal(by("pty_cmo") + by("pty_author_c"), 700, "work 10%, author b's share goes to the CMO by mandate");
  assert.equal(p.parties.reduce((a: number, x: any) => a + Number(x.amount), 0) + p.holdings.reduce((a: number, x: any) => a + Number(x.amount), 0), 7000);
  assert.ok(p.explanation.length > 3);
});

test("with an issued combination the example follows its real arrangement; a broken form returns diagnostics, not an error", async () => {
  await issueCombo(w, "vc_form_1");
  const p = await json("/ops/policies/preview", 200, { packId: "pak_nova", sourceText: POLICY_TEXT, amountKrw: 3300 });
  assert.equal(p.combination.source, "ISSUED");
  assert.equal(p.combination.vcId, "vc_form_1");
  assert.deepEqual(p.form, EXPECTED);
  const broken = await json("/ops/policies/preview", 200, { packId: "pak_nova", form: { ...EXPECTED, tier1: { platformBps: 2500, opsBps: 500, rightsBps: 6000 } } });
  assert.equal(broken.diagnostics[0].code, "FORM_INVALID");
  assert.deepEqual(broken.parties, []);
  const unparsable = await json("/ops/policies/preview", 200, { packId: "pak_nova", sourceText: "allocation {" });
  assert.equal(unparsable.form, null);
  assert.ok(unparsable.diagnostics.length > 0);
});
