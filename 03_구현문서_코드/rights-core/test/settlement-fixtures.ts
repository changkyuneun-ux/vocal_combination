import type { Actor } from "../src/platform/actor.ts";
import { createUser, ensureSystemIdentities, loadActor } from "../src/platform/actor.ts";
import { fixedClock, type Clock } from "../src/platform/clock.ts";
import type { Db } from "../src/platform/db.ts";
import type { BridgeCtx } from "../src/engine-bridge/context.ts";
import type { IssueSeal } from "../src/engine-bridge/issue.ts";
import * as policy from "../src/policy/service.ts";
import * as issuance from "../src/issuance/service.ts";
import { ingestRevenue, noRefundHook } from "../src/revenue/service.ts";
import { recordingJobs } from "../src/platform/jobs.ts";
import { confirmBatch, createBatch, refundHook, type SettleDeps } from "../src/settlement/service.ts";
import { jobHandlers } from "../src/settlement/handlers.ts";
import { releaseHold } from "../src/settlement/holds.ts";
import { suggestFraudRelease } from "../src/engine-bridge/fraud-release.ts";
import { createPayoutRun, setPayoutProfile } from "../src/payout/service.ts";
import { fakeProvider } from "../src/payout/fake-provider.ts";
import { payoutJobHandlers } from "../src/payout/handlers.ts";
import type { PayoutProvider } from "../src/payout/provider.ts";
import { freshDb } from "./helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "./fixtures.ts";

export type SettlementWorld = {
  db: Db; adminUrl: string; ctx: BridgeCtx; clock: Clock;
  users: Record<"rights" | "editor" | "approver" | "activator" | "issuer" | "ops" | "settle" | "ingest", Actor>;
  drop(): Promise<void>;
};

/** 정산 가능한 세계: 곡·정책·팩이 활성이고, 정산 역할 사용자와 시스템 신원이 있다. 정책 events는 [PRIMARY]. */
export async function settlementWorld(): Promise<SettlementWorld> {
  const { db, adminUrl, drop } = await freshDb();
  const { ctx, cleanup } = tempBridge();
  const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
  const base = fixedClock(T0, 0);
  const users = await db.tx(async (tx) => {
    await seedSong(tx, base);
    const u = await seedUsers(tx, base);
    for (const [id, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"]] as const) {
      await createUser(tx, base, { userId: id, displayName: id, roles: [role] });
    }
    await ensureSystemIdentities(tx, base);
    await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
    await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
    return { ...u, ops: await loadActor(tx, "usr_ops"), settle: await loadActor(tx, "usr_settle"), ingest: await loadActor(tx, "sys_ingest") };
  });
  await db.tx(async (tx) => {
    const r = await policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT });
    await policy.approvePolicy(ctx, tx, clock, users.approver, r);
    await policy.activatePolicy(ctx, tx, clock, users.activator, r);
    await issuance.activatePack(ctx, tx, clock, users.activator, PACK);
  });
  return { db, adminUrl, ctx, clock, users, async drop() { await drop(); cleanup(); } };
}

export async function issueCombo(w: SettlementWorld, vcId: string, a: "a" | "b" = "a", b: "a" | "b" = "b"): Promise<IssueSeal> {
  return w.db.tx((tx) => issuance.issue(w.ctx, tx, w.clock, w.users.issuer, {
    packId: PACK, vcId,
    assignments: [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }],
    members: a === b ? { [`pty_member_${a}`]: 10000 } : { [`pty_member_${a}`]: 5000, [`pty_member_${b}`]: 5000 },
  }));
}

export async function purchase(
  w: SettlementWorld, eventId: string, vcId: string, amountKrw: string, occurredAt = "2026-03-01T10:00:00.000Z", integrity: "CLEAR" | "FLAGGED" = "CLEAR",
): Promise<void> {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId, sourceSystem: "app", sourceEventId: eventId, eventType: "PURCHASE", vcId, amountKrw, currency: "KRW", occurredAt, integrity,
  }, noRefundHook));
}

