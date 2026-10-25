import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import * as reg from "../../src/registry/service.ts";
import { createFsDocumentStore } from "../../src/documents/store.ts";
import { settlementWorld } from "../settlement-fixtures.ts";
import { SCOPE } from "../fixtures.ts";

// 원천 문서를 곡에 묶는다(0048, 2026-10-24 곡 절차 정리): 원본 계약서는 그 곡의 문서, 조직 문서는 작품 공통.
// 근거 문서는 그 곡 문서나 작품 공통 문서만 — 다른 곡의 계약서를 근거로 연결하면 422 EVIDENCE_OTHER_SONG.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-docscope-"));
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-03-01T00:00:00.000Z", 1000), jobs: recordingJobs(), documents: createFsDocumentStore(dir, Buffer.alloc(32, 7)) });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await reg.registerWork(tx, c0, { workId: "wrk_other", title: "Other" });
  await reg.createScope(tx, c0, { factsScopeId: "fsc_other", workId: "wrk_other" });
});

const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);
const upload = (bytes: Buffer, meta: Record<string, string>) =>
  app.inject({ method: "POST", url: `/ops/documents?${new URLSearchParams(meta)}`, headers: { "x-actor": "usr_rights", "content-type": "application/pdf" }, payload: bytes });
const json = async (method: "GET" | "POST", url: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": "usr_rights" }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};

test("a document uploaded for a song belongs to it; without a song it is shared (organization); new versions keep the song", async () => {
  const song = await upload(pdf("nova master"), { documentId: "doc_nova_master", kind: "MASTER_CONTRACT", title: "Nova 녹음 계약서", parties: "pty_label", scope: SCOPE });
  assert.equal(song.statusCode, 201, song.body);
  assert.equal(song.json().versions[0].factsScopeId, SCOPE);
  assert.equal((await upload(pdf("other publishing"), { documentId: "doc_other_pub", kind: "PUBLISHING", title: "Other 퍼블리싱", parties: "pty_author_b", scope: "fsc_other" })).statusCode, 201);
  assert.equal((await upload(pdf("platform"), { documentId: "doc_platform", kind: "PLATFORM_CONTRACT", title: "플랫폼 이용계약", parties: "pty_label" })).json().versions[0].factsScopeId, null);
  assert.equal((await upload(pdf("x"), { kind: "EVIDENCE", title: "x", scope: "fsc_nope" })).statusCode, 404);
  const ids = async (q: string) => (await json("GET", `/ops/documents?${q}`, 200)).map((d: any) => d.documentId).sort();
  assert.deepEqual(await ids(`scope=${SCOPE}`), ["doc_nova_master"]);
  assert.deepEqual(await ids("scope=fsc_other"), ["doc_other_pub"]);
  assert.deepEqual(await ids("scope=none"), ["doc_platform"]);
  const v2 = await app.inject({ method: "POST", url: "/ops/documents/doc_nova_master/versions", headers: { "x-actor": "usr_rights", "content-type": "application/pdf" }, payload: pdf("nova master v2") });
  assert.equal(v2.statusCode, 201, v2.body);
  assert.equal(v2.json().versions[0].factsScopeId, SCOPE);
});

test("evidence must be a document of the same song (or a shared one); another song's contract is refused", async () => {
  const claim = (doc: string) => ({ claimId: "c_master", factsScopeId: SCOPE, sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000, status: "VERIFIED",
    validFrom: "2026-01-01T00:00:00.000Z", evidenceDocuments: [{ documentId: doc, version: 1 }] });
  assert.equal((await json("POST", "/ops/claims", 422, claim("doc_other_pub"))).code, "EVIDENCE_OTHER_SONG");
  await json("POST", "/ops/claims", 201, claim("doc_nova_master"));
  await json("POST", "/ops/claims", 201, claim("doc_platform"));
});

test("song progress ①~⑤ is computed from the data: the song's own contracts, registered and verified rights, licenses, release", async () => {
  const p = await json("GET", `/ops/scopes/${SCOPE}/progress`, 200);
  assert.deepEqual(p.steps.map((s: any) => s.label), ["원본 계약서", "권리 등록", "권리 확정", "이용 허락", "분배·출시"]);
  // 이 곡 원본 계약서는 녹음 계약서뿐(작품 계약서 없음) → ① 지금
  assert.deepEqual([p.steps[0].state, p.steps[0].note], ["now", "작품 계약서 없음"]);
  assert.deepEqual(p.steps.slice(1).map((s: any) => [s.done, s.note]), [[true, "작품·녹음·실연"], [true, "확정"], [true, p.steps[3].note], [true, "IR v1 · 판매 중"]]);
  assert.equal((await upload(pdf("nova publishing"), { documentId: "doc_nova_pub", kind: "PUBLISHING", title: "Nova 퍼블리싱", parties: "pty_author_b,pty_author_c", scope: SCOPE })).statusCode, 201);
  const after = await json("GET", `/ops/scopes/${SCOPE}/progress`, 200);
  assert.deepEqual(after.steps.map((s: any) => s.state), ["done", "done", "done", "done", "done"]);
  assert.equal(after.steps[0].note, "2건");
});
