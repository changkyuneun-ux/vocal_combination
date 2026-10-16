import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * 오브젝트 저장소(MVP 진행계획 M2, 아키텍처 다음 작업 15): 봉인 원문·원천 문서·오디오가 같은 인터페이스를 쓴다.
 * 개발은 파일시스템, 데모·운영은 S3 호환 저장소(데모는 SeaweedFS, 운영은 국내 리전 오브젝트 저장소). 키는 저장소마다 접두어 아래에 둔다.
 * 내용 주소 저장이라 같은 키에는 같은 내용만 쓴다(덮어써도 결과가 같다). 지우는 길은 폐기·고아 정리뿐이다.
 */
export type ObjectInfo = { key: string; size: number; modifiedAt: string };
export type ObjectStore = {
  /** DB에 남기는 위치 문자열(file:// 또는 s3://). */
  uri(key: string): string;
  /** 위치 문자열 → 키. 이 저장소의 위치가 아니면 null. */
  keyOf(uri: string): string | null;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<ObjectInfo>;
};

/** 파일시스템: root/키. 쓰기는 임시 파일 후 rename(원자적). 위치는 file://<절대 경로>(기존 저장소와 같은 모양). */
export function createFsObjectStore(root: string): ObjectStore {
  const path = (key: string) => join(root, ...key.split("/"));
  const store: ObjectStore = {
    uri: (key) => `file://${path(key)}`,
    keyOf(uri) {
      if (!uri.startsWith("file://")) return null;
      const rel = relative(root, uri.slice("file://".length));
      return rel.startsWith("..") ? null : rel.split(sep).join("/");
    },
    async put(key, bytes) {
      const p = path(key);
      await mkdir(join(p, ".."), { recursive: true });
      const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    },
    get: async (key) => readFile(path(key)),
    async exists(key) { try { await stat(path(key)); return true; } catch { return false; } },
    async delete(key) { await rm(path(key), { force: true }); },
    async *list(prefix = "") {
      async function* walk(dir: string): AsyncIterable<ObjectInfo> {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) yield* walk(p);
          else if (!e.name.endsWith(".tmp")) {
            const s = await stat(p);
            const key = relative(root, p).split(sep).join("/");
            if (key.startsWith(prefix)) yield { key, size: s.size, modifiedAt: s.mtime.toISOString() };
          }
        }
      }
      yield* walk(root);
    },
  };
  return store;
}

export type S3Config = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; prefix?: string };

const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Uint8Array | string, s: string) => createHmac("sha256", k).update(s).digest();
/** RFC 3986 인코딩(S3 서명 규칙): 영숫자와 -._~ 만 그대로 둔다. */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS 서명 버전 4(S3). 서명할 헤더는 host·x-amz-content-sha256·x-amz-date와 headers에 준 것. Authorization 값을 돌려준다.
 * path는 인코딩 전 경로(/버킷/키), query는 인코딩 전 값.
 */
