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

// 작품 단위 묶음 목록(2026-10-24): 작품마다 요약 한 줄, 쪽 번호(10개)와 필터는 작품 요약 기준. 상세는 각 목록 API에 scope로.
const w = await settlementWorld();
const dir = mkdtempSync(join(tmpdir(), "rc-groups-"));
const app = buildServer({ db: w.db, ctx: w.ctx, clock: fixedClock("2026-03-01T00:00:00.000Z", 1000), jobs: recordingJobs(), documents: createFsDocumentStore(dir, Buffer.alloc(32, 5)) });
after(async () => { await app.close(); await w.drop(); rmSync(dir, { recursive: true, force: true }); });
await w.db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await reg.registerWork(tx, c0, { workId: "wrk_other", title: "Other" });
  await reg.createScope(tx, c0, { factsScopeId: "fsc_other", workId: "wrk_other" });
});
const json = async (url: string, status = 200, method: "GET" | "POST" = "GET", payload?: object): Promise<any> => {
  const r = await app.inject({ method, url: `/ops${url}`, headers: { "x-actor": "usr_rights" }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${url}: ${r.body}`);
  return r.json();
};
const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);

test("every work gets one summary row; pages are over works; filters keep only works with matching rows", async () => {
  // 작가 확인 요청 하나(Nova)
  await json("/claims", 201, "POST", { claimId: "c_lyrics", factsScopeId: SCOPE, sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS", status: "ASSERTED", validFrom: "2026-01-01T00:00:00.000Z" });
  const all = await json("/work-groups/confirmations");
  assert.deepEqual(all.items.map((g: any) => [g.title, g.summary.open, g.status[0]]), [["Nova", 1, "작가 서명 대기"], ["Other", 0, "요청 없음"]]);
  assert.equal(all.total, 2);
  const p2 = await json("/work-groups/confirmations?page=2&size=1");
  assert.deepEqual([p2.items.map((g: any) => g.title), p2.total, p2.page], [["Other"], 2, 2]);
  assert.deepEqual((await json("/work-groups/confirmations?status=OPEN")).items.map((g: any) => g.title), ["Nova"]);
  assert.deepEqual((await json("/work-groups/confirmations?counterparty=MEMBER")).items, []);
  // 상세는 기존 목록 API에 scope
  assert.equal((await json(`/confirmations?scope=${SCOPE}&page=1`)).total, 1);
  assert.equal((await json("/work-groups/nope", 404)).code, "NOT_FOUND");
});

test("documents: song groups plus an organization (shared) group; validation and contracts summaries", async () => {
  for (const [id, kind, scope] of [["doc_nova_m", "MASTER_CONTRACT", SCOPE], ["doc_org_p", "PLATFORM_CONTRACT", ""]] as const) {
    const r = await app.inject({ method: "POST", url: `/ops/documents?${new URLSearchParams({ documentId: id, kind, title: id, parties: "pty_label", ...(scope && { scope }) })}`,
      headers: { "x-actor": "usr_rights", "content-type": "application/pdf" }, payload: pdf(id) });
    assert.equal(r.statusCode, 201, r.body);
  }
  const docs = await json("/work-groups/documents");
  assert.deepEqual(docs.items.map((g: any) => [g.title, g.summary.originals]), [["Nova", 1], ["Other", 0], ["조직 문서(작품 공통)", 1]]);
  assert.equal(docs.items[2].scopeId, null);
  const v = await json("/work-groups/validation");
  assert.equal(v.items.length, 2);
  assert.ok(v.items.every((g: any) => Array.isArray(g.rules)));
  const c = await json("/work-groups/contracts?kind=confirm");
  assert.deepEqual(c.items, []);
});
