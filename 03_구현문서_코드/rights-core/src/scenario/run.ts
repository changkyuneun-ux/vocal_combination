import { performance } from "node:perf_hooks";
import { createUser, loadActor, type Actor } from "../platform/actor.ts";
import { fixedClock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { processOutbox } from "../platform/outbox.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { sealFacts } from "../engine-bridge/facts.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import * as policy from "../policy/service.ts";
import * as issuance from "../issuance/service.ts";
import { closeDispute, openDispute } from "../registry/disputes.ts";
import { mulberry32 } from "./prng.ts";
import { SONG, seedSyntheticSong } from "./synthetic-song.ts";

export type ScenarioReport = {
  issued: number; p50Ms: number; p95Ms: number; maxMs: number; totalMs: number;
  /** 서로 다른 투영 digest 수(as_of가 발행마다 달라 issued와 같아야 한다). */
  distinctProjections: number;
  /** 서로 다른 (vectors, paths) 조합 수 = 실질적으로 다른 조합 수(멤버 3명·슬롯 4개면 최대 81). */
  distinctVectorSets: number;
  auditMismatches: number; factsRederiveOk: boolean; disputeFlowOk: boolean;
};

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function users(db: Db): Promise<Record<"rights" | "editor" | "approver" | "activator" | "issuer", Actor>> {
  const c = fixedClock("2026-01-01T00:00:00.000Z", 0);
  const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"]] as const;
  return db.tx(async (tx) => {
    const out: Record<string, Actor> = {};
    for (const [name, role] of spec) {
      await createUser(tx, c, { userId: `usr_${name}`, displayName: name, roles: [role] });
      out[name] = await loadActor(tx, `usr_${name}`);
    }
    return out as never;
  });
}

/** 한 조합: 슬롯마다 멤버 한 명을 고르고, 멤버 비율 = 맡은 슬롯 수 × 2500 bps. */
function combination(rand: () => number, i: number) {
  const picks = SONG.slots.map(() => SONG.members[Math.floor(rand() * SONG.members.length)]!);
  const members: Record<string, number> = {};
  for (const m of picks) members[`pty_member_${m}`] = (members[`pty_member_${m}`] ?? 0) + 2500;
  return {
    packId: SONG.pack,
    vcId: `vc_${String(i).padStart(6, "0")}`,
    assignments: [...SONG.slots.map((s, k) => ({ slotId: s.id, stemId: `stm_${picks[k]}_${s.id}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
    members,
  };
}

/**
 * 통합 설계 9.4 완료 기준을 한 번에 돌린다:
 * 합성 곡 등록 → 정책 컴파일·승인·활성화 → 팩 활성화 → n 조합 발행(지연 측정) → 전수 재도출 → facts 재봉인 대조 → 분쟁·재고정 흐름.
 */
export async function runScenario(deps: { db: Db; ctx: BridgeCtx }, opts: { n: number; seed: number }): Promise<ScenarioReport> {
  const { db, ctx } = deps;
  const u = await users(db);
  await db.tx((tx) => seedSyntheticSong(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), u.rights));
  const clock = fixedClock("2026-02-01T00:00:00.000Z", 1);
  const compiled = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, u.editor, { policyId: "pol_nova_summer", packId: SONG.pack, sourceText: SONG.policyText }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, u.approver, compiled));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, u.activator, compiled));
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, u.activator, SONG.pack));

  const rand = mulberry32(opts.seed);
  const times: number[] = [];
  const started = performance.now();
  for (let i = 0; i < opts.n; i++) {
    const input = combination(rand, i);
    const t0 = performance.now();
    await db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer, input));
    times.push(performance.now() - t0);
  }
  const totalMs = performance.now() - started;
  times.sort((a, b) => a - b);

  const fresh = createBridgeCtx(ctx.blobs);
  let auditMismatches = 0;
  const snaps = (await db.pool.query("SELECT snapshot_id FROM issue_seal ORDER BY snapshot_id")).rows.map((r) => r.snapshot_id as string);
  for (const s of snaps) {
    const r = await db.tx((tx) => rederiveIssue(fresh, tx, s));
    if (!r.ok) auditMismatches++;
  }
  const distinctProjections = (await db.pool.query("SELECT count(DISTINCT projection_digest)::int AS n FROM issue_seal")).rows[0].n as number;
  const distinctVectorSets = (await db.pool.query(
    "SELECT count(DISTINCT (d.content->'vectors', d.content->'paths'))::int AS n FROM issue_seal s JOIN sealed_document d ON d.digest = s.projection_digest",
  )).rows[0].n as number;
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, SONG.pack));
  const resealed = await db.tx((tx) => sealFacts(fresh, tx, SONG.scope, active!.factsKnownAt));
  const factsRederiveOk = resealed.digest === active!.factsDigest;

  const disputeFlowOk = await disputeFlow(db, ctx, clock, u);
  return {
    issued: snaps.length, p50Ms: pct(times, 50), p95Ms: pct(times, 95), maxMs: times[times.length - 1]!, totalMs,
    distinctProjections, distinctVectorSets, auditMismatches, factsRederiveOk, disputeFlowOk,
  };
}

/** 분쟁 → 자동 일시정지·발행 거부 → 종결 → 가벼운 재고정 → 재활성화 → 발행(통합 설계 9.4). */
async function disputeFlow(db: Db, ctx: BridgeCtx, clock: ReturnType<typeof fixedClock>, u: Record<string, Actor>): Promise<boolean> {
  const expectCode = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
      return false;
    } catch (e) {
      return e instanceof DomainError && e.code === code;
    }
  };
  const input = { packId: SONG.pack, vcId: "vc_dispute", assignments: SONG.slots.map((s) => ({ slotId: s.id, stemId: `stm_b_${s.id}` })), members: { pty_member_b: 10000 } };
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_scenario", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "scenario" }));
  await processOutbox(db, issuance.OUTBOX_HANDLERS, clock);
  const paused = (await db.pool.query("SELECT status FROM vocal_pack WHERE pack_id = $1", [SONG.pack])).rows[0].status === "PAUSED";
  const refused = await expectCode(db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer!, input)), "PACK_NOT_ACTIVE");
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_scenario" }));
  await db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, u.activator!, "pol_nova_summer"));
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, u.activator!, SONG.pack));
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer!, input));
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, SONG.pack));
  return paused && refused && seal.factsDigest === active!.factsDigest;
}
