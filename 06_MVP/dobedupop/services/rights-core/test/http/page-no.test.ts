import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { createUser, ensureSystemIdentities } from "../../src/platform/actor.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { registerParty } from "../../src/registry/service.ts";
import { tempBridge } from "../fixtures.ts";

// 목록 쪽 번호(3부-A PG2): ?page=&size=면 { items, page, size, total }, 없으면 기존 응답 그대로. 서버 필터는 쪽 번호와 함께 쓴다.
const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const app = buildServer({ db, ctx, clock, jobs: recordingJobs() });
after(async () => { await app.close(); await drop(); cleanup(); });
await db.tx(async (tx) => {
  const c0 = fixedClock("2026-01-01T00:00:00.000Z", 0);
  await ensureSystemIdentities(tx, c0);
  await tx.query("INSERT INTO tenant (tenant_id, tenant_type, name, created_at) VALUES ('tnt_lbl', 'LABEL', 'label', $1)", [c0.now()]);
  await registerParty(tx, c0, { partyId: "pty_lbl", partyType: "LABEL", displayName: "레이블", tenantId: "tnt_lbl" });
  for (let i = 1; i <= 12; i++) await registerParty(tx, c0, { partyId: `pty_w${String(i).padStart(2, "0")}`, partyType: "AUTHOR", displayName: `작가 ${i}` });
  await registerParty(tx, c0, { partyId: "pty_mem", partyType: "MEMBER", displayName: "멤버", tenantId: "tnt_platform_default" });
  await createUser(tx, c0, { userId: "usr_lbl", displayName: "label", roles: ["RIGHTS_EDITOR"], tenantId: "tnt_lbl" });
  await createUser(tx, c0, { userId: "usr_lbl2", displayName: "label 2", roles: ["EDITOR"], tenantId: "tnt_lbl" });
});
const json = async (method: "GET" | "POST", url: string, status: number, payload?: object): Promise<any> => {
  const r = await app.inject({ method, url, headers: { "x-actor": "usr_lbl" }, ...(payload === undefined ? {} : { payload }) });
  assert.equal(r.statusCode, status, `${method} ${url}: ${r.body}`);
  return r.json();
};
const T0 = "2026-01-01T00:00:00.000Z";
for (const [w, t] of [["wrk_a", "Alpha"], ["wrk_b", "Beta"]] as const) {
  await json("POST", "/portal/works", 201, { workId: w, title: t });
  await json("POST", "/portal/scopes", 201, { factsScopeId: `fsc_${w.slice(4)}`, workId: w });
}
// 작가 12명 → 확인 요청 12건(Alpha), 멤버 보이스 소유 1건(Beta).
for (let i = 1; i <= 12; i++) {
  const id = `pty_w${String(i).padStart(2, "0")}`;
  await json("POST", "/portal/claims", 201, { claimId: `c_a_${i}`, factsScopeId: "fsc_a", sourceId: "wrk_a", edge: "WRITTEN_BY", targetId: id, shareBps: i === 12 ? 10000 - 11 * 833 : 833, status: "ASSERTED", validFrom: T0 });
}
await json("POST", "/portal/voices", 201, { voiceId: "voc_mem", factsScopeId: "fsc_b", kind: "HUMAN" });
await json("POST", "/portal/claims", 201, { claimId: "c_b_own", factsScopeId: "fsc_b", sourceId: "voc_mem", edge: "OWNED_BY", targetId: "pty_mem", shareBps: 10000, status: "ASSERTED", validFrom: T0 });

const isPage = (r: any, page: number, size: number, total: number, n: number) => {
  assert.deepEqual([r.page, r.size, r.total, r.items.length], [page, size, total, n], JSON.stringify({ ...r, items: r.items.length }));
};

test("works overview: page response, name filter, status filter; without page the array stays", async () => {
  assert.ok(Array.isArray(await json("GET", "/portal/works/overview", 200)));
  isPage(await json("GET", "/portal/works/overview?page=1", 200), 1, 10, 2, 2);
  isPage(await json("GET", "/portal/works/overview?page=1&q=alp", 200), 1, 10, 1, 1);
  isPage(await json("GET", "/portal/works/overview?page=1&status=" + encodeURIComponent("확인 대기"), 200), 1, 10, 2, 2);
  isPage(await json("GET", "/portal/works/overview?page=1&status=" + encodeURIComponent("판매 중"), 200), 1, 10, 0, 0);
});

test("confirmations: pages of 10, scope and counterparty kind filters", async () => {
  assert.ok(Array.isArray(await json("GET", "/portal/confirmations", 200)));
  isPage(await json("GET", "/portal/confirmations?page=1", 200), 1, 10, 13, 10);
  isPage(await json("GET", "/portal/confirmations?page=2", 200), 2, 10, 13, 3);
  isPage(await json("GET", "/portal/confirmations?page=1&scope=fsc_b", 200), 1, 10, 1, 1);
  isPage(await json("GET", "/portal/confirmations?page=1&counterparty=MEMBER", 200), 1, 10, 1, 1);
  isPage(await json("GET", "/portal/confirmations?page=1&counterparty=AUTHOR&size=5", 200), 1, 5, 12, 5);
  await json("GET", "/portal/confirmations?page=0", 400);
});

test("consents, contracts, documents, validation issues, issues, users: page responses", async () => {
  isPage(await json("GET", "/portal/consents?page=1&scope=fsc_a", 200), 1, 10, 0, 0);
  isPage(await json("GET", "/portal/contracts?page=1&scope=fsc_a", 200), 1, 10, 0, 0);
  isPage(await json("GET", "/portal/documents?page=1", 200), 1, 10, 0, 0);
  const v = await json("GET", "/portal/validation-issues?page=1&scope=fsc_a", 200);
  assert.equal(v.page, 1);
  assert.ok(v.items.every((i: any) => i.scopeId === "fsc_a" && i.severity !== "INFO"));
  isPage(await json("GET", "/portal/issues?page=1", 200), 1, 10, 0, 0);
  const cursor = await json("GET", "/portal/issues", 200);
  assert.deepEqual(Object.keys(cursor).sort(), ["items", "next"], "cursor response unchanged");
  isPage(await json("GET", "/portal/users?page=1", 200), 1, 10, 2, 2);
  assert.deepEqual(Object.keys(await json("GET", "/portal/users", 200)).sort(), ["items", "next"]);
});
