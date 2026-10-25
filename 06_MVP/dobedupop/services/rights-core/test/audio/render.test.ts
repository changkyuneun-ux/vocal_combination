import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsAudioStore, localAnalyzer, localRenderer } from "../../src/audio/deps.ts";
import { audioJobHandlers } from "../../src/audio/handlers.ts";
import { createUser } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import * as policy from "../../src/policy/service.ts";
import { gen, song } from "../../../audio-service/test/gen.ts";

// 조합 렌더링(다음 작업 10): 팬 미리듣기(발행 전), 발행 후 마스터 렌더(워터마크), 렌더 무결성 검증.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-render-"));
const audio = { store: createFsAudioStore(dir), analyzer: localAnalyzer, renderer: localRenderer };
const jobs = recordingJobs();
const clock = fixedClock("2026-02-10T00:00:00.000Z", 1000);
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, audio });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  for (const n of ["1", "2"]) {
    await registerParty(tx, c0, { partyId: `pty_fan_${n}`, partyType: "FAN", displayName: `fan ${n}`, tenantId: "tnt_platform_default" });
    await createUser(tx, c0, { userId: `usr_fan_${n}`, displayName: `fan ${n}`, roles: [], tenantId: "tnt_platform_default", partyId: `pty_fan_${n}` });
  }
});
const drain = () => jobs.drain(audioJobHandlers({ db: w.db, clock, audio }));
const upload = (stemId: string, bytes: Buffer) => app.inject({ method: "PUT", url: `/ops/stems/${stemId}/audio`, headers: { "x-actor": "usr_rights", "content-type": "audio/wav" }, payload: bytes });
// 슬롯 1(0~30초) a·b, 슬롯 2(30~90초) a·b, 반주(0~90초).
for (const [stem, src] of [["stm_a1", "sine=frequency=440:duration=31:sample_rate=48000"], ["stm_b2", "sine=frequency=660:duration=61:sample_rate=48000"]] as const) {
  assert.equal((await upload(stem, await gen(src, undefined, "volume=2"))).statusCode, 202);
}
assert.equal((await upload("stm_mr", await gen(song(6, 91)))).statusCode, 202);
await drain();

const MIX = [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }, { slotId: "slt_mr", stemId: "stm_mr" }];
const fan = (method: "GET" | "POST", url: string, user: string, payload?: object) =>
  app.inject({ method, url: `/fan${url}`, headers: { "x-actor": user }, ...(payload === undefined ? {} : { payload }) });

test("preview before issuing: a 5 s MP3 of the chosen arrangement; stems without ready audio cannot be previewed", async () => {
  const r = await fan("POST", "/previews", "usr_fan_1", { packId: "pak_nova", assignments: MIX });
  assert.equal(r.statusCode, 200, r.body.slice(0, 200));
  assert.equal(r.headers["content-type"], "audio/mpeg");
  assert.match(String(r.headers["x-render-sha256"]), /^[0-9a-f]{64}$/);
  assert.ok(r.rawPayload.length > 20_000);
  const again = await fan("POST", "/previews", "usr_fan_1", { packId: "pak_nova", assignments: MIX });
  assert.equal(again.headers["x-render-sha256"], r.headers["x-render-sha256"], "deterministic");
  const noAudio = await fan("POST", "/previews", "usr_fan_1", { packId: "pak_nova", assignments: [{ slotId: "slt_1", stemId: "stm_b1" }] });
  assert.equal(noAudio.statusCode, 409);
  assert.equal(noAudio.json().code, "PREVIEW_UNAVAILABLE");
});

test("after issuing: the master is rendered with this combination's watermark; only the issuing fan can download it", async () => {
  assert.equal((await fan("POST", "/combinations", "usr_fan_1", { packId: "pak_nova", vcId: "vc_fan_r1", assignments: MIX })).statusCode, 201);
  assert.equal((await app.inject({ method: "GET", url: "/ops/renders/snp_vc_fan_r1", headers: { "x-actor": "usr_ops" } })).json().status, "PENDING");
  await drain();
  const info = (await app.inject({ method: "GET", url: "/ops/renders/snp_vc_fan_r1", headers: { "x-actor": "usr_ops" } })).json();
  assert.equal(info.status, "RENDERED", JSON.stringify(info));
  assert.ok(Math.abs(info.durationMs - 90000) < 100, `${info.durationMs}`);
  const file = await fan("GET", "/combinations/vc_fan_r1/render", "usr_fan_1");
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["content-type"], "audio/wav");
  assert.equal(await localRenderer.readWatermark(file.rawPayload), localRenderer.watermarkBits("wm_snp_vc_fan_r1"));
  assert.equal((await fan("GET", "/combinations/vc_fan_r1/render", "usr_fan_2")).statusCode, 404);
});

test("render integrity: re-rendering the sealed assignment matches; replacing a stem's audio afterwards is a MISMATCH", async () => {
  const verify = () => app.inject({ method: "POST", url: "/ops/renders/snp_vc_fan_r1/verify", headers: { "x-actor": "usr_ops" } });
  const ok = await verify();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().result, "MATCH");
  await upload("stm_a1", await gen("sine=frequency=470:duration=31:sample_rate=48000", undefined, "volume=2"));
  await drain();
  // IR에 든 스템의 쓰던 오디오를 바꾸면 새 버전으로 대기한다(0047) — 재고정 전에는 쓰는 오디오가 그대로라 여전히 MATCH
  assert.equal((await verify()).json().result, "MATCH");
  await w.db.tx((tx) => policy.rebindPolicy(w.ctx, tx, fixedClock("2026-02-11T00:00:00.000Z", 1000), w.users.activator, "pol_nova"));
  const bad = (await verify()).json();
  assert.equal(bad.result, "MISMATCH");
  assert.equal(bad.sameInput, false);
  const signals = (await app.inject({ method: "GET", url: "/ops/pipeline/signals", headers: { "x-actor": "usr_ops" } })).json();
  assert.equal(signals.stages.find((s: any) => s.stage === "issuance").signals.find((x: any) => x.key === "render-mismatch").value, 1);
});

test("a combination with metadata-only stems is issued but its render is SKIPPED", async () => {
  const r = await fan("POST", "/combinations", "usr_fan_2", { packId: "pak_nova", vcId: "vc_fan_meta", assignments: [{ slotId: "slt_1", stemId: "stm_b1" }, { slotId: "slt_2", stemId: "stm_a2" }, { slotId: "slt_mr", stemId: "stm_mr" }] });
  assert.equal(r.statusCode, 201, r.body);
  await drain();
  assert.equal((await app.inject({ method: "GET", url: "/ops/renders/snp_vc_fan_meta", headers: { "x-actor": "usr_ops" } })).json().status, "SKIPPED");
});