export type LedgerPhase = "settled" | "released" | "reversed" | "paid" | "repaid";
/** 원장 흐름의 단계별 시계 시작 시각(분개 occurred_at은 이 시각부터 1ms씩 흐른다). */
export const LEDGER_PHASE_AT: Record<LedgerPhase, string> = {
  settled: "2026-03-10T00:00:00.000Z", released: "2026-04-10T00:00:00.000Z", reversed: "2026-04-20T00:00:00.000Z",
  paid: "2026-06-01T00:00:00.000Z", repaid: "2026-07-01T00:00:00.000Z",
};

/**
 * 확정 → 보류 해제 → 역분개(해제 후·해제 전·보류 없음) → 지급(pty_member_b 실패) → 재지급까지 도는 원장 흐름.
 * 단계가 끝날 때마다 onPhase를 부른다. vc_1이 발행돼 있어야 한다.
 */
export async function ledgerFlow(w: SettlementWorld, onPhase: (phase: LedgerPhase) => Promise<void> = async () => {}): Promise<void> {
  const jobs = recordingJobs();
  const deps = (phase: LedgerPhase): SettleDeps => ({ db: w.db, ctx: w.ctx, clock: fixedClock(LEDGER_PHASE_AT[phase], 1), jobs });
  const profileClock = fixedClock("2026-01-01T00:00:00.000Z", 0);

  const dS = deps("settled");
  await purchase(w, "ev_c", "vc_1", "1000000");
  await purchase(w, "ev_f", "vc_1", "100000", "2026-03-02T00:00:00.000Z", "FLAGGED");
  await purchase(w, "ev_g", "vc_1", "50000", "2026-03-03T00:00:00.000Z", "FLAGGED");
  await createBatch(dS, w.users.ops, { batchId: "bat_mar", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  await jobs.drain(jobHandlers(dS));
  await confirmBatch(dS, w.users.settle, "bat_mar");
  await jobs.drain(jobHandlers(dS));
  await onPhase("settled");

  const dR = deps("released");
  const hold = (await w.db.pool.query("SELECT holding_id::text AS id FROM unallocated_holding WHERE event_id = 'ev_f' AND line_seq = 1")).rows[0].id as string;
  const s = await w.db.tx((tx) => suggestFraudRelease(w.ctx, tx, hold));
  await releaseHold(dR, w.users.settle, { holdingId: hold, allocation: s.allocation });
  await onPhase("released");

  const dV = deps("reversed");
  for (const [id, rel, amt] of [["rf_f", "ev_f", "40000"], ["rf_c", "ev_c", "100000"], ["rf_g", "ev_g", "10000"]] as const) {
    await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
      eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId: rel, amountKrw: amt, currency: "KRW", occurredAt: "2026-04-05T00:00:00.000Z",
    }, refundHook(jobs)));
  }
  await jobs.drain(jobHandlers(dV));
  await onPhase("reversed");

  for (const [partyId, taxType] of [["pty_member_a", "DOMESTIC_INDIVIDUAL"], ["pty_member_b", "DOMESTIC_INDIVIDUAL"], ["pty_label", "EXEMPT"], ["pty_agency", "EXEMPT"],
    ["pty_cmo", "EXEMPT"], ["pty_author_b", "EXEMPT"], ["pty_author_c", "EXEMPT"]] as const) {
    await w.db.tx((tx) => setPayoutProfile(tx, profileClock, w.users.settle, { partyId, taxType, payoutAccountRef: `tok_${partyId}`, kycVerified: true }));
  }
  const base = fakeProvider();
  const failB: PayoutProvider = {
    submit: (i, key) => (i.partyId === "pty_member_b" ? Promise.resolve({ status: "FAILED", reason: "TEST_REJECT" }) : base.submit(i, key)),
    status: (ref, key) => base.status(ref, key),
  };
  const pay = async (phase: LedgerPhase, runId: string, provider: PayoutProvider) => {
    const clock = fixedClock(LEDGER_PHASE_AT[phase], 1);
    const p = { db: w.db, clock, jobs, provider };
    await createPayoutRun(p, w.users.settle, { payoutRunId: runId, asOf: clock.now() });
    await jobs.drain(payoutJobHandlers(p));
  };
  await pay("paid", "po-jun", failB);
  await onPhase("paid");
  await pay("repaid", "po-jul", base);
  await onPhase("repaid");
}
