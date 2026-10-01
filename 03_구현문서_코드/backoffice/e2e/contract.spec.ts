import type { APIRequestContext } from "@playwright/test";
import { api, expect, ok, poll, prepareSettled, test, type Settled } from "./fixtures.ts";
import * as K from "../src/api/keys.ts";

const DECIMAL = /^-?\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Obj = Record<string, unknown>;
type Paged = { items: Obj[]; next: string | null };

/** 필수 키가 모두 있고(null 값도 허용), 금액 키는 10진 문자열이며, 응답 키가 camelCase인지 본다. */
function check(label: string, value: unknown, keys: readonly string[], amountKeys: readonly string[] = [], camel = true): Obj {
  expect(value, `${label}: 객체여야 한다`).toBeTruthy();
  const o = value as Obj;
  for (const k of keys) expect(Object.hasOwn(o, k), `${label}: 키 ${k} 없음(응답 키: ${Object.keys(o).join(", ")})`).toBe(true);
  for (const k of amountKeys) {
    expect(typeof o[k], `${label}.${k}: 금액은 문자열이어야 한다(값 ${JSON.stringify(o[k])})`).toBe("string");
    expect(o[k] as string, `${label}.${k}`).toMatch(DECIMAL);
  }
  if (camel) for (const k of Object.keys(o)) expect(k, `${label}: camelCase가 아닌 키`).toMatch(/^[a-z][A-Za-z0-9]*$/);
  return o;
}

function checkPaged(label: string, body: unknown): Paged {
  const p = body as Paged;
  expect(Array.isArray(p?.items), `${label}: items 배열`).toBe(true);
  expect(p.next === null || typeof p.next === "string", `${label}: next는 문자열 또는 null`).toBe(true);
  return p;
}

/** 목록의 첫 항목을 검사한다. 비어 있을 수 있는 목록은 optional로 건너뛴다. */
function checkList(label: string, body: unknown, keys: readonly string[], amountKeys: readonly string[] = [], optional = false): Obj | undefined {
  const p = checkPaged(label, body);
  if (p.items.length === 0) {
    expect(optional, `${label}: 항목이 있어야 한다`).toBe(true);
    return undefined;
  }
  return check(`${label}[0]`, p.items[0], keys, amountKeys);
}

const get = <T = unknown>(request: APIRequestContext, actor: string, path: string) => ok<T>(request, actor, "GET", path);

