import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createFsObjectStore, type ObjectStore } from "../platform/object-store.ts";
import { analyze, decodeForWatermark, detectWatermark, render, watermarkBits, type Analysis, type RenderInput, type Rendered } from "audio-service";

/** 업로드한 원본 오디오의 저장소(파일 해시 sha256로 주소를 매긴다). 원본은 이 저장소와 오디오 처리 서비스 밖으로 나가지 않는다. */
export type AudioStore = { put(bytes: Uint8Array): Promise<{ sha256: string; uri: string }>; get(uri: string): Promise<Uint8Array> };
/** 오디오 처리 서비스 호출(기술 신호만 받는다). */
export type Analyzer = (bytes: Uint8Array) => Promise<Analysis>;
/** 렌더링(믹스다운·미리듣기·워터마크)과 워터마크 읽기. */
export type Renderer = { render(input: RenderInput): Promise<Rendered>; readWatermark(bytes: Uint8Array): Promise<number | null>; watermarkBits(id: string): number };
export type AudioDeps = { store: AudioStore; analyzer: Analyzer; renderer?: Renderer };

/** 같은 프로세스에서 렌더링 라이브러리를 부른다(개발·시험). */
export const localRenderer: Renderer = {
  render: (input) => render(input),
  readWatermark: async (bytes) => detectWatermark(await decodeForWatermark(bytes))?.bits32 ?? null,
  watermarkBits,
};

/** 오디오 저장소: 오브젝트 저장소 위에 둔다. 키는 sha256 앞 4자리로 두 단계 나눈다(<2>/<2>/<sha256>). */
export function createObjectAudioStore(os: ObjectStore): AudioStore {
  return {
    async put(bytes) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
      if (!(await os.exists(key))) await os.put(key, bytes);
      return { sha256, uri: os.uri(key) };
    },
    async get(uri) {
      const key = os.keyOf(uri);
      if (key !== null) return os.get(key);
      if (uri.startsWith("file://")) return readFile(uri.slice("file://".length));
      throw new Error(`audio ${uri} is not in this store`);
    },
  };
}

/** 개발·시험용 파일시스템 저장소(경로 = root/<2>/<2>/<sha256>). */
export function createFsAudioStore(root: string): AudioStore {
  return createObjectAudioStore(createFsObjectStore(root));
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
