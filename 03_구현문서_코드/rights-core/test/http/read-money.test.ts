import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fixedClock, type Clock } from "../../src/platform/clock.ts";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { payoutJobHandlers } from "../../src/payout/handlers.ts";
import { fakeProvider } from "../../src/payout/fake-provider.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
const jobs = recordingJobs();
let cur: Clock = fixedClock("2026-03-10T00:00:00.000Z", 1);
const clock: Clock = { now: () => cur.now() };
const provider = fakeProvider();
const SECRET = "s3cret";
const app = buildServer({ db: w.db, ctx: w.ctx, clock, jobs, provider, pspSecret: SECRET });
after(async () => { await app.close(); await w.drop(); });

const get = (url: string, actor: string | null = "usr_settle") =>
  app.inject({ method: "GET", url, headers: actor === null ? {} : { "x-actor": actor } });
const ok = async (url: string, actor: string = "usr_settle"): Promise<any> => {
  const r = await get(url, actor);
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  return r.json();
};
const post = (url: string, actor: string, payload: unknown) => app.inject({ method: "POST", url, headers: { "x-actor": actor }, payload: payload as object });
const put = (url: string, actor: string, payload: unknown) => app.inject({ method: "PUT", url, headers: { "x-actor": actor }, payload: payload as object });
const settleDeps = () => ({ db: w.db, ctx: w.ctx, clock, jobs });
const payDeps = () => ({ db: w.db, clock, jobs, provider });
const PARTIES = ["pty_member_a", "pty_member_b", "pty_label", "pty_agency", "pty_cmo", "pty_author_b", "pty_author_c"];

