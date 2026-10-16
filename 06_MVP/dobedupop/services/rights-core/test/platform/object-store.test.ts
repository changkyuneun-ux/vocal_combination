import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { freshDb } from "../helpers.ts";
import { createFsObjectStore, createS3ObjectStore, ensureS3Bucket, objectStoreFromEnv, sigV4, type ObjectStore } from "../../src/platform/object-store.ts";
import { sweepOrphanDocuments, sweepOrphanSeals } from "../../src/platform/object-gc.ts";
import { createObjectBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { createObjectDocumentStore } from "../../src/documents/store.ts";
import { createObjectAudioStore } from "../../src/audio/deps.ts";

// 오브젝트 저장소(MVP 진행계획 M2, 다음 작업 15): 파일시스템과 S3 호환 저장소가 같은 계약을 지킨다. S3 시험은 docker compose의 SeaweedFS(localhost:8333)를 쓴다.
const dir = mkdtempSync(join(tmpdir(), "rc-objects-"));
const { db, drop } = await freshDb();
after(async () => { await drop(); rmSync(dir, { recursive: true, force: true }); });
const s3 = { endpoint: process.env.S3_ENDPOINT ?? "http://localhost:8333", region: "us-east-1", bucket: `rc-test-${randomBytes(4).toString("hex")}`, accessKey: "rcs3", secretKey: "rcs3-dev-secret" };

test("SigV4 matches the AWS documentation example (GET object with Range)", () => {
  const auth = sigV4({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", amzDate: "20130524T000000Z", region: "us-east-1",
    accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(auth, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

async function contract(os: ObjectStore) {
  const bytes = new TextEncoder().encode("hello object");
  assert.equal(await os.exists("ab/cd/x.json"), false);
  await os.put("ab/cd/x.json", bytes);
  await os.put("ef/01/y.json", bytes);
  assert.equal(await os.exists("ab/cd/x.json"), true);
  assert.deepEqual(Buffer.from(await os.get("ab/cd/x.json")), Buffer.from(bytes));
  assert.equal(os.keyOf(os.uri("ab/cd/x.json")), "ab/cd/x.json");
  assert.equal(os.keyOf("file:///elsewhere/z"), null);
  const keys: string[] = [];
  for await (const o of os.list("ab/")) keys.push(o.key);
  assert.deepEqual(keys, ["ab/cd/x.json"]);
  await os.delete("ab/cd/x.json");
  assert.equal(await os.exists("ab/cd/x.json"), false);
}

test("the filesystem object store keeps the contract", async () => {
  await contract(createFsObjectStore(join(dir, "fs")));
});

test("the S3 object store keeps the contract against an S3-compatible server", async () => {
  await ensureS3Bucket(s3);
  await ensureS3Bucket(s3); // 두 번 불러도 된다
  const os = createS3ObjectStore({ ...s3, prefix: "seal/" });
  await contract(os);
  assert.match(os.uri("ab/cd/x.json"), new RegExp(`^s3://${s3.bucket}/seal/ab/cd/x\\.json$`));
  assert.equal(createS3ObjectStore({ ...s3, prefix: "documents/" }).keyOf(os.uri("k")), null, "another area's uri is not this store's");
});

test("seal, document and audio stores work on S3 with the same keys and encryption", async () => {
  const env = { RC_OBJECT_STORE: "s3", S3_ENDPOINT: s3.endpoint, S3_BUCKET: s3.bucket, S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey };
  const blobs = createObjectBlobStore(objectStoreFromEnv(env, "seal", "/unused"));
  const digest = `mdrl:sha256:${"a1".repeat(32)}`;
  const uri = await blobs.put(digest, new TextEncoder().encode("{}"));
  assert.equal(uri, `s3://${s3.bucket}/seal/a1/a1/${"a1".repeat(32)}.json`);
  assert.equal(new TextDecoder().decode(await blobs.get(uri)), "{}");
  const docs = createObjectDocumentStore(objectStoreFromEnv(env, "documents", "/unused"), Buffer.alloc(32, 9));
  const put = await docs.put("tnt_x", new TextEncoder().encode("%PDF-1.4 secret"));
  const raw = await objectStoreFromEnv(env, "documents", "/unused").get(`tnt_x/${put.sha256.slice(0, 2)}/${put.sha256}`);
  assert.ok(!Buffer.from(raw).includes(Buffer.from("secret")), "stored encrypted");
  assert.equal(new TextDecoder().decode(await docs.get("tnt_x", put.uri)), "%PDF-1.4 secret");
  await docs.dispose(put.uri);
  await assert.rejects(docs.get("tnt_x", put.uri));
  const audio = createObjectAudioStore(objectStoreFromEnv(env, "audio", "/unused"));
  const a = await audio.put(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await audio.get(a.uri)], [1, 2, 3]);
  assert.throws(() => objectStoreFromEnv({ RC_OBJECT_STORE: "s3" }, "seal", "/x"), /S3_ENDPOINT is required/);
  assert.throws(() => objectStoreFromEnv({ RC_OBJECT_STORE: "gcs" }, "seal", "/x"), /fs or s3/);
});

test("orphan cleanup removes old objects with no row, keeps live and recent ones", async () => {
  const seal = createFsObjectStore(join(dir, "gc-seal"));
  const live = "b2".repeat(32), orphan = "c3".repeat(32), young = "d4".repeat(32);
  await db.tx((tx) => tx.query(
    "INSERT INTO sealed_document (digest, kind, doc_id, doc_version, format, byte_size, storage_uri, created_at) VALUES ($1,'facts','x',1,'mdrl-facts/1',2,'file:///x',now())",
    [`mdrl:sha256:${live}`]));
  for (const h of [live, orphan, young]) await seal.put(`${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.json`, new Uint8Array([1]));
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const h of [live, orphan]) utimesSync(join(dir, "gc-seal", h.slice(0, 2), h.slice(2, 4), `${h}.json`), old, old);
  const r = await sweepOrphanSeals(db, seal, Date.now(), 3_600_000);
  assert.deepEqual(r.removed, [`${orphan.slice(0, 2)}/${orphan.slice(2, 4)}/${orphan}.json`]);
  assert.equal(r.checked, 2, "the recent object is not even checked");
  assert.equal(await seal.exists(`${live.slice(0, 2)}/${live.slice(2, 4)}/${live}.json`), true);
  assert.equal(await seal.exists(`${young.slice(0, 2)}/${young.slice(2, 4)}/${young}.json`), true);
  const docs = createFsObjectStore(join(dir, "gc-docs"));
  await docs.put(`tnt_y/${orphan.slice(0, 2)}/${orphan}`, new Uint8Array([1]));
  utimesSync(join(dir, "gc-docs", "tnt_y", orphan.slice(0, 2), orphan), old, old);
  assert.equal((await sweepOrphanDocuments(db, docs, Date.now(), 3_600_000)).removed.length, 1);
});
