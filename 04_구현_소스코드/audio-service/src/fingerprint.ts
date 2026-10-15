import { run } from "./ffmpeg.ts";
import { fft } from "./fft.ts";

/**
 * 음향 지문(소스 출처 검사의 상용 음원 대조용). Chromaprint 계열의 단순화판이다.
 * 모노 11025Hz로 디코딩해 2048 표본 창(약 186ms)을 128 표본(약 11.6ms)씩 옮기며 300~3000Hz를 로그 간격 16개 대역으로 나누고,
 * 이웃 대역 에너지 차이가 4창 전(약 46ms)보다 커졌는지를 15비트로 적는다. 음량·코덱·표본률이 달라도 비트는 대체로 유지된다.
 * 창을 촘촘히 두는 것은 정렬 때문이다: 앞부분이 잘린 파일도 어긋남이 64표본(약 6ms) 안으로 맞춰진다.
 * 파일 해시(내용이 한 바이트라도 다르면 달라짐)와 달리, 같은 소리를 다시 인코딩해도 지문은 거의 같다.
 */
export const FP = { sampleRate: 11025, frame: 2048, hop: 128, lag: 4, bands: 16, lowHz: 300, highHz: 3000 } as const;

export async function decodeMono(bytes: Uint8Array): Promise<Float32Array> {
  const r = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(FP.sampleRate), "-f", "f32le", "pipe:1"], bytes);
  if (r.code !== 0) throw new Error(`DECODE_ERROR: ${r.stderr.trim().split("\n").pop() ?? "ffmpeg failed"}`);
  const buf = r.stdout;
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4)));
}

const EDGES = Array.from({ length: FP.bands + 1 }, (_, i) => FP.lowHz * Math.pow(FP.highHz / FP.lowHz, i / FP.bands));
const HANN = Float64Array.from({ length: FP.frame }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FP.frame - 1)));

/** 창마다 대역 에너지(로그). */
function bandEnergies(samples: Float32Array): Float64Array[] {
  const out: Float64Array[] = [];
  const binHz = FP.sampleRate / FP.frame;
  for (let start = 0; start + FP.frame <= samples.length; start += FP.hop) {
    const re = new Float64Array(FP.frame), im = new Float64Array(FP.frame);
    for (let i = 0; i < FP.frame; i++) re[i] = samples[start + i]! * HANN[i]!;
    fft(re, im);
    const e = new Float64Array(FP.bands);
    for (let b = 0; b < FP.bands; b++) {
      const lo = Math.floor(EDGES[b]! / binHz), hi = Math.max(lo + 1, Math.floor(EDGES[b + 1]! / binHz));
      let s = 0;
      for (let k = lo; k < hi; k++) s += re[k]! * re[k]! + im[k]! * im[k]!;
      e[b] = Math.log(s + 1e-12);
    }
    out.push(e);
  }
  return out;
}

/** 지문: 창마다 15비트(Uint16). 앞의 lag개 창은 비교 기준이라 빠진다. */
export function fingerprintOf(samples: Float32Array): Uint16Array {
  const e = bandEnergies(samples);
  const fp = new Uint16Array(Math.max(0, e.length - FP.lag));
  for (let t = FP.lag; t < e.length; t++) {
    let bits = 0;
    for (let b = 0; b < FP.bands - 1; b++) {
      const now = e[t]![b]! - e[t]![b + 1]!, prev = e[t - FP.lag]![b]! - e[t - FP.lag]![b + 1]!;
      if (now - prev > 0) bits |= 1 << b;
    }
    fp[t - FP.lag] = bits;
  }
  return fp;
}

export function encodeFingerprint(fp: Uint16Array): string {
  return Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength).toString("base64");
}
export function decodeFingerprint(s: string): Uint16Array {
  const b = Buffer.from(s, "base64");
  return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 2)));
}

const POP = Uint8Array.from({ length: 1 << 15 }, (_, i) => { let c = 0; for (let v = i; v; v &= v - 1) c++; return c; });

export type Match = { similarity: number; offsetFrames: number; overlapFrames: number };

/**
/**
 * 두 지문을 어긋남(offset, 창 단위 약 11.6ms)을 바꿔 가며 겹쳐 보고 가장 잘 맞는 자리의 유사도(1 − 비트 오류율)를 돌려준다.
 * 겹친 구간은 lag 창 간격으로 표본을 뽑아 센다(이웃 창은 거의 같은 정보다). 겹침이 minOverlapMs(기본 3초)보다 짧은 자리는 보지 않는다.
 * 무관한 소리는 0.5~0.65, 같은 소리는 다시 인코딩하고 앞을 잘라도 0.85 이상이다.
 */
export function compareFingerprints(a: Uint16Array, b: Uint16Array, minOverlapMs = 3000): Match {
  const minOverlap = Math.ceil((minOverlapMs / 1000) * (FP.sampleRate / FP.hop));
  let best: Match = { similarity: 0, offsetFrames: 0, overlapFrames: 0 };
  for (let off = -(b.length - minOverlap); off <= a.length - minOverlap; off++) {
    const start = Math.max(0, off), end = Math.min(a.length, off + b.length);
    if (end - start < minOverlap) continue;
    let errs = 0, n = 0;
    for (let i = start; i < end; i += FP.lag) { errs += POP[(a[i]! ^ b[i - off]!) & 0x7fff]!; n++; }
    const sim = 1 - errs / (n * (FP.bands - 1));
    if (sim > best.similarity) best = { similarity: sim, offsetFrames: off, overlapFrames: end - start };
  }
  return best;
}

/** 같은 소리로 볼 유사도 기준. */
export const MATCH_THRESHOLD = 0.85;