// 준비: 매출 2건(하나 FLAGGED) -> 배치 -> 확정 -> 보류 해제 -> 프로필 -> 지급 실행 -> submit 처리 -> webhook
await issueCombo(w, "vc_1");
await purchase(w, "ev_c", "vc_1", "1000000");
await purchase(w, "ev_f", "vc_1", "100000", "2026-03-02T00:00:00.000Z", "FLAGGED");
assert.equal((await post("/batches", "usr_ops", { batchId: "bat_m", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" })).statusCode, 201);
await jobs.drain(jobHandlers(settleDeps()));
assert.equal((await post("/batches/bat_m/confirm", "usr_settle", {})).statusCode, 200);
await jobs.drain(jobHandlers(settleDeps()));
const holdIds = (await w.db.pool.query("SELECT holding_id::int AS id FROM unallocated_holding WHERE event_id = 'ev_f' ORDER BY holding_id")).rows.map((r) => r.id as number);
const relHold = holdIds[0]!;
const sug = await get(`/holds/${relHold}/suggestion`);
assert.equal(sug.statusCode, 200, sug.body);
assert.equal((await post(`/holds/${relHold}/release`, "usr_settle", { allocation: sug.json().allocation })).statusCode, 200);
cur = fixedClock("2026-04-10T00:00:00.000Z", 1);
for (const p of PARTIES) {
  const r = await put(`/parties/${p}/payout-profile`, "usr_settle2", { taxType: p.startsWith("pty_member") ? "DOMESTIC_INDIVIDUAL" : "EXEMPT", payoutAccountRef: `tok_${p}`, kycVerified: true });
  assert.equal(r.statusCode, 200, r.body);
}
cur = fixedClock("2026-06-01T00:00:00.000Z", 1);
const prun = await post("/payout-runs", "usr_settle", { payoutRunId: "po-1", asOf: "2026-06-01T00:00:00.000Z" });
assert.equal(prun.statusCode, 201, prun.body);
await jobs.drain({ "submit-payout": payoutJobHandlers(payDeps())["submit-payout"]! });
const pending = prun.json().instructions.filter((i: any) => i.status === "PENDING");
const target = pending[0].instructionId as string;
const hook = await app.inject({ method: "POST", url: "/psp/webhook", headers: { "x-psp-secret": SECRET }, payload: provider.webhook(`payout:${target}`) });
assert.equal(hook.statusCode, 201, hook.body);
await jobs.drain(payoutJobHandlers(payDeps()));
// 격리와 이른 시각 매출(정렬·커서 검증용): 직접 넣는다.
const snap = (await w.db.pool.query("SELECT snapshot_id FROM rights_snapshot WHERE vc_id = 'vc_1'")).rows[0].snapshot_id as string;
await w.db.pool.query("INSERT INTO quarantine (snapshot_id, reason, diagnostics, created_at) VALUES ($1,'TEST','[]'::jsonb,$2)", [snap, "2026-03-05T00:00:00.000Z"]);

const paged = async (url: string, limit = 1, actor = "usr_settle"): Promise<any[]> => {
  const out: any[] = [];
  let after: string | null = null;
  const sep = url.includes("?") ? "&" : "?";
  for (let i = 0; i < 100; i++) {
    const j: any = await ok(`${url}${sep}limit=${limit}${after === null ? "" : `&after=${after}`}`, actor);
    assert.ok(j.items.length <= limit);
    out.push(...j.items);
    if (j.next === null) return out;
    after = j.next;
  }
  throw new Error("paging did not end");
};
const samePaged = async (url: string, actor = "usr_settle") => {
  const full = await ok(`${url}${url.includes("?") ? "&" : "?"}limit=200`, actor);
  assert.equal(full.next, null);
  assert.deepEqual(await paged(url, 1, actor), full.items, `${url}: paged by 1 equals full`);
  return full.items as any[];
};

test("401 without actor; 403 for the wrong role", async () => {
  const all = ["/revenue-events", "/revenue-events/ev_c/settlement", "/batches", "/batches/bat_m/runs", "/quarantine", "/holds", "/reversals",
    "/ledger/accounts", "/ledger/entries", "/ledger/entries/1", "/payout-policy", "/parties/pty_member_a/payout-profile", "/payout-runs",
    "/payout-runs/po-1/instructions", `/payouts/${target}`];
  for (const u of all) assert.equal((await get(u, null)).statusCode, 401, u);
  assert.equal((await get("/ledger/accounts", "usr_ops")).statusCode, 403);
  assert.equal((await get("/batches", "usr_issuer")).statusCode, 403);
  for (const u of all.slice(7)) assert.equal((await get(u, "usr_ops")).statusCode, 403, u);
  for (const u of all.slice(0, 7)) {
    assert.equal((await get(u, "usr_issuer")).statusCode, 403, u);
    assert.equal((await get(u, "usr_ops")).statusCode, 200, u);
  }
  // 매출 목록은 시스템 신원도 본다(수집 담당). 정산 쪽은 아니다.
  assert.equal((await get("/revenue-events", "sys_ingest")).statusCode, 200);
  assert.equal((await get("/batches", "sys_ingest")).statusCode, 403);
  assert.equal((await get("/revenue-events/ev_c/settlement", "sys_ingest")).statusCode, 403);
});

test("revenue events: fields, filters, order, supersededBy, paging", async () => {
  const items = await samePaged("/revenue-events");
  assert.deepEqual(Object.keys(items[0]).sort(), ["currency", "eventId", "eventType", "integrityStatus", "netAmountKrw", "occurredAt", "recordedAt",
    "relatedEventId", "sourceEventId", "sourceRevision", "sourceSystem", "supersededBy", "vcId"]);
  const c = items.find((e) => e.eventId === "ev_c");
  assert.deepEqual(c, { eventId: "ev_c", sourceSystem: "app", sourceEventId: "ev_c", sourceRevision: 1, eventType: "PURCHASE", vcId: "vc_1", relatedEventId: null,
    netAmountKrw: "1000000", currency: "KRW", integrityStatus: "CLEAR", occurredAt: "2026-03-01T10:00:00.000Z", recordedAt: c.recordedAt, supersededBy: null });
  assert.equal(items.find((e) => e.eventId === "ev_f").integrityStatus, "FLAGGED");
  const rec = items.map((e) => e.recordedAt);
  assert.deepEqual(rec, [...rec].sort().reverse());
  assert.equal((await ok("/revenue-events?type=PURCHASE")).items.length, 2);
  assert.equal((await ok("/revenue-events?type=REFUND")).items.length, 0);
  assert.equal((await ok("/revenue-events?vc=vc_1")).items.length, 2);
  assert.equal((await ok("/revenue-events?vc=nope")).items.length, 0);
  assert.equal((await get("/revenue-events?type=")).statusCode, 400);
  assert.equal((await get("/revenue-events?limit=0")).statusCode, 400);
  assert.equal((await get("/revenue-events?after=@@")).json().code, "BAD_CURSOR");
  assert.equal((await get(`/revenue-events?after=${Buffer.from(JSON.stringify([1])).toString("base64url")}`)).json().code, "BAD_CURSOR");
});

test("superseded revenue event shows supersededBy", async () => {
  await w.db.pool.query("INSERT INTO revenue_event (event_id, source_system, source_event_id, source_revision, event_type, vc_id, net_amount_krw, currency, occurred_at, recorded_at) VALUES ('ev_c2','app','ev_c',2,'PURCHASE','vc_1',1000000,'KRW','2026-03-01T10:00:00.000Z','2026-03-11T00:00:00.000Z')");
  await w.db.pool.query("INSERT INTO revenue_supersede (old_event_id, new_event_id, recorded_at) VALUES ('ev_c','ev_c2','2026-03-11T00:00:00.000Z')");
  const items = (await ok("/revenue-events?limit=200")).items;
  assert.equal(items.find((e: any) => e.eventId === "ev_c").supersededBy, "ev_c2");
  assert.equal(items.find((e: any) => e.eventId === "ev_c2").supersededBy, null);
  assert.equal(items[0].eventId, "ev_c2", "latest recorded_at first");
});

test("revenue event settlement status", async () => {
  const s = await ok("/revenue-events/ev_c/settlement", "usr_ops");
  assert.deepEqual(Object.keys(s).sort(), ["refunds", "reversals", "runs"]);
  assert.equal(s.runs.length, 1);
  assert.deepEqual(Object.keys(s.runs[0]).sort(), ["batchId", "runId", "status"]);
  assert.equal(s.runs[0].batchId, "bat_m");
  assert.equal(s.runs[0].status, "CONFIRMED");
  assert.deepEqual([s.reversals, s.refunds], [[], []]);
  assert.equal((await get("/revenue-events/nope/settlement")).statusCode, 404);
});

test("batches: runCounts, status filter, runs list", async () => {
  const b = await ok("/batches");
  assert.equal(b.items.length, 1);
  const x = b.items[0];
  assert.deepEqual(Object.keys(x).sort(), ["batchId", "batchManifestDigest", "confirmedAt", "confirmedBy", "createdAt", "executedBy", "periodEnd", "periodStart", "runCounts", "status"]);
  assert.equal(x.status, "CONFIRMED");
  assert.equal(x.executedBy, "usr_ops");
  assert.equal(x.confirmedBy, "usr_settle");
  assert.equal(x.periodStart, "2026-03-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(x.runCounts).sort(), ["CALCULATED", "CONFIRMED", "FAILED", "PENDING", "VERIFIED", "VOIDED"]);
  assert.equal(x.runCounts.CONFIRMED, 1);
  assert.equal(Object.values(x.runCounts).reduce((a: number, n: any) => a + n, 0), 1);
  assert.equal((await ok("/batches?status=OPEN")).items.length, 0);
  assert.equal((await ok("/batches?status=CONFIRMED")).items.length, 1);
  assert.equal((await ok("/batches?status=CONFIRMED")).items[0].runCounts.CONFIRMED, 1, "filter does not distort counts");

  const runs = await samePaged("/batches/bat_m/runs");
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0]).sort(), ["batchId", "createdAt", "diagnostics", "eventCount", "eventsDigest", "executedBy", "resultDigest", "runId", "snapshotId", "status", "verifiedAt", "verifiedBy"]);
  assert.equal(runs[0].eventCount, 2);
  assert.equal(runs[0].status, "CONFIRMED");
  assert.equal((await ok("/batches/bat_m/runs?status=FAILED")).items.length, 0);
  assert.equal((await get("/batches/nope/runs")).statusCode, 404);
});

test("quarantine: open filter", async () => {
  const q = await samePaged("/quarantine");
  assert.equal(q.length, 1);
  assert.deepEqual(Object.keys(q[0]).sort(), ["createdAt", "diagnostics", "quarantineId", "reason", "releasedAt", "releasedBy", "snapshotId"]);
  assert.deepEqual([q[0].reason, q[0].diagnostics, q[0].releasedAt, q[0].releasedBy], ["TEST", [], null, null]);
  assert.equal((await ok("/quarantine?open=true")).items.length, 1);
  assert.equal((await ok("/quarantine?open=false")).items.length, 0);
  assert.equal((await get("/quarantine?open=maybe")).statusCode, 400);
});

test("holds: release info, filters, order", async () => {
  const h = await samePaged("/holds");
  assert.equal(h.length, holdIds.length);
  assert.deepEqual(h.map((x) => x.holdingId), [...holdIds].sort((a, b) => b - a));
  assert.deepEqual(Object.keys(h[0]).sort(), ["amountKrw", "bucket", "eventId", "holdingId", "lineSeq", "reason", "release", "reversalId", "runId", "status"]);
  const rel = h.find((x) => x.holdingId === relHold);
  assert.equal(typeof rel.amountKrw, "string");
  assert.deepEqual(Object.keys(rel.release).sort(), ["releaseId", "releasedAt", "releasedBy"]);
  assert.equal(rel.release.releasedBy, "usr_settle");
  assert.equal(rel.status, "HELD");
  assert.equal(h.filter((x) => x.release === null).length, holdIds.length - 1);
  assert.equal((await ok("/holds?status=HELD")).items.length, holdIds.length);
  assert.equal((await ok("/holds?status=NOPE")).items.length, 0);
  assert.equal((await ok("/holds?reason=FRAUD_REVIEW")).items.length, holdIds.length);
  assert.equal((await ok("/holds?reason=RIGHTS_DISPUTE")).items.length, 0);
  assert.equal((await ok("/holds?reason=FRAUD_REVIEW")).items.find((x: any) => x.holdingId === relHold).release.releaseId > 0, true);
});

test("reversals: empty list is a valid page", async () => {
  assert.deepEqual(await ok("/reversals"), { items: [], next: null });
});

test("ledger accounts: balance strings sum to zero", async () => {
  const items = await samePaged("/ledger/accounts");
  assert.ok(items.length > 0);
  assert.deepEqual(Object.keys(items[0]).sort(), ["accountId", "balance", "bucket", "kind", "partyId", "reason"]);
  assert.ok(items.every((a) => typeof a.balance === "string" && /^-?[0-9]+$/.test(a.balance)));
  assert.equal(items.reduce((s, a) => s + BigInt(a.balance), 0n), 0n);
  const ids = items.map((a) => a.accountId);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  const tb = await ok("/ledger/trial-balance");
  for (const t of tb.accounts) assert.equal(items.find((a) => a.accountId === t.accountId).balance, t.balance);
  assert.ok(items.find((a) => a.accountId === "PARTY_PAYABLE:pty_member_a"));
});

test("ledger entries: total, filters, order, detail", async () => {
  const items = await samePaged("/ledger/entries");
  assert.deepEqual(Object.keys(items[0]).sort(), ["createdBy", "entryId", "kind", "occurredAt", "sourceRef", "total"]);
  const ids = items.map((e) => e.entryId);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  const kinds = new Set(items.map((e) => e.kind));
  for (const k of ["SETTLEMENT", "HOLD_RELEASE", "PAYOUT"]) assert.ok(kinds.has(k), k);
  for (const e of items) {
    const d = await ok(`/ledger/entries/${e.entryId}`);
    assert.equal(d.entryId, e.entryId);
    assert.equal(d.total, e.total);
    assert.equal(d.postings.reduce((s: bigint, p: any) => s + BigInt(p.amountKrw), 0n), 0n, "entry balances");
    assert.equal(d.postings.filter((p: any) => BigInt(p.amountKrw) > 0n).reduce((s: bigint, p: any) => s + BigInt(p.amountKrw), 0n).toString(), e.total);
  }
  const d = await ok(`/ledger/entries/${ids[0]}`);
  assert.deepEqual(Object.keys(d).sort(), ["createdBy", "entryId", "kind", "occurredAt", "postings", "sourceRef", "total"]);
  assert.deepEqual(Object.keys(d.postings[0]).sort(), ["accountId", "amountKrw", "eventId", "postingId", "runId"]);
  const pids = d.postings.map((p: any) => p.postingId);
  assert.deepEqual(pids, [...pids].sort((a: number, b: number) => a - b));

  const settlement = (await ok("/ledger/entries?kind=SETTLEMENT&limit=200")).items;
  assert.ok(settlement.length > 0 && settlement.every((e: any) => e.kind === "SETTLEMENT"));
  const byAcct = (await ok("/ledger/entries?account=PARTY_PAYABLE:pty_member_a&limit=200")).items;
  assert.ok(byAcct.length > 0 && byAcct.length < items.length);
  // 필터는 total을 줄이지 않는다.
  for (const e of byAcct) assert.equal(e.total, items.find((x) => x.entryId === e.entryId).total);
  const byParty = (await ok("/ledger/entries?party=pty_member_a&limit=200")).items;
  assert.deepEqual(byParty.map((e: any) => e.entryId), byAcct.map((e: any) => e.entryId));
  assert.equal((await ok("/ledger/entries?party=nope")).items.length, 0);
  assert.equal((await ok("/ledger/entries?kind=SETTLEMENT&party=pty_member_a")).items.length > 0, true);
  assert.equal((await get("/ledger/entries/nope")).statusCode, 404);
  assert.equal((await get("/ledger/entries/999999")).statusCode, 404);
});

test("payout policy and profile", async () => {
  const p = await ok("/payout-policy");
  assert.deepEqual(p, { policyId: "default", minPayoutKrw: "10000", initialHoldDays: 30, taxBps: { DOMESTIC_INDIVIDUAL: 330, DOMESTIC_CORP: 0, FOREIGN: 2200, EXEMPT: 0 }, accountCoolingHours: 72 });
  const pr = await ok("/parties/pty_member_a/payout-profile");
  assert.deepEqual(Object.keys(pr).sort(), ["accountChangedAt", "accountChangedBy", "coolingUntil", "firstPayableAt", "kycVerified", "partyId", "payoutAccountRef", "taxType", "updatedAt"]);
  assert.equal(pr.payoutAccountRef, "tok_pty_member_a");
  assert.equal(pr.accountChangedAt, "2026-04-10T00:00:00.000Z");
  assert.equal(pr.coolingUntil, "2026-04-13T00:00:00.000Z");
  assert.equal((await get("/parties/pty_nope/payout-profile")).statusCode, 404);
});

test("payout runs and instructions", async () => {
  const runs = await samePaged("/payout-runs");
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0]).sort(), ["asOf", "createdAt", "createdBy", "payoutRunId", "statusCounts"]);
  assert.equal(runs[0].payoutRunId, "po-1");
  assert.deepEqual(Object.keys(runs[0].statusCounts).sort(), ["CARRIED", "FAILED", "HELD", "PAID", "PENDING", "SUBMITTED"]);
  const ins = await samePaged("/payout-runs/po-1/instructions");
  assert.equal(ins.length, prun.json().instructions.length);
  assert.equal(Object.values(runs[0].statusCounts).reduce((a: number, n: any) => a + n, 0), ins.length);
  for (const [k, n] of Object.entries(runs[0].statusCounts)) assert.equal(ins.filter((i) => i.status === k).length, n, k);
  assert.deepEqual(Object.keys(ins[0]).sort(), ["createdAt", "decidedAccountRef", "entryId", "grossKrw", "holdReason", "idempotencyKey", "instructionId", "netKrw", "partyId",
    "payoutRunId", "providerRef", "settledEntryId", "status", "submitAttemptedAt", "submitUnknownAt", "submittedAccountRef", "withholdingKrw"]);
  assert.ok(ins.every((i) => typeof i.grossKrw === "string" && typeof i.withholdingKrw === "string" && typeof i.netKrw === "string"));
  const ids = ins.map((i) => i.instructionId);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal((await ok("/payout-runs/po-1/instructions?status=PAID")).items.every((i: any) => i.status === "PAID"), true);
  assert.equal((await ok("/payout-runs/po-1/instructions?status=NOPE")).items.length, 0);
  assert.equal((await get("/payout-runs/nope/instructions")).statusCode, 404);
});

