import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, decodeForWatermark, detectWatermark, render, watermarkBits } from "../src/index.ts";
import { gen, song } from "./gen.ts";

// 조합 렌더링(다음 작업 10): 슬롯별 스템 + 반주 믹스다운, 5초 미리듣기, 워터마크가 든 마스터, 같은 입력 → 같은 바이트.
const vocalA = await gen("sine=frequency=440:duration=6:sample_rate=48000", undefined, "volume=2");
const vocalB = await gen("sine=frequency=660:duration=6:sample_rate=48000", undefined, "volume=2");
const backing = await gen(song(5, 12));
const parts = [
  { bytes: vocalA, startMs: 0, endMs: 6000 },
  { bytes: vocalB, startMs: 6000, endMs: 12000 },
  { bytes: backing, startMs: 0, endMs: 12000 },
];

test("preview: the first 5 seconds as MP3, no watermark, deterministic", async () => {
  const a = await render({ parts, mode: "preview" });
  const b = await render({ parts, mode: "preview" });
  assert.equal(a.contentType, "audio/mpeg");
  assert.equal(a.sha256, b.sha256, "same input → same bytes");
  const probe = await analyze(a.bytes);
  assert.ok(Math.abs((probe.probe?.durationMs ?? 0) - 5000) < 150, `~5 s: ${probe.probe?.durationMs}`);
});

test("master: full length WAV with a watermark that can be read back; different IDs give different marks", async () => {
  const m = await render({ parts, mode: "master", watermarkId: "wm_snp_vc_1" });
  assert.equal(m.contentType, "audio/wav");
  assert.ok(Math.abs(m.durationMs - 12000) < 50, `${m.durationMs}`);
  assert.equal((await render({ parts, mode: "master", watermarkId: "wm_snp_vc_1" })).sha256, m.sha256, "deterministic");
  const found = detectWatermark(await decodeForWatermark(m.bytes));
  assert.ok(found !== null, "watermark found");
  assert.equal(found!.bits32, watermarkBits("wm_snp_vc_1"));
  assert.notEqual(watermarkBits("wm_snp_vc_2"), found!.bits32);
  const plain = await render({ parts, mode: "master" });
  assert.equal(detectWatermark(await decodeForWatermark(plain.bytes)), null, "no watermark without an id");
});

test("the watermark is far below the music (inaudible level) and does not trip QC", async () => {
  const m = await analyze((await render({ parts, mode: "master", watermarkId: "wm_x" })).bytes);
  const plain = await analyze((await render({ parts, mode: "master" })).bytes);
  assert.equal(m.qc.passed, true, JSON.stringify(m.qc));
  const dLufs = Math.abs((m.qc as any).measures.integratedLufs - (plain.qc as any).measures.integratedLufs);
  assert.ok(dLufs < 0.2, `loudness change ${dLufs} LU`);
});
