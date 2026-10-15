import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: Buffer; stderr: string };

/** ffmpeg·ffprobe를 실행한다. 입력은 표준입력(pipe:0)으로 넘긴다(임시 파일을 만들지 않는다). */
export function run(cmd: "ffmpeg" | "ffprobe", args: string[], input?: Uint8Array): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env[cmd === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"] ?? cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
    p.stdin.on("error", () => undefined); // 디코딩을 일찍 끝내면 EPIPE가 날 수 있다(결과는 종료 코드로 판단)
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}
