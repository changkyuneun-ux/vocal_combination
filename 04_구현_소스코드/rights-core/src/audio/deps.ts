import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyze, type Analysis } from "audio-service";

/** 업로드한 원본 오디오의 저장소(파일 해시 sha256로 주소를 매긴다). 원본은 이 저장소와 오디오 처리 서비스 밖으로 나가지 않는다. */
export type AudioStore = { put(bytes: Uint8Array): Promise<{ sha256: string; uri: string }>; get(uri: string): Promise<Uint8Array> };
/** 오디오 처리 서비스 호출(기술 신호만 받는다). */
export type Analyzer = (bytes: Uint8Array) => Promise<Analysis>;
export type AudioDeps = { store: AudioStore; analyzer: Analyzer };

/** 개발·시험용 파일시스템 저장소. 경로는 sha256 앞 4자리로 두 단계 나눈다. 임시 파일 후 rename(원자적). */
export function createFsAudioStore(root: string): AudioStore {
  return {
    async put(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const dir = join(root, sha256.slice(0, 2), sha256.slice(2, 4));
      const path = join(dir, sha256);
      const uri = `file://${path}`;
      try { await stat(path); return { sha256, uri }; } catch { /* 없으면 쓴다 */ }
      await mkdir(dir, { recursive: true });
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path);
      return { sha256, uri };
    },
    async get(uri) { return readFile(uri.slice("file://".length)); },
  };
}

/** 같은 프로세스에서 오디오 처리 서비스 라이브러리를 부른다(개발·시험). */
export const localAnalyzer: Analyzer = (bytes) => analyze(bytes);

/** 별도 프로세스로 띄운 오디오 처리 서비스(audio-service, POST /analyze)를 부른다. */
export function httpAnalyzer(baseUrl: string): Analyzer {
  return async (bytes) => {
    const res = await fetch(`${baseUrl}/analyze`, { method: "POST", body: new Blob([new Uint8Array(bytes)]), headers: { "content-type": "application/octet-stream" } });
    if (!res.ok) throw new Error(`audio-service ${res.status}: ${await res.text()}`);
    return (await res.json()) as Analysis;
  };
}
