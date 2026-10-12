import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { evaluate } from "mdrl/allocation";
import { evaluateGrant, type GrantRule, type Requirement } from "mdrl/grant";
import { createUser, ensureSystemIdentities, loadActor, type Actor } from "../platform/actor.ts";
import { fixedClock, type Clock } from "../platform/clock.ts";
import { createDb, type Db, type Tx } from "../platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../platform/dbadmin.ts";
import { startBossJobs, JOB_NAMES, type JobHandler, type JobName } from "../platform/jobs.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { sealInputs } from "../engine-bridge/settle.ts";
import * as reg from "../registry/service.ts";
import * as policy from "../policy/service.ts";
import * as issuance from "../issuance/service.ts";
import { ingestRevenue, type RevenueInput } from "../revenue/service.ts";
import { confirmBatch, createBatch, refundHook, revisionHook } from "../settlement/service.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { fakeProvider } from "../payout/fake-provider.ts";
import { payoutJobHandlers, recordWebhook } from "../payout/handlers.ts";
import { createPayoutRun, setPayoutProfile } from "../payout/service.ts";
import { partyStatement } from "../ledger/statements.ts";

/**
 * 가상 예시: 곡 "Dynamite"의 보컬 재배치 2차 이용(팬앱 전용)을 권리 등록부터 지급·명세까지 실제 코어로 돌린다.
 * 참여자·배분율·금액·구간은 모두 설명용 가정이며 실제 권리관계·계약과 무관하다.
 *
 *   node src/scenario/dynamite.ts [--out <디렉터리>]   (docker compose up -d 필요)
 */

const T0 = "2026-01-01T00:00:00.000Z";
const SCOPE = "fsc_dynamite";
const PACK = "pak_dynamite_fan";
const RECORDING = "rcd_dynamite";
const VOCALISTS = ["a", "b", "c", "d"] as const;
const SLOTS = [
  { id: "slt_verse1", label: "1절", startMs: 0, endMs: 40000 },
  { id: "slt_pre", label: "프리코러스", startMs: 40000, endMs: 60000 },
  { id: "slt_chorus", label: "후렴", startMs: 60000, endMs: 100000 },
  { id: "slt_bridge", label: "브리지", startMs: 100000, endMs: 140000 },
] as const;
const PRICE = 3300n;

export const NAMES: Record<string, string> = {
  pty_label: "레이블 L (마스터 보유)",
  pty_author_1: "작가 W1 (작사·작곡 50%)",
  pty_author_2: "작가 W2 (작사·작곡 50%)",
  pty_cmo: "저작권 신탁단체 C (W1 위임)",
  pty_agency: "보컬리스트 D의 소속사 G",
  pty_vocal_a: "보컬리스트 A",
  pty_vocal_b: "보컬리스트 B",
  pty_vocal_c: "보컬리스트 C",
  pty_vocal_d: "보컬리스트 D",
};

/** 권리 생성 시 권리자가 정하는 분배 규칙(MDRL 정책). 분배율은 가정이다. */
export const POLICY_TEXT = `allocation "pol_dynamite_fan" version 1 {
  uses facts "${SCOPE}"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: ${PACK}; events: [PRIMARY, TRAFFIC]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) : 40%;
      work = graph(WORK_AUTHOR) via mandate : 15%;
      agency = contract(pty_agency) : 5% as AGENCY;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
`;

/** 팬 조합 3개: 슬롯마다 보컬리스트 한 명. 멤버 비율 = 맡은 슬롯 수 × 2500 bps. */
export const COMBINATIONS = [
  { vcId: "vc_dyn_001", fan: "팬 F1", picks: ["a", "b", "c", "d"], purchases: 300 },
  { vcId: "vc_dyn_002", fan: "팬 F2", picks: ["a", "a", "b", "b"], purchases: 150 },
  { vcId: "vc_dyn_003", fan: "팬 F3", picks: ["c", "d", "d", "c"], purchases: 90 },
] as const;

