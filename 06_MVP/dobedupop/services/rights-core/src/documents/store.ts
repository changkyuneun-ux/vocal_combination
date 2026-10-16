import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 원천 문서 저장소(원천 문서 설계 S1, 결정 D3). 원문은 테넌트별 키로 암호화해 두고, 같은 테넌트·같은 해시의 파일은 한 번만 쓴다(덮어쓰기 금지).
 * 지우는 길은 보관 기한이 지난 뒤의 폐기(dispose)뿐이다. 운영에서는 국내 리전 오브젝트 저장소의 객체 잠금(WORM)과 KMS 키로 같은 계약을 구현한다.
 */
export type DocumentStore = {
  put(tenantId: string, bytes: Uint8Array): Promise<{ sha256: string; uri: string }>;
  get(tenantId: string, uri: string): Promise<Uint8Array>;
  dispose(uri: string): Promise<void>;
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** 테넌트 키: 마스터 키에서 테넌트 id로 유도한다(HKDF-SHA256). 한 테넌트의 키가 새도 다른 테넌트의 원문은 열리지 않는다. */
function tenantKey(master: Buffer, tenantId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("rc-source-document"), Buffer.from(tenantId), 32));
}

/** 개발·시험용 파일시스템 저장소. 파일 = IV(12) | 인증 태그(16) | AES-256-GCM 암호문. 경로는 테넌트/해시. */
export function createFsDocumentStore(root: string, masterKey: Buffer): DocumentStore {
  if (masterKey.length < 32) throw new Error("document master key must be at least 32 bytes");
  return {
    async put(tenantId, bytes) {
      const hash = sha256(bytes);
      const dir = join(root, tenantId, hash.slice(0, 2));
      const path = join(dir, hash);
      const uri = `file://${path}`;
      try { await stat(path); return { sha256: hash, uri }; } catch { /* 없으면 쓴다 */ }
      await mkdir(dir, { recursive: true });
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", tenantKey(masterKey, tenantId), iv);
      const body = Buffer.concat([c.update(bytes), c.final()]);
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, Buffer.concat([iv, c.getAuthTag(), body]));
      await rename(tmp, path);
      return { sha256: hash, uri };
    },
    async get(tenantId, uri) {
      const raw = await readFile(uri.slice("file://".length));
      const d = createDecipheriv("aes-256-gcm", tenantKey(masterKey, tenantId), raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    },
    async dispose(uri) { await rm(uri.slice("file://".length), { force: true }); },
  };
}

/** 개발용 마스터 키. 운영은 RC_DOC_KEY(32바이트 이상, base64)로 준다. */
export function documentMasterKey(env = process.env.RC_DOC_KEY): Buffer {
  return env !== undefined && env !== "" ? Buffer.from(env, "base64") : createHash("sha256").update("rc-dev-document-key").digest();
}