test("payout detail: webhooks and audit", async () => {
  const d = await ok(`/payouts/${target}`);
  assert.equal(d.instructionId, target);
  assert.equal(d.status, provider.webhook(`payout:${target}`).status);
  assert.equal(d.webhooks.length, 1);
  assert.deepEqual(Object.keys(d.webhooks[0]).sort(), ["payload", "processedAt", "providerEventId", "providerRef", "receivedAt", "status"]);
  assert.equal(d.webhooks[0].providerRef, d.providerRef);
  assert.notEqual(d.webhooks[0].processedAt, null);
  assert.ok(Array.isArray(d.audit));
  const dbAudit = (await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1", [target])).rows[0].n as number;
  assert.equal(d.audit.length, dbAudit);
  if (d.audit.length > 0) assert.deepEqual(Object.keys(d.audit[0]).sort(), ["action", "actor", "after", "auditId", "entityId", "entityType", "occurredAt"]);
  const other = prun.json().instructions.find((i: any) => i.instructionId !== target && i.status === "PENDING");
  const o = await ok(`/payouts/${other.instructionId}`);
  assert.equal(o.webhooks.length, 0);
  assert.equal((await get("/payouts/po_nope")).statusCode, 404);
  // 조회는 감사 로그를 쓰지 않는다.
  const before = (await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n as number;
  await ok("/ledger/accounts");
  await ok(`/payouts/${target}`);
  assert.equal((await w.db.pool.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n, before);
});

test("existing routes still work", async () => {
  assert.equal((await get("/batches/bat_m")).statusCode, 200);
  assert.equal((await get("/ledger/trial-balance")).json().sum, "0");
  assert.equal((await get("/settlement/invariants")).statusCode, 200);
});
