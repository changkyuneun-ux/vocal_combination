import { readFile } from "node:fs/promises";
import { createFsObjectStore, type ObjectStore } from "../platform/object-store.ts";
import type { BlobStore } from "./context.ts";

/** 봉인 원문 키: digest hex 앞 4자리로 두 단계 나눈다(<2>/<2>/<hex>.json). */
export const sealKey = (digest: string): string => {
  const hex = digest.slice("mdrl:sha256:".length);
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}.json`;
};

/** 봉인 원문 저장소: 오브젝트 저장소 위에 둔다(개발 = 파일, 데모·운영 = S3 호환). 같은 digest는 한 번만 쓴다. */
export function createObjectBlobStore(os: ObjectStore): BlobStore & { objects: ObjectStore } {
  return {
    objects: os,
    async put(digest, bytes) {
      const key = sealKey(digest);
      if (!(await os.exists(key))) await os.put(key, bytes);
      return os.uri(key);
    },
    async get(uri) {
      const key = os.keyOf(uri);
      if (key !== null) return os.get(key);
      // 다른 저장소로 옮기기 전에 남은 파일 위치(file://)는 그대로 읽는다.
      if (uri.startsWith("file://")) return readFile(uri.slice("file://".length));
      throw new Error(`blob ${uri} is not in this store`);
    },
  };
}

/** 개발용 파일시스템 blob 저장소(경로 = root/<2>/<2>/<hex>.json). */
export function createFsBlobStore(root: string): BlobStore & { objects: ObjectStore } {
  return createObjectBlobStore(createFsObjectStore(root));
}
