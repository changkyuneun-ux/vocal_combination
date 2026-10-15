import { run } from "./ffmpeg.ts";

export type Probe = { codec: string; sampleRate: number; channels: number; bitDepth: number | null; sampleFormat: string; durationMs: number };

/** 컨테이너·코덱 정보(ffprobe). bitDepth는 정수 PCM이면 비트 수, 부동소수면 32, 압축 코덱이면 null. */
export async function probe(bytes: Uint8Array): Promise<Probe> {
  const r = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", "-i", "pipe:0"], bytes);
  if (r.code !== 0) throw new Error(`DECODE_ERROR: ${r.stderr.trim().split("\n").pop() ?? "ffprobe failed"}`);
  const j = JSON.parse(r.stdout.toString()) as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const a = j.streams?.find((s) => s.codec_type === "audio");
  if (a === undefined) throw new Error("DECODE_ERROR: no audio stream");
  const fmt = String(a.sample_fmt ?? "");
  const raw = Number(a.bits_per_raw_sample ?? a.bits_per_sample ?? 0);
  const bitDepth = fmt.startsWith("flt") || fmt.startsWith("dbl") ? 32 : raw > 0 ? raw : fmt.startsWith("s16") ? 16 : fmt.startsWith("s32") ? 32 : null;
  const duration = Number(a.duration ?? j.format?.duration ?? 0);
  return { codec: String(a.codec_name), sampleRate: Number(a.sample_rate), channels: Number(a.channels), bitDepth, sampleFormat: fmt, durationMs: Math.round(duration * 1000) };
}
