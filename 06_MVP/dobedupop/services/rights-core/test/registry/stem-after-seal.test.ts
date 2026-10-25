import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsAudioStore, localAnalyzer } from "../../src/audio/deps.ts";
import { audioJobHandlers } from "../../src/audio/handlers.ts";
import { sealFacts } from "../../src/engine-bridge/facts.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import * as policy from "../../src/policy/service.ts";
import { SCOPE } from "../fixtures.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { gen } from "../../../audio-service/test/gen.ts";

// IR 생성 뒤 스템(시안 Song-Stems-Panel ④): 추가는 된다(다음 IR) · 기존 스템은 지우지 않고 '쓰지 않음'으로 새 발행에서 뺀다 ·
// 오디오 바꾸기는 새 버전으로 대기했다가 다음 재고정부터 쓴다. 어느 경우에도 이미 봉인된 facts digest와 발행된 조합은 그대로다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-stem-seal-"));
const audio = { store: createFsAudioStore(dir), analyzer: localAnalyzer };
const jobs = recordingJobs();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, audio });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, actor: string, payload?: object) =>
  app.inject({ method, url: `/ops${url}`, headers: { "x-actor": actor }, ...(payload === undefined ? {} : { payload }) });
const json = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, status: number, payload?: object, actor = "usr_rights") => {
  const r = await call(method, url, actor, payload);
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.body === "" ? {} : r.json();
};
const issue = (vcId: string, s1: string, s2: string, members: Record<string, number>) => app.inject({
  method: "POST", url: "/ops/issues", headers: { "x-actor": "usr_issuer" },
  payload: { packId: "pak_nova", vcId, members, assignments: [{ slotId: "slt_1", stemId: s1 }, { slotId: "slt_2", stemId: s2 }, { slotId: "slt_mr", stemId: "stm_mr" }] },
});
const q = async (sql: string, p: unknown[] = []) => (await w.db.pool.query(sql, p)).rows;
const active = async () => (await q("SELECT version, facts_digest, facts_known_at FROM policy_version WHERE policy_id = 'pol_nova' AND status = 'ACTIVE'"))[0];
const digestAt = async (knownAt: Date) => (await w.db.tx((tx) => sealFacts(w.ctx, tx, SCOPE, knownAt.toISOString()))).digest;
const drain = () => jobs.drain(audioJobHandlers({ db: w.db, clock, audio }));
const TONE = (hz: number) => gen(`sine=frequency=${hz}:duration=31:sample_rate=48000`, undefined, "volume=2");

let sealed: { version: number; facts_digest: string; facts_known_at: Date };
test("after the IR a new stem can be added (with its performer claim and a confirmation request); the sealed digest does not change", async () => {
  sealed = await active();
  const out = await json("POST", "/stems", 201, { stemId: "stm_b2_v2", slotId: "slt_2", partNo: 1, recordingId: "rcd_nova", performerPartyId: "pty_member_b", rightsBearing: true, withClaims: true });
  assert.ok(out);
  const claim = await q("SELECT status FROM right_claim WHERE source_id = 'stm_b2_v2' AND edge = 'PERFORMED_BY' AND superseded_at IS NULL");
  assert.deepEqual(claim.map((c) => c.status), ["ASSERTED"]);
  assert.equal((await q("SELECT counterparty_id FROM confirmation_request WHERE record_id = $1 AND status = 'OPEN'", [`c_perf_stm_b2_v2`]))[0]?.counterparty_id, "pty_member_b");
  assert.equal(await digestAt(sealed.facts_known_at), sealed.facts_digest);
});