export function sigV4(r: {
  method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>;
  payloadHash: string; amzDate: string; region: string; accessKey: string; secretKey: string;
}): string {
  const date = r.amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: r.host, "x-amz-content-sha256": r.payloadHash, "x-amz-date": r.amzDate };
  for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.entries(r.query ?? {}).map(([k, v]) => [enc(k), enc(v)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalPath = r.path.split("/").map(enc).join("/");
  const canonicalRequest = [r.method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, r.payloadHash].join("\n");
  const scope = `${date}/${r.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", r.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretKey}`, date), r.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${r.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** S3 호환 저장소(경로 방식 주소: endpoint/버킷/키). 위치는 s3://버킷/접두어+키. */
export function createS3ObjectStore(c: S3Config): ObjectStore {
  const base = new URL(c.endpoint);
  const prefix = c.prefix ?? "";
  const full = (key: string) => `${prefix}${key}`;
  async function call(method: string, objectKey: string | null, opts: { body?: Uint8Array; query?: Record<string, string> } = {}): Promise<Response> {
    const path = objectKey === null ? `/${c.bucket}` : `/${c.bucket}/${objectKey}`;
    const payloadHash = sha256hex(opts.body ?? "");
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const authorization = sigV4({ method, host: base.host, path, query: opts.query ?? {}, payloadHash, amzDate, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey });
    const qs = Object.entries(opts.query ?? {}).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    const url = `${base.origin}${path.split("/").map(enc).join("/")}${qs ? `?${qs}` : ""}`;
    return fetch(url, {
      method, headers: { authorization, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate },
      ...(opts.body !== undefined && { body: new Uint8Array(opts.body).buffer as ArrayBuffer }),
    });
  }
  const fail = async (what: string, r: Response) => { throw new Error(`S3 ${what} failed: ${r.status} ${(await r.text()).slice(0, 200)}`); };
  return {
    uri: (key) => `s3://${c.bucket}/${full(key)}`,
    keyOf(uri) {
      const head = `s3://${c.bucket}/${prefix}`;
      return uri.startsWith(head) ? uri.slice(head.length) : null;
    },
    async put(key, bytes) {
      const r = await call("PUT", full(key), { body: bytes });
      if (!r.ok) await fail(`PUT ${key}`, r);
      await r.arrayBuffer();
    },
    async get(key) {
      const r = await call("GET", full(key));
      if (!r.ok) await fail(`GET ${key}`, r);
      return new Uint8Array(await r.arrayBuffer());
    },
    async exists(key) {
      const r = await call("HEAD", full(key));
      await r.arrayBuffer();
      if (r.status === 404) return false;
      if (!r.ok) throw new Error(`S3 HEAD ${key} failed: ${r.status}`);
      return true;
    },
    async delete(key) {
      const r = await call("DELETE", full(key));
      if (!r.ok && r.status !== 404) await fail(`DELETE ${key}`, r);
      await r.arrayBuffer();
    },
    async *list(p = "") {
      let token: string | undefined;
      do {
        const r = await call("GET", null, { query: { "list-type": "2", prefix: full(p), ...(token && { "continuation-token": token }) } });
        if (!r.ok) await fail("LIST", r);
        const xml = await r.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)![1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
          yield { key: k.slice(prefix.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0), modifiedAt: new Date(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1]!)![1]!).toISOString() };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
      } while (token !== undefined);
    },
  };
}

/** 버킷이 없으면 만든다(시작할 때 한 번). */
export async function ensureS3Bucket(c: S3Config): Promise<void> {
  const base = new URL(c.endpoint);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = sha256hex("");
  const sign = (method: string) => sigV4({ method, host: base.host, path: `/${c.bucket}`, payloadHash, amzDate, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey });
  const head = await fetch(`${base.origin}/${enc(c.bucket)}`, { method: "HEAD", headers: { authorization: sign("HEAD"), "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate } });
  if (head.ok) return;
  const r = await fetch(`${base.origin}/${enc(c.bucket)}`, { method: "PUT", headers: { authorization: sign("PUT"), "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate } });
  if (!r.ok && r.status !== 409) throw new Error(`S3 create bucket ${c.bucket} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/**
 * 환경 설정으로 고른다. RC_OBJECT_STORE=s3이면 S3_ENDPOINT·S3_REGION(기본 us-east-1)·S3_BUCKET·S3_ACCESS_KEY·S3_SECRET_KEY가 필요하고,
 * 저장소마다 접두어(seal/·documents/·audio/)를 붙인다. 아니면 파일시스템 fsRoot.
 */
export function objectStoreFromEnv(env: Readonly<Record<string, string | undefined>>, area: "seal" | "documents" | "audio", fsRoot: string): ObjectStore {
  const kind = env.RC_OBJECT_STORE ?? "fs";
  if (kind === "fs" || kind === "") return createFsObjectStore(fsRoot);
  if (kind !== "s3") throw new Error(`RC_OBJECT_STORE must be fs or s3, got ${kind}`);
  return createS3ObjectStore({ ...s3ConfigFromEnv(env), prefix: `${area}/` });
}

export function s3ConfigFromEnv(env: Readonly<Record<string, string | undefined>>): S3Config {
  const need = (n: string) => { const v = env[n]; if (v === undefined || v === "") throw new Error(`${n} is required when RC_OBJECT_STORE=s3`); return v; };
  return { endpoint: need("S3_ENDPOINT"), region: env.S3_REGION || "us-east-1", bucket: need("S3_BUCKET"), accessKey: need("S3_ACCESS_KEY"), secretKey: need("S3_SECRET_KEY") };
}
