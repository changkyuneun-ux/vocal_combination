import { createHash } from "node:crypto";

/**
 * 비가청 워터마크(마스터 렌더용). 17.0kHz·17.5kHz 두 주파수로 비트를 싣는 FSK를 −50dBFS 안팎의 아주 작은 크기로 섞는다.
 * 동기 8비트 + ID 32비트를 50ms 비트로 곡 끝까지 반복해 넣고, 검출은 반복마다 읽은 비트를 다수결로 모은다.
 * 무손실(WAV·FLAC) 마스터에서 읽힌다. 손실 압축(MP3 128k 등)은 이 대역을 깎을 수 있어 미리듣기에는 넣지 않는다.
 */
export const WM = { sampleRate: 48000, f0: 17000, f1: 17500, bitMs: 50, amplitude: 0.004, sync: [1, 0, 1, 1, 0, 0, 1, 0] } as const;

/** 워터마크 ID(문자열) → 32비트 정수(sha256 앞 4바이트). 같은 ID는 같은 비트다. */
export function watermarkBits(id: string): number {
  return createHash("sha256").update(id).digest().readUInt32BE(0);
}

function frame(bits32: number): number[] {
  const out: number[] = [...WM.sync];
  for (let i = 31; i >= 0; i--) out.push((bits32 >>> i) & 1);
  return out;
}

/** 스테레오 interleaved f32 PCM(48kHz)에 워터마크를 더한다(제자리). */
export function embedWatermark(pcm: Float32Array, channels: number, id: string): void {
  const bits = frame(watermarkBits(id));
  const perBit = Math.round((WM.sampleRate * WM.bitMs) / 1000);
  const frames = Math.floor(pcm.length / channels);
  for (let n = 0; n < frames; n++) {
    const k = Math.floor(n / perBit);
    const f = bits[k % bits.length] ? WM.f1 : WM.f0;
    // 비트 경계의 딸깍임을 줄이려고 비트마다 사인 창(sin²)으로 감싼다.
    const pos = (n % perBit) / perBit;
    const env = Math.sin(Math.PI * pos) ** 2;
    const v = WM.amplitude * env * Math.sin((2 * Math.PI * f * n) / WM.sampleRate);
    for (let c = 0; c < channels; c++) pcm[n * channels + c]! += v;
  }
}

function goertzel(x: Float32Array, start: number, len: number, freq: number): number {
  const w = (2 * Math.PI * freq) / WM.sampleRate, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) { const s = x[start + i]! + coeff * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * 모노 f32 PCM(48kHz)에서 워터마크 32비트를 읽는다. 비트 경계 위치(위상)를 몇 가지 시험해 동기 패턴이 가장 잘 맞는 위상을 고르고,
 * 반복마다 읽은 ID 비트를 다수결로 합친다. 반복이 2번 미만이거나 동기 일치율이 낮으면 null.
 */
export function detectWatermark(mono: Float32Array): { bits32: number; confidence: number } | null {
  const perBit = Math.round((WM.sampleRate * WM.bitMs) / 1000);
  const frameLen = WM.sync.length + 32;
  let best: { bits32: number; confidence: number } | null = null;
  for (let phase = 0; phase < perBit; phase += Math.round(perBit / 8)) {
    const nBits = Math.floor((mono.length - phase) / perBit);
    const raw: number[] = [];
    // 비트 창의 가운데 절반만 본다(경계의 창 함수 영향을 줄인다).
    for (let k = 0; k < nBits; k++) raw.push(goertzel(mono, phase + k * perBit + perBit / 4, perBit / 2, WM.f1) > goertzel(mono, phase + k * perBit + perBit / 4, perBit / 2, WM.f0) ? 1 : 0);
    for (let shift = 0; shift < frameLen; shift++) {
      const votes = new Array<number>(32).fill(0);
      let syncOk = 0, syncAll = 0, reps = 0;
      for (let f = shift; f + frameLen <= raw.length; f += frameLen) {
        reps++;
        for (let i = 0; i < WM.sync.length; i++) { syncAll++; if (raw[f + i] === WM.sync[i]) syncOk++; }
        for (let i = 0; i < 32; i++) votes[i]! += raw[f + WM.sync.length + i]! ? 1 : -1;
      }
      if (reps < 2) continue;
      const conf = syncOk / syncAll;
      if (best === null || conf > best.confidence) {
        let bits = 0;
        for (let i = 0; i < 32; i++) bits = ((bits << 1) | (votes[i]! > 0 ? 1 : 0)) >>> 0;
        best = { bits32: bits, confidence: conf };
      }
    }
  }
  return best !== null && best.confidence >= 0.9 ? best : null;
}
