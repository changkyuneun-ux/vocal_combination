import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BlobStore } from "./context.ts";

/** 개발용 파일시스템 blob 저장소. 경로는 digest hex 앞 4자리로 두 단계 샤딩한다. 쓰기는 임시 파일 후 rename(원자적). */
export function createFsBlobStore(root: string): BlobStore {
  return {
    async put(digest, bytes) {
      const hex = digest.slice("vcrl:sha256:".length);
      const dir = join(root, hex.slice(0, 2), hex.slice(2, 4));
      const path = join(dir, `${hex}.json`);
      const uri = `file://${path}`;
      try {
        await stat(path);
        return uri;
      } catch {
        await mkdir(dir, { recursive: true });
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, path);
        return uri;
      }
    },
    async get(uri) {
      return readFile(uri.slice("file://".length));
    },
  };
}
