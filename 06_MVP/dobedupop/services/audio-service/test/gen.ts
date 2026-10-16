import { run } from "../src/ffmpeg.ts";

/** ffmpeg lavfi로 시험용 오디오를 만든다(WAV 바이트). extra는 출력 옵션(예: -ar 22050, -c:a pcm_s24le). */
export async function gen(source: string, extra: string[] = ["-ar", "48000", "-c:a", "pcm_s24le"], filter?: string): Promise<Buffer> {
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source, ...(filter ? ["-af", filter] : []), ...extra, "-f", "wav", "pipe:1"];
  const r = await run("ffmpeg", args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

/** 다른 코덱으로 다시 인코딩한다(MP3 128k → WAV 44.1kHz). 같은 소리지만 바이트는 다르다. */
export async function reencode(wav: Buffer, trimSeconds = 0): Promise<Buffer> {
  const mp3 = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"], wav);
  if (mp3.code !== 0) throw new Error(mp3.stderr);
  const back = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...(trimSeconds > 0 ? ["-ss", String(trimSeconds)] : []), "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], mp3.stdout);
  if (back.code !== 0) throw new Error(back.stderr);
  return back.stdout;
}

/**
 * 음악처럼 시간에 따라 바뀌는 신호(멜로디·떨림·리듬). seed로 서로 다른 곡을 만든다.
 * 멜로디 음은 시각을 해시해 고르므로 반복되지 않고, 순간 주파수는 늘 정해진 범위 안에 있다(길이와 상관없이 같은 대역).
 */
export function song(seed: number, seconds = 10): string {
  const f1 = 220 + seed * 31, f2 = 330 + seed * 47, f3 = 660 + seed * 59;
  const note = `floor(mod(abs(sin(floor(t*4)*12.9898+${seed}*7.13)*43758.5453),12))`;
  const expr = [
    `0.25*sin(2*PI*${f1}*pow(2,${note}/12)*t)`,
    `0.2*sin(2*PI*${f2}*t+3*sin(2*PI*0.5*t))*(0.6+0.4*sin(2*PI*1.5*t))`,
    `0.12*sin(2*PI*${f3}*t)*lt(mod(t*${3 + (seed % 4)},1),0.5)`,
  ].join("+");
  // 필터 인자 안의 쉼표는 옵션 구분자로 읽히므로 이스케이프한다.
  return `aevalsrc=${expr.replaceAll(",", "\\,")}:s=48000:d=${seconds}`;
}