async function seed(tx: Tx, clock: Clock, rights: Actor): Promise<void> {
  const parties: [string, reg.PartyType][] = [
    ["pty_label", "LABEL"], ["pty_author_1", "AUTHOR"], ["pty_author_2", "AUTHOR"], ["pty_cmo", "CMO"], ["pty_agency", "AGENCY"],
    ...VOCALISTS.map((v): [string, reg.PartyType] => [`pty_vocal_${v}`, "ARTIST"]),
  ];
  for (const [id, t] of parties) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: NAMES[id]! });
  await reg.registerWork(tx, clock, { workId: "wrk_dynamite", title: "Dynamite" });
  await reg.createScope(tx, clock, { factsScopeId: SCOPE, workId: "wrk_dynamite" });
  await reg.registerRecording(tx, clock, { recordingId: RECORDING, workId: "wrk_dynamite", masterOwnerPartyId: "pty_label", versionTitle: "Vocal Recombination" });
  let sort = 1;
  for (const s of SLOTS) await reg.registerSlot(tx, { slotId: s.id, recordingId: RECORDING, startMs: s.startMs, endMs: s.endMs, sortOrder: sort++ });
  await reg.registerSlot(tx, { slotId: "slt_mr", recordingId: RECORDING, startMs: 0, endMs: 199000, sortOrder: sort });
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: RECORDING, rightsBearing: false });
  const base = { factsScopeId: SCOPE, status: "VERIFIED" as const, validFrom: T0 };
  for (const v of VOCALISTS) {
    await reg.registerVoice(tx, clock, { voiceId: `vo_${v}`, factsScopeId: SCOPE, kind: "HUMAN" });
    for (const s of SLOTS) {
      const stemId = `stm_${v}_${s.id}`;
      await reg.registerStem(tx, clock, { stemId, slotId: s.id, recordingId: RECORDING, performerPartyId: `pty_vocal_${v}`, rightsBearing: true });
      await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${v}_${s.id}`, sourceId: stemId, edge: "PERFORMED_BY", targetId: `vo_${v}`, shareBps: 10000, performerRole: "FEATURED" });
    }
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${v}`, sourceId: `vo_${v}`, edge: "OWNED_BY", targetId: `pty_vocal_${v}`, shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: RECORDING, edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_work_1", sourceId: "wrk_dynamite", edge: "WRITTEN_BY", targetId: "pty_author_1", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_work_2", sourceId: "wrk_dynamite", edge: "WRITTEN_BY", targetId: "pty_author_2", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_1", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_agency", fromPartyId: "pty_vocal_d", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 });
  await issuance.createPack(tx, clock, rights, { packId: PACK, packCode: "DYNAMITE-FAN", title: "Dynamite 팬앱 전용 보컬 조합", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, rights, PACK, [
    { role: "AGENCY", party: "pty_agency" }, { role: "CMO", party: "pty_cmo" }, { role: "MASTER_OWNER", party: "pty_label" },
    ...VOCALISTS.map((v) => ({ role: "PERFORMER_FEATURED", party: `pty_vocal_${v}` })),
    { role: "WORK_AUTHOR", party: "pty_author_1" }, { role: "WORK_AUTHOR", party: "pty_author_2" },
  ]);
}

/** 팬앱 전용 이용허락(가정): 권리자·보컬리스트가 허락한 범위와 세 가지 이용 요청의 판정. */
function grantDemo() {
  const scope = (actions: string[], media: string[], audience: string[]) =>
    ({ actions, territories: ["KR"], media, audience, period: { from: T0, to: "2027-01-01T00:00:00.000Z" } });
  const fanOnly = scope(["PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK"], ["FAN_APP"], ["FAN_COMMUNITY"]);
  const rule = (id: string, grantor: string, asset: string, right: string, status: GrantRule["status"] = "VERIFIED"): GrantRule =>
    ({ id, grantor, asset, right_type: right, scope: fanOnly, status, valid: { from: T0 }, recorded_at: T0 });
  const grants: GrantRule[] = [
    rule("g_master", "pty_label", RECORDING, "MASTER"),
    rule("g_work", "pty_cmo", "wrk_dynamite", "WORK"),
    ...VOCALISTS.map((v) => rule(`g_consent_${v}`, `pty_vocal_${v}`, `vo_${v}`, "PERFORMER")),
  ];
  const reqs = (picks: readonly string[], s: ReturnType<typeof scope>): Requirement[] => [
    { id: "r_master", asset: RECORDING, right_type: "MASTER", scope: s },
    { id: "r_work", asset: "wrk_dynamite", right_type: "WORK", scope: s },
    ...[...new Set(picks)].map((v) => ({ id: `r_vocal_${v}`, asset: `vo_${v}`, right_type: "PERFORMER", scope: s })),
  ];
  const at = { as_of: "2026-03-10T00:00:00.000Z", known_at: "2026-03-10T00:00:00.000Z" };
  const listen = scope(["PREVIEW", "COMBINE"], ["FAN_APP"], ["FAN_COMMUNITY"]);
  const download = scope(["DOWNLOAD"], ["EXTERNAL_SNS"], ["PUBLIC"]);
  const show = (case_: string, d: ReturnType<typeof evaluateGrant>) => ({ case: case_, result: d.result, reasons: [...d.reason_codes] });
  return [
    show("팬앱에서 vc_dyn_001 조합·감상", evaluateGrant({ requirements: reqs(COMBINATIONS[0].picks, listen), grants, ...at })),
    show("같은 조합을 다운로드해 외부 SNS에 게시", evaluateGrant({ requirements: reqs(COMBINATIONS[0].picks, download), grants, ...at })),
    show("보컬리스트 D가 동의를 철회한 뒤 vc_dyn_001 조합·감상",
      evaluateGrant({ requirements: reqs(COMBINATIONS[0].picks, listen), grants: grants.map((g) => (g.id === "g_consent_d" ? { ...g, status: "REVOKED" as const } : g)), ...at })),
  ];
}

