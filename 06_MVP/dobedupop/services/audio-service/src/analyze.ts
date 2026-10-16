import { createHash } from "node:crypto";
import { encodeFingerprint, decodeMono, fingerprintOf, FP } from "./fingerprint.ts";
import { probe, type Probe } from "./probe.ts";
import { judgeQc, measure, type QcResult } from "./qc.ts";

export type Analysis = {
  /** 파일 해시(sha256 hex). 같은 파일인지(바이트 단위)만 가린다. */
  fileSha256: string; byteSize: number;
  probe: Probe | null; qc: QcResult | { passed: false; failCode: "DECODE_ERROR"; error: string };
  /** 음향 지문(base64, Uint16 창 배열). 디코딩 실패면 null. */
  fingerprint: string | null; fingerprintFrames: number;
};

/**
 * 오디오 한 파일의 기술 신호를 만든다. 이 서비스는 권리를 판단하지 않는다: QC 통과 여부와 지문만 돌려주고,
 * 스템을 READY로 바꿀지(소스 출처 판정 포함)는 권리 및 정산 코어가 정한다.
 */
export async function analyze(bytes: Uint8Array): Promise<Analysis> {
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const p0 = await probe(bytes);
    const m = await measure(bytes);
    const samples = await decodeMono(bytes);
    // 파이프로 받은 WAV처럼 컨테이너에 길이가 없으면 디코딩한 표본 수로 길이를 정한다.
    const p = p0.durationMs > 0 ? p0 : { ...p0, durationMs: Math.round((samples.length / FP.sampleRate) * 1000) };
    const fp = fingerprintOf(samples);
    return { fileSha256, byteSize: bytes.byteLength, probe: p, qc: judgeQc(p, m), fingerprint: encodeFingerprint(fp), fingerprintFrames: fp.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { fileSha256, byteSize: bytes.byteLength, probe: null, qc: { passed: false, failCode: "DECODE_ERROR", error: msg }, fingerprint: null, fingerprintFrames: 0 };
  }
}