test("existing stems are not edited or deleted after the IR — they are retired (쓰지 않음) and left out of new issues only", async () => {
  const before = await issue("vc_before", "stm_a1", "stm_b2", { pty_member_a: 5000, pty_member_b: 5000 });
  assert.equal(before.statusCode, 201, before.body);
  assert.equal((await json("PUT", "/stems/stm_b2", 409, { rightsBearing: false })).code, "CATALOG_SEALED");
  assert.equal((await json("DELETE", "/stems/stm_b2", 409)).code, "CATALOG_SEALED");
  assert.equal((await json("POST", "/stems/stm_b2/retire", 403, {}, "usr_editor")).code, "ROLE_REQUIRED");
  const r = await json("POST", "/stems/stm_b2/retire", 200, { reason: "다시 녹음함" });
  assert.equal(r.stemId, "stm_b2");
  assert.equal((await json("POST", "/stems/stm_b2/retire", 409)).code, "ALREADY_RETIRED");
  assert.equal((await json("POST", "/stems/stm_nope/retire", 404)).code, "NOT_FOUND");
  const facts = await json("GET", `/scopes/${SCOPE}/facts`, 200);
  assert.ok(facts.stems.find((s: any) => s.stemId === "stm_b2").retiredAt);
  assert.equal(facts.stems.find((s: any) => s.stemId === "stm_a1").retiredAt, null);
  const blocked = await issue("vc_after", "stm_a1", "stm_b2", { pty_member_a: 5000, pty_member_b: 5000 });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().code, "STEM_RETIRED");
  // 이미 발행된 조합의 배정은 그대로
  assert.deepEqual((await q("SELECT a.stem_id FROM snapshot_stem_assignment a JOIN rights_snapshot s ON s.snapshot_id = a.snapshot_id WHERE s.vc_id = 'vc_before' ORDER BY a.stem_id")).map((x) => x.stem_id),
    ["stm_a1", "stm_b2", "stm_mr"]);
  assert.equal(await digestAt(sealed.facts_known_at), sealed.facts_digest);
});

test("replacing in-use audio after the IR waits as a new version and is used from the next reseal; the previous audio is kept", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/ops/stems/stm_a1/audio", headers: { "x-actor": "usr_rights", "content-type": "audio/wav" }, payload: await TONE(440) })).statusCode, 202);
  await drain();
  const first = (await json("GET", "/stems/stm_a1/audio", 200));
  assert.equal(first.status, "READY");
  assert.equal(first.next, null);
  const up = await app.inject({ method: "PUT", url: "/ops/stems/stm_a1/audio", headers: { "x-actor": "usr_rights", "content-type": "audio/wav" }, payload: await TONE(660) });
  assert.equal(up.statusCode, 202, up.body);
  assert.equal(up.json().next, true);
  await drain();
  const staged = await json("GET", "/stems/stm_a1/audio", 200);
  assert.equal(staged.fileSha256, first.fileSha256, "in-use audio is unchanged until the reseal");
  assert.equal(staged.status, "READY");
  assert.equal(staged.next.status, "READY");
  assert.notEqual(staged.next.fileSha256, first.fileSha256);
  const list = await json("GET", `/scopes/${SCOPE}/stem-audio`, 200);
  assert.equal(list.find((a: any) => a.stemId === "stm_a1").next.status, "READY");
  // 다음 재고정(새 스템 추가로 facts가 바뀌었다) → 새 오디오가 쓰는 오디오, 이전 오디오는 기록에
  await w.db.tx((tx) => policy.rebindPolicy(w.ctx, tx, fixedClock("2026-02-11T00:00:00.000Z", 1000), w.users.activator, "pol_nova"));
  const now = await json("GET", "/stems/stm_a1/audio", 200);
  assert.equal(now.fileSha256, staged.next.fileSha256);
  assert.equal(now.next, null);
  assert.deepEqual((await q("SELECT file_sha256 FROM stem_audio_history WHERE stem_id = 'stm_a1'")).map((r) => r.file_sha256), [first.fileSha256]);
  // 이전 봉인은 그대로
  assert.equal(await digestAt(sealed.facts_known_at), sealed.facts_digest);
});

test("audio-only replacement: a reseal with unchanged facts still switches to the new audio and keeps the policy version", async () => {
  await app.inject({ method: "PUT", url: "/ops/stems/stm_a1/audio", headers: { "x-actor": "usr_rights", "content-type": "audio/wav" }, payload: await TONE(880) });
  await drain();
  const v = (await active()).version;
  const out = await w.db.tx((tx) => policy.rebindPolicy(w.ctx, tx, fixedClock("2026-02-12T00:00:00.000Z", 1000), w.users.activator, "pol_nova"));
  assert.equal(out.version, v);
  assert.equal(out.audioPromoted, 1);
  assert.equal((await json("GET", "/stems/stm_a1/audio", 200)).next, null);
  await assert.rejects(w.db.tx((tx) => policy.rebindPolicy(w.ctx, tx, fixedClock("2026-02-13T00:00:00.000Z", 1000), w.users.activator, "pol_nova")), /REBIND_NOT_NEEDED|already pinned/);
});