async function waitQueue(db: Db, name: JobName, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await db.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = ANY('{created,retry,active}'::pgboss.job_state[])", [name])).rows[0].n as number;
    if (n === 0) return;
    if (Date.now() > deadline) throw new Error(`${name} did not drain`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

const rows = async (db: Db, sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;

export async function runDynamite(db: Db, appUrl: string, blobRoot: string) {
  const ctx = createBridgeCtx(createFsBlobStore(blobRoot));
  const c0 = fixedClock(T0, 0);
  const u = await db.tx(async (tx) => {
    const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"],
      ["ops", "SPACE_OPS"], ["settle", "SPACE_SETTLE"], ["accounts", "SPACE_SETTLE"]] as const;
    const out: Record<string, Actor> = {};
    for (const [name, role] of spec) {
      await createUser(tx, c0, { userId: `usr_${name}`, displayName: name, roles: [role] });
      out[name] = await loadActor(tx, `usr_${name}`);
    }
    await ensureSystemIdentities(tx, c0);
    out.ingest = await loadActor(tx, "sys_ingest");
    return out;
  });

  // 1. 권리 생성: 곡·녹음·슬롯·보컬 스템·권리 주장·위임 등록, 팬앱 전용 팩.
  await db.tx((tx) => seed(tx, c0, u.rights!));
  // 2. 권리자 승인: 정책 작성(EDITOR) → 승인(WORK_APPROVER) → 활성화(ACTIVATOR), 팩 활성화.
  const c1 = fixedClock("2026-02-01T00:00:00.000Z", 1);
  const compiled = await db.tx((tx) => policy.compilePolicy(ctx, tx, c1, u.editor!, { policyId: "pol_dynamite_fan", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, c1, u.approver!, compiled));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, c1, u.activator!, compiled));
  await db.tx((tx) => issuance.activatePack(ctx, tx, c1, u.activator!, PACK));
  const active = (await db.tx((tx) => policy.activePolicyForPack(tx, PACK)))!;

  // 3. 이용허락 판정(팬앱 전용 범위).
  const grants = grantDemo();

  // 4. 팬 조합 발행: 게이트 통과 → 스냅샷 동결·발행 봉인.
  const c2 = fixedClock("2026-02-15T00:00:00.000Z", 1);
  const seals: { vcId: string; fan: string; members: Record<string, number>; snapshotId: string; projectionDigest: string }[] = [];
  for (const cb of COMBINATIONS) {
    const members: Record<string, number> = {};
    for (const v of cb.picks) members[`pty_vocal_${v}`] = (members[`pty_vocal_${v}`] ?? 0) + 2500;
    const seal = await db.tx((tx) => issuance.issue(ctx, tx, c2, u.issuer!, {
      packId: PACK, vcId: cb.vcId, members,
      assignments: [...SLOTS.map((s, k) => ({ slotId: s.id, stemId: `stm_${cb.picks[k]}_${s.id}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
    }));
    seals.push({ vcId: cb.vcId, fan: cb.fan, members, snapshotId: seal.snapshotId, projectionDigest: seal.projectionDigest });
  }
  const rejected = await db.tx((tx) => issuance.issue(ctx, tx, c2, u.issuer!, {
    packId: PACK, vcId: "vc_dyn_solo", members: { pty_vocal_a: 10000 },
    assignments: [...SLOTS.map((s) => ({ slotId: s.id, stemId: `stm_a_${s.id}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
  })).then(() => "ISSUED", (e: unknown) => (e as { code?: string }).code ?? String(e));

  // 5. 매출(3월): 조합 소장 구매(PRIMARY). vc_dyn_003의 1건은 이상거래 의심(FLAGGED).
  const settleClock = fixedClock("2026-04-01T00:00:00.000Z", 1);
  const jobs = await startBossJobs(appUrl, { batchSize: 20, localConcurrency: 4 });
  const provider = fakeProvider({ outcome: () => "PAID" });
  try {
    const d = { db, ctx, clock: settleClock, jobs };
    const handlers = { ...jobHandlers(d), ...payoutJobHandlers({ db, clock: settleClock, jobs, provider, pollDelaySeconds: 1 }) };
    for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
    await jobs.work(handlers as Record<JobName, JobHandler>);
    const onRefund = refundHook(jobs), onRevision = revisionHook(jobs);
    const ingest = (i: RevenueInput) => db.tx((tx) => ingestRevenue(tx, settleClock, u.ingest!, i, onRefund, onRevision));
    let k = 0;
    for (const cb of COMBINATIONS) {
      for (let i = 0; i < cb.purchases; i++, k++) {
        const id = `ev_${cb.vcId.slice(3)}_${String(i + 1).padStart(4, "0")}`;
        await ingest({
          eventId: id, sourceSystem: "fan_app", sourceEventId: id, eventType: "PURCHASE", vcId: cb.vcId, amountKrw: PRICE.toString(), currency: "KRW",
          integrity: cb.vcId === "vc_dyn_003" && i === 0 ? "FLAGGED" : "CLEAR",
          occurredAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + k * 60_000).toISOString(),
        });
      }
    }
    await jobs.drainIdle(600_000);

    // 6. 정산: 배치 생성(SPACE_OPS) → 엔진 평가·봉인 → 독립 재계산 검증 → 확정(SPACE_SETTLE) → 원장 반영.
    await createBatch(d, u.ops!, { batchId: "bat_dyn_2026_03", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
    await jobs.drainIdle(600_000);
    const runStatus = await rows(db, "SELECT status, count(*)::int AS n FROM settlement_run WHERE batch_id = 'bat_dyn_2026_03' GROUP BY status");
    await confirmBatch(d, u.settle!, "bat_dyn_2026_03");
    await jobs.drainIdle(600_000);

    // 7. 확정 후 환불: vc_dyn_001의 첫 구매를 전액 환불 → 역분개.
    await ingest({ eventId: "ev_rf_0001", sourceSystem: "fan_app", sourceEventId: "ev_rf_0001", eventType: "REFUND", relatedEventId: "ev_dyn_001_0001",
      amountKrw: PRICE.toString(), currency: "KRW", occurredAt: "2026-04-10T00:00:00.000Z" });
    await jobs.drainIdle(600_000);

    // 8. 지급: 권리자 프로필(1월 등록, 계좌 토큰은 지급 실행자와 다른 사용자가 등록) → 지급 실행 → PSP webhook.
    const payClock = fixedClock("2026-05-01T00:00:00.000Z", 1);
    const payDeps = { db, clock: payClock, jobs };
    const payees = (await rows(db, "SELECT party_id FROM ledger_account WHERE kind = 'PARTY_PAYABLE' ORDER BY party_id")).map((r) => r.party_id as string);
    await db.tx(async (tx) => {
      for (const p of payees) {
        const corp = ["pty_label", "pty_cmo", "pty_agency"].includes(p);
        await setPayoutProfile(tx, c0, u.accounts!, { partyId: p, taxType: corp ? "DOMESTIC_CORP" : "DOMESTIC_INDIVIDUAL", payoutAccountRef: `tok_${p}`, kycVerified: true });
      }
    });
    await jobs.stop();
    const jobs2 = await startBossJobs(appUrl, { batchSize: 20, localConcurrency: 4 });
    try {
      const d2 = { db, ctx, clock: payClock, jobs: jobs2 };
      const h2 = { ...jobHandlers(d2), ...payoutJobHandlers({ db, clock: payClock, jobs: jobs2, provider, pollDelaySeconds: 1 }) };
      await jobs2.work(h2 as Record<JobName, JobHandler>);
      const run = await createPayoutRun(payDeps as never, u.settle!, { payoutRunId: "pay-2026-05", asOf: payClock.now() });
      await waitQueue(db, "submit-payout", 600_000);
      for (const r of await rows(db, "SELECT idempotency_key FROM payout_instruction WHERE payout_run_id = 'pay-2026-05' AND submit_attempted_at IS NOT NULL ORDER BY instruction_id")) {
        await db.tx((tx) => recordWebhook(tx, payClock, jobs2, { ...provider.webhook(r.idempotency_key as string), payload: { source: "dynamite" } }));
      }
      await jobs2.drainIdle(600_000);

      // 9. 감상 매출(TRAFFIC): 코어 수집은 아직 구매·재판매·환불만 받으므로, 같은 발행 봉인 입력으로 엔진을 직접 호출한다.
      const traffic = await db.tx(async (tx) => {
        const s = await sealInputs(ctx, tx, seals[0]!.snapshotId);
        return evaluate({ policy: s.policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, runId: "sim_traffic_2026_03",
          events: [{ id: "ev_traffic_2026_03_vc_dyn_001", type: "TRAFFIC", amount: "12000", currency: "KRW", integrity: "CLEAR" }] });
      });

      // 10. 보고서.
      const firstEvent = "ev_dyn_001_0001";
      const report = {
        assumptions: { price: PRICE.toString(), slots: SLOTS, names: NAMES, policyText: POLICY_TEXT, combinations: COMBINATIONS },
        policy: { policyId: active.policyId, version: active.version, factsDigest: active.factsDigest, policyDigest: active.policyDigest },
        grants,
        issued: seals, rejectedSolo: rejected,
        revenue: await rows(db, "SELECT vc_id, event_type, integrity_status, count(*)::int AS n, sum(net_amount_krw)::text AS krw FROM revenue_event GROUP BY 1,2,3 ORDER BY 1,2,3"),
        runStatus,
        runs: await rows(db, "SELECT r.run_id, rs.vc_id, r.status, r.result_digest FROM settlement_run r JOIN rights_snapshot rs ON rs.snapshot_id = r.snapshot_id WHERE r.batch_id = 'bat_dyn_2026_03' ORDER BY rs.vc_id"),
        firstEvent: {
          eventId: firstEvent,
          pool: await rows(db, "SELECT bucket, amount_krw::text AS krw FROM pool_line WHERE event_id = $1 AND line_seq = 1 ORDER BY amount_krw DESC, bucket", [firstEvent]),
          lines: await rows(db, "SELECT party_id, role, bucket, amount_krw::text AS krw FROM allocation_line WHERE event_id = $1 AND line_seq = 1 ORDER BY amount_krw DESC, party_id", [firstEvent]),
        },
        byParty: await rows(db, `SELECT l.party_id, l.role, sum(l.amount_krw) FILTER (WHERE l.line_seq = 1)::text AS settled_krw, COALESCE(sum(l.amount_krw) FILTER (WHERE l.line_seq > 1), 0)::text AS reversed_krw
                                 FROM allocation_line l JOIN settlement_run r USING (run_id) WHERE r.batch_id = 'bat_dyn_2026_03' GROUP BY 1,2 ORDER BY 3 DESC`),
        pools: await rows(db, `SELECT p.bucket, sum(p.amount_krw)::text AS krw FROM pool_line p JOIN settlement_run r USING (run_id) WHERE r.batch_id = 'bat_dyn_2026_03' GROUP BY 1 ORDER BY 2 DESC`),
        holdings: await rows(db, "SELECT event_id, bucket, reason, amount_krw::text AS krw FROM unallocated_holding ORDER BY event_id, line_seq"),
        reversals: await rows(db, "SELECT reversal_id, original_run_id, event_id, refund_event_id, result_digest FROM reversal_run ORDER BY reversal_id"),
        journal: await rows(db, "SELECT kind, count(*)::int AS n FROM journal_entry GROUP BY kind ORDER BY kind"),
        payout: { counts: run.counts, instructions: await rows(db, "SELECT party_id, status, gross_krw::text, withholding_krw::text, net_krw::text, hold_reason FROM payout_instruction ORDER BY gross_krw DESC") },
        statements: await db.tx(async (tx) => Promise.all(payees.map((p) => partyStatement(tx, p, T0, payClock.now())))),
        traffic: traffic.ok
          ? { ok: true, pool: traffic.value.pool_lines, lines: traffic.value.lines, holdings: traffic.value.holdings, resultDigest: traffic.value.result_digest }
          : { ok: false, errors: traffic.errors },
      };
      return report;
    } finally {
      await jobs2.stop();
    }
  } finally {
    await jobs.stop().catch(() => {});
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const fresh = await createFreshDatabase(ADMIN_URL);
  const db = createDb(fresh.appUrl);
  const blobRoot = mkdtempSync(join(tmpdir(), "rc-dynamite-"));
  try {
    const report = await runDynamite(db, fresh.appUrl, blobRoot);
    const json = JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    if (values.out !== undefined) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, "dynamite-report.json"), json + "\n");
    }
    console.log(json);
  } finally {
    await db.close();
    await fresh.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  }
}