test.describe("API 계약(types.ts ↔ rights-core)", () => {
  let s: Settled;
  let instructionId = "";
  let payoutRunId = "";
  let profiled: string[] = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    s = await prepareSettled(request);

    // 분쟁: 정산 뒤에 곡 작사 권리 주장을 분쟁으로 연다(열린 분쟁 1건).
    await ok(request, "usr_editor", "POST", "/disputes", { disputeId: "dsp_e2e_1", targetType: "RIGHT_CLAIM", targetId: "c_lyrics", reason: "e2e contract" });
    // 역분개: 확정 뒤 환불(sys_ingest) → 역분개가 생길 때까지.
    await ok(request, "sys_ingest", "POST", "/revenue-events", {
      eventId: "ev_e2e_rf1", sourceSystem: "app", sourceEventId: "ev_e2e_rf1", eventType: "REFUND", relatedEventId: s.eventIds[0], amountKrw: "5000",
      currency: "KRW", occurredAt: "2026-04-02T00:00:00.000Z",
    });
    await poll("역분개", async () => (await get<Paged>(request, "usr_ops", "/reversals")).items, (xs) => xs.length > 0);

    // 지급: 권리자 프로필(계좌 토큰) → 30일 뒤 → 지급 실행 → 지시가 생길 때까지.
    const balances = (await get<Paged>(request, "usr_settle", "/ledger/accounts?limit=200")).items
      .filter((a) => a.partyId !== null && BigInt(a.balance as string) !== 0n).map((a) => a.partyId as string);
    expect(balances.length, "잔액이 있는 권리자").toBeGreaterThan(0);
    profiled = balances;
    for (const partyId of balances) {
      await ok(request, "usr_settle", "PUT", `/parties/${partyId}/payout-profile`, { taxType: "DOMESTIC_INDIVIDUAL", kycVerified: true, payoutAccountRef: `tok_${partyId}` });
    }
    await ok(request, null, "POST", "/dev/clock/advance", { ms: 31 * 24 * 3_600_000 });
    const now = (await ok<{ now: string }>(request, null, "GET", "/dev/clock")).now;
    payoutRunId = "por-e2e-1";
    await ok(request, "usr_settle2", "POST", "/payout-runs", { payoutRunId, asOf: now });
    const list = await poll(
      "지급 지시",
      async () => (await get<Paged>(request, "usr_settle", `/payout-runs/${payoutRunId}/instructions?limit=200`)).items,
      (xs) => xs.length > 0,
    );
    instructionId = list[0]!.instructionId as string;
  });

  test("플랫폼: users, dev/clock", async ({ request }) => {
    checkList("/users", await get(request, "usr_ops", "/users"), K.USER_KEYS);
    check("/me", await get(request, "usr_ops", "/me"), K.USER_KEYS);
    checkList("/audit", await get(request, "usr_ops", "/audit"), K.AUDIT_KEYS);
    check("/dev/clock", await ok(request, null, "GET", "/dev/clock"), K.CLOCK_KEYS);
  });

  test("등록: parties, works, scopes, facts, disputes", async ({ request }) => {
    checkList("/parties", await get(request, "usr_editor", "/parties"), K.PARTY_KEYS);
    checkList("/parties?type=MEMBER", await get(request, "usr_editor", "/parties?type=MEMBER"), K.PARTY_KEYS);
    checkList("/works", await get(request, "usr_editor", "/works"), K.WORK_KEYS);
    check("/scopes/:id", await get(request, "usr_editor", `/scopes/${s.factsScopeId}`), K.SCOPE_KEYS);
    const facts = check("/scopes/:id/facts", await get(request, "usr_editor", `/scopes/${s.factsScopeId}/facts`), K.SCOPE_FACTS_KEYS);
    const parts: [string, readonly string[]][] = [
      ["recordings", K.RECORDING_KEYS], ["slots", K.SLOT_KEYS], ["stems", K.STEM_KEYS], ["voices", K.VOICE_KEYS],
      ["claims", K.CLAIM_KEYS], ["mandates", K.MANDATE_KEYS],
    ];
    for (const [name, keys] of parts) {
      const xs = facts[name] as unknown[];
      expect(xs.length, `facts.${name}`).toBeGreaterThan(0);
      check(`facts.${name}[0]`, xs[0], keys);
    }
    expect(Array.isArray(facts.disputes)).toBe(true);
    checkList("/disputes", await get(request, "usr_editor", "/disputes"), K.DISPUTE_KEYS);
  });

  test("정책: policies, versions, version detail", async ({ request }) => {
    checkList("/policies", await get(request, "usr_editor", "/policies"), K.POLICY_ROW_KEYS);
    checkList("/policies?pack", await get(request, "usr_editor", `/policies?pack=${s.packId}`), K.POLICY_ROW_KEYS);
    checkList("/policies/:id/versions", await get(request, "usr_editor", `/policies/${s.policyId}/versions`), K.POLICY_VERSION_KEYS);
    const d = check("/policies/:id/versions/1", await get(request, "usr_editor", `/policies/${s.policyId}/versions/1`), K.POLICY_VERSION_DETAIL_KEYS);
    const approvals = d.approvals as Obj[];
    expect(approvals.length).toBeGreaterThan(0);
    check("approvals[0]", approvals[0], ["userId", "role", "at"]);
  });

  test("발행: packs, issues, issue audit, seals", async ({ request }) => {
    checkList("/packs", await get(request, "usr_issuer", "/packs"), K.PACK_ROW_KEYS);
    const pack = check("/packs/:id", await get(request, "usr_issuer", `/packs/${s.packId}`), K.PACK_DETAIL_KEYS);
    check("pack.claimants[0]", (pack.claimants as Obj[])[0], ["partyId", "claimantRole"]);
    check("pack.activePolicy", pack.activePolicy, ["policyId", "version"]);
    const issue = checkList("/issues", await get(request, "usr_issuer", "/issues"), K.ISSUE_ROW_KEYS)!;
    checkList("/issues?pack&vc", await get(request, "usr_issuer", `/issues?pack=${s.packId}&vc=${s.vcIds[0]}`), K.ISSUE_ROW_KEYS);
    const audit = check("/issues/:id/audit", await get(request, "usr_issuer", `/issues/${issue.snapshotId}/audit`), K.ISSUE_AUDIT_KEYS);
    const expected = check("audit.expected", audit.expected, ["snapshotId", "factsDigest", "policyDigest", "projectionDigest", "membersDigest", "asOf", "knownAt"]);
    check("audit.recomputed", audit.recomputed, ["projectionDigest", "membersDigest"]);
    expect(await get(request, "usr_issuer", `/seals/${expected.projectionDigest}`)).toBeTruthy();
    expect(await get(request, "usr_issuer", `/seals/${expected.membersDigest}`)).toBeTruthy();
  });

  test("매출: revenue-events, event settlement", async ({ request }) => {
    const row = checkList("/revenue-events", await get(request, "usr_ops", "/revenue-events"), K.REVENUE_EVENT_KEYS, K.REVENUE_EVENT_AMOUNT_KEYS)!;
    expect(row.occurredAt as string).toMatch(ISO);
    checkList("/revenue-events?type&vc", await get(request, "usr_ops", `/revenue-events?type=PURCHASE&vc=${s.vcIds[0]}`), K.REVENUE_EVENT_KEYS, K.REVENUE_EVENT_AMOUNT_KEYS);
    const es = check("/revenue-events/:id/settlement", await get(request, "usr_ops", `/revenue-events/${s.eventIds[0]}/settlement`), K.EVENT_SETTLEMENT_KEYS);
    check("settlement.runs[0]", (es.runs as Obj[])[0], ["runId", "batchId", "status"]);
    for (const r of es.reversals as Obj[]) check("settlement.reversals[]", r, ["reversalId", "createdAt"]);
    for (const r of es.refunds as Obj[]) check("settlement.refunds[]", r, ["eventId", "netAmountKrw"], ["netAmountKrw"]);
  });

  test("정산: batches, runs, quarantine, holds, reversals", async ({ request }) => {
    const b = checkList("/batches", await get(request, "usr_ops", "/batches"), K.BATCH_ROW_KEYS)!;
    check("batch.runCounts", b.runCounts, ["PENDING", "CALCULATED", "VERIFIED", "FAILED", "VOIDED", "CONFIRMED"], [], false);
    checkList("/batches?status", await get(request, "usr_ops", `/batches?status=${b.status}`), K.BATCH_ROW_KEYS);
    const view = check("/batches/:id", await get(request, "usr_ops", `/batches/${s.batchId}`), K.BATCH_VIEW_KEYS);
    check("batchView.runs[0]", (view.runs as Obj[])[0], ["runId", "status", "events"]);
    for (const x of view.skipped as Obj[]) check("batchView.skipped[]", x, ["eventId", "reason"]);
    checkList("/batches/:id/runs", await get(request, "usr_ops", `/batches/${s.batchId}/runs`), K.BATCH_RUN_KEYS);
    const run = check("/runs/:id", await get(request, "usr_ops", `/runs/${s.runIds[0]}`), K.RUN_DETAIL_KEYS);
    check("run.lines", run.lines, K.RUN_SUMS_KEYS, K.RUN_SUMS_KEYS);
    check("run.holdings", run.holdings, K.RUN_SUMS_KEYS, K.RUN_SUMS_KEYS);
    // 격리 행은 엔진 진단으로 run이 FAILED일 때만 생기고(settlement/quarantine.ts), 발행 사전 검사가 정산 불가 조합의 발행을 막으므로
    // API로 도달할 경로가 없다. 그래서 비어 있으면 건너뛰되 조용히 넘기지 않고 주석(annotation)으로 남긴다.
    const quarantine = await get<Paged>(request, "usr_ops", "/quarantine");
    if (quarantine.items.length === 0) {
      test.info().annotations.push({ type: "quarantine", description: "격리 행을 만들 수 있는 API 경로가 없어 /quarantine 키 검사를 건너뜀(행 없음)" });
    }
    checkList("/quarantine", quarantine, K.QUARANTINE_KEYS, [], true);
    checkList("/quarantine?open=true", await get(request, "usr_ops", "/quarantine?open=true"), K.QUARANTINE_KEYS, [], true);
    const hold = checkList("/holds", await get(request, "usr_ops", "/holds"), K.HOLD_KEYS, K.HOLD_AMOUNT_KEYS)!; // FLAGGED 구매가 FRAUD_REVIEW 보류를 만든다.
    {
      const sg = check("/holds/:id/suggestion", await get(request, "usr_settle", `/holds/${hold.holdingId}/suggestion`), K.HOLD_SUGGESTION_KEYS, K.HOLD_SUGGESTION_AMOUNT_KEYS);
      for (const [k, v] of Object.entries(sg.allocation as Obj)) expect(v, `suggestion.allocation.${k}`).toMatch(DECIMAL);
    }
    checkList("/reversals", await get(request, "usr_ops", "/reversals"), K.REVERSAL_KEYS);
    const inv = await get<Obj>(request, "usr_settle", "/settlement/invariants");
    expect(typeof inv).toBe("object");
  });

  test("원장: trial-balance, accounts, entries, entry detail", async ({ request }) => {
    const tb = check("/ledger/trial-balance", await get(request, "usr_settle", "/ledger/trial-balance"), K.TRIAL_BALANCE_KEYS, K.TRIAL_BALANCE_AMOUNT_KEYS);
    check("trialBalance.accounts[0]", (tb.accounts as Obj[])[0], ["accountId", "kind", "balance"], ["balance"]);
    checkList("/ledger/accounts", await get(request, "usr_settle", "/ledger/accounts"), K.LEDGER_ACCOUNT_KEYS, K.LEDGER_ACCOUNT_AMOUNT_KEYS);
    const entry = checkList("/ledger/entries", await get(request, "usr_settle", "/ledger/entries"), K.ENTRY_ROW_KEYS, K.ENTRY_ROW_AMOUNT_KEYS)!;
    checkList("/ledger/entries?kind", await get(request, "usr_settle", "/ledger/entries?kind=SETTLEMENT"), K.ENTRY_ROW_KEYS, K.ENTRY_ROW_AMOUNT_KEYS);
    const d = check("/ledger/entries/:id", await get(request, "usr_settle", `/ledger/entries/${entry.entryId}`), K.ENTRY_DETAIL_KEYS, ["total"]);
    check("entry.postings[0]", (d.postings as Obj[])[0], K.POSTING_KEYS, ["amountKrw"]);
  });

  test("지급: payout-policy, profile, runs, instructions, payout detail, statements", async ({ request }) => {
    const pol = check("/payout-policy", await get(request, "usr_settle", "/payout-policy"), K.PAYOUT_POLICY_KEYS, K.PAYOUT_POLICY_AMOUNT_KEYS);
    expect(typeof pol.initialHoldDays).toBe("number");
    const party = profiled[0]!; // 프로필을 만든 권리자
    check("/parties/:id/payout-profile", await get(request, "usr_settle", `/parties/${party}/payout-profile`), K.PAYOUT_PROFILE_KEYS);
    const pr = checkList("/payout-runs", await get(request, "usr_settle", "/payout-runs"), K.PAYOUT_RUN_KEYS)!;
    check("payoutRun.statusCounts", pr.statusCounts, ["PENDING", "SUBMITTED", "PAID", "FAILED", "CARRIED", "HELD"], [], false);
    checkList("/payout-runs/:id/instructions", await get(request, "usr_settle", `/payout-runs/${payoutRunId}/instructions`), K.INSTRUCTION_KEYS, K.INSTRUCTION_AMOUNT_KEYS);
    const d = check("/payouts/:id", await get(request, "usr_settle", `/payouts/${instructionId}`), K.INSTRUCTION_DETAIL_KEYS, K.INSTRUCTION_AMOUNT_KEYS);
    for (const w of d.webhooks as Obj[]) check("payout.webhooks[]", w, K.WEBHOOK_KEYS);
    for (const a of d.audit as Obj[]) check("payout.audit[]", a, K.AUDIT_KEYS);
    const to = (await ok<{ now: string }>(request, null, "GET", "/dev/clock")).now;
    const st = await api(request, "usr_settle", "GET", `/parties/${party}/statements?from=${encodeURIComponent("2026-01-01T00:00:00.000Z")}&to=${encodeURIComponent(to)}`);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    check("/parties/:id/statements", st.body, K.STATEMENT_KEYS, K.STATEMENT_AMOUNT_KEYS);
  });

  test("목록 공통: limit 범위와 커서", async ({ request }) => {
    const p = checkPaged("/ledger/entries?limit=1", await get(request, "usr_settle", "/ledger/entries?limit=1"));
    expect(p.items.length).toBe(1);
    expect(typeof p.next).toBe("string");
    const p2 = checkPaged("after", await get(request, "usr_settle", `/ledger/entries?limit=1&after=${encodeURIComponent(p.next as string)}`));
    expect(p2.items[0]?.entryId).not.toBe(p.items[0]?.entryId);
    for (const bad of ["0", "201", "x"]) expect((await api(request, "usr_settle", "GET", `/ledger/entries?limit=${bad}`)).status).toBe(400);
  });
});
