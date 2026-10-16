import { run } from "./ffmpeg.ts";
import type { Probe } from "./probe.ts";

/** 스템 기술 검수 기준(아키텍처 문서 "오디오 처리 서비스": 포맷·클리핑·무음·라우드니스). */
export const QC_RULES = {
  sampleRates: [44100, 48000, 88200, 96000],
  minBitDepth: 16,
  maxTruePeakDbtp: -1.0,
  silentMeanVolumeDb: -60,
  loudnessLufs: [-40, -5] as const,
};

export type QcFailCode = "FORMAT_UNSUPPORTED" | "CLIPPING" | "SILENT" | "LOUDNESS_OUT_OF_RANGE";
export type Measures = { integratedLufs: number; truePeakDbtp: number; meanVolumeDb: number };
export type QcResult = { passed: boolean; failCode?: QcFailCode; measures: Measures; checks: { name: string; passed: boolean; detail: string }[] };

const num = (re: RegExp, s: string): number => {
  const m = [...s.matchAll(re)].pop();
  if (m === undefined) return Number.NaN;
  return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
};

/** 라우드니스(LUFS, EBU R128), True Peak(dBTP), 평균 음량(dB)을 잰다. */
export async function measure(bytes: Uint8Array): Promise<Measures> {
  const r = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", "pipe:0", "-af", "ebur128=peak=true,volumedetect", "-f", "null", "-"], bytes);
  if (r.code !== 0) throw new Error(`DECODE_ERROR: ${r.stderr.trim().split("\n").pop() ?? "ffmpeg failed"}`);
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  return {
    integratedLufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/g, summary),
    truePeakDbtp: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/g, summary),
    meanVolumeDb: num(/mean_volume:\s+(-?[\d.]+|-inf) dB/g, r.stderr),
  };
}

/** 측정값을 기준에 대 본다. 첫 실패가 failCode다(포맷 → 무음 → 클리핑 → 라우드니스 순). */
export function judgeQc(p: Probe, m: Measures): QcResult {
  const checks = [
    { name: "format", code: "FORMAT_UNSUPPORTED" as const, passed: QC_RULES.sampleRates.includes(p.sampleRate) && (p.bitDepth === null || p.bitDepth >= QC_RULES.minBitDepth),
      detail: `${p.codec} ${p.sampleRate}Hz ${p.bitDepth ?? "?"}bit ${p.channels}ch` },
    { name: "silence", code: "SILENT" as const, passed: m.meanVolumeDb > QC_RULES.silentMeanVolumeDb, detail: `mean ${m.meanVolumeDb} dB` },
    { name: "clipping", code: "CLIPPING" as const, passed: m.truePeakDbtp <= QC_RULES.maxTruePeakDbtp, detail: `true peak ${m.truePeakDbtp} dBTP` },
    { name: "loudness", code: "LOUDNESS_OUT_OF_RANGE" as const, passed: m.integratedLufs >= QC_RULES.loudnessLufs[0] && m.integratedLufs <= QC_RULES.loudnessLufs[1], detail: `${m.integratedLufs} LUFS` },
  ];
  const failed = checks.find((c) => !c.passed);
  return { passed: failed === undefined, ...(failed && { failCode: failed.code }), measures: m, checks: checks.map(({ name, passed, detail }) => ({ name, passed, detail })) };
}
