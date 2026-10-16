import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsAudioStore, localAnalyzer } from "../../src/audio/deps.ts";
import { audioJobHandlers } from "../../src/audio/handlers.ts";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { gen, reencode, song } from "../../../audio-service/test/gen.ts";

// 오디오 처리 서비스 연동(다음 작업 9): 업로드 → 검사 작업 → QC·소스 출처 판정 → READY만 발행. 실제 ffmpeg로 만든 신호를 쓴다.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-audio-"));
const audio = { store: createFsAudioStore(dir), analyzer: localAnalyzer };
const jobs = recordingJobs();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, audio });
const bare = buildServer({ db: w.db, ctx: w.ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await bare.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  await registerParty(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { partyId: "pty_major", partyType: "LABEL", displayName: "다른 레이블" });
  await createUser(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), { userId: "usr_ops_review", displayName: "검수", roles: ["SPACE_OPS"] });
});

const put = (stemId: string, bytes: Buffer, server = app) =>
  server.inject({ method: "PUT", url: `/ops/stems/${stemId}/audio`, headers: { "x-actor": "usr_rights", "content-type": "audio/wav" }, payload: bytes });
const get = async (url: string, actor = "usr_rights") => (await app.inject({ method: "GET", url, headers: { "x-actor": actor } }));
const status = async (stemId: string) => (await get(`/ops/stems/${stemId}/audio`)).json();
const drain = () => jobs.drain(audioJobHandlers({ db: w.db, clock, audio }));
const issue = (vcId: string, s1: string, s2: string) => app.inject({
  method: "POST", url: "/ops/issues", headers: { "x-actor": "usr_issuer" },
  payload: { packId: "pak_nova", vcId, members: { pty_member_a: 5000, pty_member_b: 5000 }, assignments: [{ slotId: "slt_1", stemId: s1 }, { slotId: "slt_2", stemId: s2 }, { slotId: "slt_mr", stemId: "stm_mr" }] },
});

const TONE = (seconds: number) => gen(`sine=frequency=440:duration=${seconds}:sample_rate=48000`, undefined, "volume=2");
const MAJOR_HIT = await gen(song(3, 65)); // 다른 권리자의 상용 음원
const OWN_MASTER = await gen(song(4, 35)); // 이 곡 마스터 권리자(pty_label)의 음원

test("without audio processing configured, uploads are 503 and nothing is stored", async () => {
  const r = await put("stm_a1", Buffer.from("x"), bare);
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().code, "AUDIO_NOT_CONFIGURED");
});

test("a clean stem: upload → PENDING (not issuable) → check → READY (issuable)", async () => {
  const r = await put("stm_a1", await TONE(31));
  assert.equal(r.statusCode, 202, r.body);
  assert.equal((await status("stm_a1")).status, "PENDING");
  const blocked = await issue("vc_pending", "stm_a1", "stm_b2");
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.json().code, "STEM_NOT_READY");
  await drain();
  const s = await status("stm_a1");
  assert.equal(s.status, "READY", JSON.stringify(s));
  assert.equal(s.sourceResult, "PASS");
  assert.deepEqual(s.source.notChecked, ["ai_generated", "registered_voice_match"]);
  assert.equal((await issue("vc_ready", "stm_a1", "stm_b2")).statusCode, 201);
});

test("QC failure: a silent stem is QC_FAILED and refused at issuance", async () => {
  await put("stm_b2", await gen("anullsrc=r=48000:cl=mono", ["-t", "61", "-ar", "48000", "-c:a", "pcm_s24le"]));
  await drain();
  const s = await status("stm_b2");
  assert.equal(s.status, "QC_FAILED");
  assert.equal(s.qcFailCode, "SILENT");
  const r = await issue("vc_silent", "stm_a1", "stm_b2");
  assert.equal(r.statusCode, 422);
  assert.deepEqual(r.json().diagnostics.map((d: any) => d.path), ["$.assignments.stm_b2"]);
});

test("source check: another label's commercial recording is BLOCKED; the song's own master is a SELF_MATCH", async () => {
  const ref = (q: string, bytes: Buffer) => app.inject({ method: "POST", url: `/ops/reference-audio?${q}`, headers: { "x-actor": "usr_ops", "content-type": "audio/wav" }, payload: bytes });
  assert.equal((await ref("referenceId=ref_major&title=Major%20Hit&ownerPartyId=pty_major", MAJOR_HIT)).statusCode, 201);
  assert.equal((await ref("referenceId=ref_own&title=Nova%20master&ownerPartyId=pty_label", OWN_MASTER)).statusCode, 201);
  await put("stm_b2", await reencode(MAJOR_HIT, 2));
  await put("stm_b1", await reencode(OWN_MASTER, 1));
  await drain();
  const b2 = await status("stm_b2");
  assert.equal(b2.status, "BLOCKED", JSON.stringify(b2.source));
  assert.match(b2.source.findings[0].detail, /ref_major/);
  const b1 = await status("stm_b1");
  assert.equal(b1.status, "READY", JSON.stringify(b1.source));
  assert.equal(b1.sourceResult, "SELF_MATCH");
});

test("REVIEW: a file shorter than its slot waits for an operator decision with a reason", async () => {
  await put("stm_a2", await TONE(10));
  await drain();
  assert.equal((await status("stm_a2")).status, "REVIEW");
  const queue = (await get("/ops/audio/queue?status=REVIEW")).json();
  assert.deepEqual(queue.map((q: any) => q.stemId), ["stm_a2"]);
  const review = (actor: string, body: object) => app.inject({ method: "POST", url: "/ops/stems/stm_a2/audio/review", headers: { "x-actor": actor }, payload: body });
  assert.equal((await review("usr_rights", { decision: "READY", reason: "x" })).statusCode, 403);
  assert.equal((await review("usr_ops_review", { decision: "READY" })).statusCode, 400);
  const ok = await review("usr_ops_review", { decision: "READY", reason: "인트로만 부른 파트라 짧음 확인" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().status, "READY");
  assert.equal((await review("usr_ops_review", { decision: "BLOCKED", reason: "again" })).statusCode, 409);
});

test("re-uploading resets the stem to PENDING and re-checks it", async () => {
  await put("stm_b2", await TONE(61));
  assert.equal((await status("stm_b2")).status, "PENDING");
  await drain();
  assert.equal((await status("stm_b2")).status, "READY");
  const signals = (await get("/ops/pipeline/signals", "usr_ops")).json();
  const audioStage = signals.stages.find((s: any) => s.stage === "audio");
  assert.equal(audioStage.signals.find((x: any) => x.key === "audio-ready").value, 4);
});
