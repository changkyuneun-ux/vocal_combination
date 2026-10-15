import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, compareFingerprints, decodeFingerprint, MATCH_THRESHOLD } from "../src/index.ts";
import { FP } from "../src/fingerprint.ts";
import { gen, reencode, song } from "./gen.ts";

// 오디오 처리 서비스(다음 작업 9): 스템 기술 검수(QC)와 음향 지문. ffmpeg로 만든 시험 신호를 쓴다.
const TONE = "sine=frequency=440:duration=5:sample_rate=48000";

test("QC passes a clean 48kHz/24-bit stem and reports its measures", async () => {
  const a = await analyze(await gen(TONE, undefined, "volume=2"));
  assert.equal(a.qc.passed, true, JSON.stringify(a.qc));
  assert.equal(a.probe?.sampleRate, 48000);
  assert.equal(a.probe?.bitDepth, 24);
  assert.match(a.fileSha256, /^[0-9a-f]{64}$/);
});

test("QC fails: unsupported sample rate, silence, clipping (True Peak), undecodable bytes", async () => {
  assert.equal((await analyze(await gen(TONE, ["-ar", "22050", "-c:a", "pcm_s16le"], "volume=2"))).qc.failCode, "FORMAT_UNSUPPORTED");
  assert.equal((await analyze(await gen("anullsrc=r=48000:cl=mono", ["-t", "5", "-ar", "48000", "-c:a", "pcm_s24le"]))).qc.failCode, "SILENT");
  const clipped = await analyze(await gen(TONE, undefined, "volume=12"));
  assert.equal(clipped.qc.failCode, "CLIPPING", JSON.stringify(clipped.qc));
  const junk = await analyze(new TextEncoder().encode("not audio at all"));
  assert.equal(junk.qc.failCode, "DECODE_ERROR");
  assert.equal(junk.fingerprint, null);
});

test("fingerprint: the same song re-encoded and trimmed still matches; a different song does not", async () => {
  const original = await gen(song(1));
  const a = await analyze(original);
  const again = await analyze(await reencode(original, 1.5));
  const other = await analyze(await gen(song(2)));
  assert.notEqual(a.fileSha256, again.fileSha256, "different bytes");
  const same = compareFingerprints(decodeFingerprint(a.fingerprint!), decodeFingerprint(again.fingerprint!));
  const diff = compareFingerprints(decodeFingerprint(a.fingerprint!), decodeFingerprint(other.fingerprint!));
  assert.ok(same.similarity >= MATCH_THRESHOLD, `same: ${same.similarity}`);
  assert.ok(diff.similarity < MATCH_THRESHOLD - 0.1, `different: ${diff.similarity}`);
  const offsetSeconds = (same.offsetFrames * FP.hop) / FP.sampleRate;
  assert.ok(Math.abs(offsetSeconds - 1.5) < 0.1, `the 1.5 s trim is found as the offset: ${offsetSeconds}`);
});
