import { createServer } from "node:http";
import { analyze } from "./analyze.ts";
import { compareFingerprints, decodeFingerprint } from "./fingerprint.ts";

/**
 * 오디오 처리 서비스(HTTP). 코어의 작업 큐 처리기가 부른다. 원본 스템은 이 서비스 밖으로 내보내지 않고 신호만 돌려준다.
 * POST /analyze  본문 = 오디오 바이트 → Analysis(JSON)
 * POST /compare  {a, b} = base64 지문 → Match
 */
const MAX_BYTES = 200 * 1024 * 1024;
const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BYTES) return send(413, { code: "TOO_LARGE" }); chunks.push(c as Buffer); }
    const body = Buffer.concat(chunks);
    if (req.method === "POST" && req.url === "/analyze") return send(200, await analyze(body));
    if (req.method === "POST" && req.url === "/compare") {
      const { a, b } = JSON.parse(body.toString()) as { a: string; b: string };
      return send(200, compareFingerprints(decodeFingerprint(a), decodeFingerprint(b)));
    }
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
    return send(404, { code: "NOT_FOUND" });
  } catch (e) {
    return send(500, { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) });
  }
});
const port = Number(process.env.PORT ?? 8090);
// 컨테이너 안에서는 AUDIO_LISTEN_HOST=0.0.0.0(코어만 같은 내부망에서 부른다).
const host = process.env.AUDIO_LISTEN_HOST || "127.0.0.1";
server.listen(port, host, () => console.log(`audio-service listening on http://${host}:${port}`));
