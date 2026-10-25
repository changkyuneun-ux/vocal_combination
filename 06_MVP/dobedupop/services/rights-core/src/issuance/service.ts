import { withSystemScope, type Actor } from "../platform/actor.ts";
import { assertOwnerTenantActive } from "../platform/tenants.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Db, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { checkPackActivation, type Declared } from "../engine-bridge/activation.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { decideIssueLicense, licenseDiagnostics, type Usage } from "../engine-bridge/grant.ts";

export type { Usage };
import { sealIssue, type IssueSeal } from "../engine-bridge/issue.ts";
import { preflightIssue } from "../engine-bridge/preflight.ts";
import { activePolicyForPack } from "../policy/service.ts";
import { notifyParty } from "../performer/notifications.ts";
import type { OutboxHandlers } from "../platform/outbox.ts";
import { invalidateDecisions } from "../decisions/cache.ts";
import { holdExposureForConsent } from "../exposure/service.ts";
import { assertActivationAllowed } from "../validation/service.ts";
import { requirePermission } from "../platform/permissions.ts";

export async function createPack(tx: Tx, clock: Clock, actor: Actor, p: { packId: string; packCode: string; title: string; factsScopeId: string }): Promise<void> {
  requirePermission(actor, "pack.edit");
  await tx.query("INSERT INTO vocal_pack (pack_id, pack_code, title, facts_scope_id, created_at) VALUES ($1,$2,$3,$4,$5)",
    [p.packId, p.packCode, p.title, p.factsScopeId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CREATED", entityType: "vocal_pack", entityId: p.packId });
}

export type PackLock = "NONE" | "SHARE" | "UPDATE";

/** 팩 행을 읽는다. 청구권자를 바꾸는 쪽은 UPDATE, 청구권자를 읽고 판정하는 쪽은 SHARE로 잠근다. */
export async function packRow(tx: Tx, packId: string, lock: PackLock = "NONE"): Promise<{ packId: string; factsScopeId: string; status: string }> {
  const suffix = lock === "UPDATE" ? " FOR UPDATE" : lock === "SHARE" ? " FOR SHARE" : "";
  const r = (await tx.query(`SELECT pack_id, facts_scope_id, status FROM vocal_pack WHERE pack_id = $1${suffix}`, [packId])).rows[0];
  if (r === undefined) throw notFound("pack", packId);
  return { packId: r.pack_id, factsScopeId: r.facts_scope_id, status: r.status };
}

/** 선언 청구권자 교체. 활성 팩은 바꿀 수 없다(일시정지 또는 초안에서만). */
export async function setPackClaimants(tx: Tx, clock: Clock, actor: Actor, packId: string, entries: Declared[]): Promise<void> {
  requirePermission(actor, "pack.edit");
  const pack = await packRow(tx, packId, "UPDATE");
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is ACTIVE`);
  await tx.query("DELETE FROM pack_claimant WHERE pack_id = $1", [packId]);
  for (const e of entries) {
    await tx.query("INSERT INTO pack_claimant (pack_id, party_id, claimant_role) VALUES ($1,$2,$3)", [packId, e.party, e.role]);
  }
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CLAIMANTS_SET", entityType: "vocal_pack", entityId: packId, after: entries });
}

export async function declaredClaimants(tx: Tx, packId: string): Promise<Declared[]> {
  const r = await tx.query("SELECT claimant_role, party_id FROM pack_claimant WHERE pack_id = $1 ORDER BY claimant_role, party_id", [packId]);
  return r.rows.map((x) => ({ role: x.claimant_role, party: x.party_id }));
}

export async function openDisputeInScope(tx: Tx, scopeId: string): Promise<boolean> {
  return ((await tx.query("SELECT 1 FROM dispute WHERE facts_scope_id = $1 AND status = 'OPEN' LIMIT 1", [scopeId])).rowCount ?? 0) > 0;
}

/**
 * 활성 정책의 facts 고정 이후에 종결된 분쟁. 종결은 대상의 새 버전을 기록하므로 고정된 facts는 낡았고,
 * 재고정(rebindPolicy) 또는 새 정책 버전 없이 팩을 다시 켜면 분쟁 이전 facts로 발행하게 된다.
 */
async function disputeClosedAfter(tx: Tx, scopeId: string, knownAt: string): Promise<{ disputeId: string; closedAt: string } | undefined> {
  const r = (await tx.query(
    "SELECT dispute_id, closed_at FROM dispute WHERE facts_scope_id = $1 AND closed_at > $2 ORDER BY closed_at DESC, dispute_id LIMIT 1", [scopeId, knownAt],
  )).rows[0];
  return r === undefined ? undefined : { disputeId: r.dispute_id, closedAt: iso(r.closed_at)! };
}

function rebindRequired(packId: string, active: { policyId: string; version: number; factsKnownAt: string }, stale: { disputeId: string; closedAt: string }) {
  return conflict("REBIND_REQUIRED", `pack ${packId}: policy ${active.policyId}@${active.version} pins facts known at ${active.factsKnownAt}, before dispute ${stale.disputeId} closed at ${stale.closedAt}; rebind first`);
}

/** F2(통합 설계 5.2): 활성 정책이 있고, 범위에 열린 분쟁이 없고, 정책의 facts가 마지막 분쟁 종결 이후에 고정됐고, 활성화 검사를 통과해야 한다. */
export async function activatePack(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, packId: string): Promise<void> {
  requirePermission(actor, "pack.activate");
  const pack = await packRow(tx, packId, "UPDATE");
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is already ACTIVE`);
  const active = await activePolicyForPack(tx, packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${packId} has no active policy`);
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const stale = await disputeClosedAfter(tx, pack.factsScopeId, active.factsKnownAt);
  if (stale !== undefined) throw rebindRequired(packId, active, stale);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: active.factsDigest, declared: await declaredClaimants(tx, packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `pack ${packId} cannot be activated`, diags);
  // 정합성 검증(원천 문서 설계 S3a): 적용 테넌트의 곡에 열린 BLOCK 이슈가 있으면 활성화하지 않는다.
  await assertActivationAllowed(tx, clock, pack.factsScopeId);
  await assertOwnerTenantActive(tx, pack.factsScopeId, "activate"); // 테넌트 수명주기(결정 TD7): 활성 테넌트만
  await tx.query("UPDATE vocal_pack SET status = 'ACTIVE' WHERE pack_id = $1", [packId]);
  await invalidateDecisions(tx, pack.factsScopeId, { all: true });
  await audit(tx, clock, { actor: actor.userId, action: "PACK_ACTIVATED", entityType: "vocal_pack", entityId: packId, after: { policy: `${active.policyId}@${active.version}` } });
}

/**
 * 멤버 비율 기본값: 정산 대상 슬롯을 부른 횟수에 비례(bps, 합 10000). 나머지는 최대잉여(소수부가 큰 순, 같으면 파티 id 순)로 1씩 준다.
 * 팬 앱처럼 비율을 직접 주지 않는 발행 요청이 쓴다.
 */
export function slotShareBps(performers: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const p of performers) counts.set(p, (counts.get(p) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => ({ k, exact: (n * 10000) / performers.length }));
  const out: Record<string, number> = Object.fromEntries(parts.map((p) => [p.k, Math.floor(p.exact)]));
  let rest = 10000 - Object.values(out).reduce((a, b) => a + b, 0);
  for (const p of [...parts].sort((a, b) => (b.exact % 1) - (a.exact % 1) || (a.k < b.k ? -1 : 1))) {
    if (rest-- <= 0) break;
    out[p.k]! += 1;
  }
  return out;
}

/** 팬앱 조합의 기본 이용 범위. 발행 요청이 usage를 주지 않으면 이 범위로 이용허락을 판정한다. */
export const FAN_APP_USAGE: Usage = { actions: ["COMBINE"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] };

/** 배정의 파트 번호(선택, 결정 SL1): 없으면 파트 1. */
export const validPartNo = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && (v as number) >= 1);

export type IssueInput = { packId: string; vcId: string; assignments: { slotId: string; partNo?: number; stemId: string }[]; members: Record<string, number>; usage?: Usage };

/**
 * F3(통합 설계 5.3, 9.3-6·7): 한 트랜잭션에서 스냅샷을 쓰고 발행 봉인을 만든다. 하나라도 실패하면 아무것도 남지 않는다.
 * 스냅샷 전에 이용허락 판정(다음 작업 3): 작품·녹음·쓰인 보이스의 동의가 이용 범위를 허락하지 않으면 422 ISSUE_NOT_LICENSED.
 * 봉인 직후 사전 검사(11.2-1)에서 엔진 진단이 나오면 422 ISSUE_NOT_SETTLEABLE.
 */
export async function issue(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: IssueInput): Promise<IssueSeal> {
  requirePermission(actor, "issuance.issue");
  const pack = await packRow(tx, input.packId, "SHARE");
  if (pack.status !== "ACTIVE") throw conflict("PACK_NOT_ACTIVE", `pack ${input.packId} is ${pack.status}`);
  await assertOwnerTenantActive(tx, pack.factsScopeId, "issue"); // 정지된 테넌트의 팩은 판매하지 않는다(결정 TD7)
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const active = await activePolicyForPack(tx, input.packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${input.packId} has no active policy`);
  // Outbox가 팩을 멈추기 전에 분쟁이 열리고 닫혔으면 팩은 ACTIVE로 남는다. 고정된 facts가 분쟁 이전이면 발행하지 않는다.
  const stale = await disputeClosedAfter(tx, pack.factsScopeId, active.factsKnownAt);
  if (stale !== undefined) throw rebindRequired(input.packId, active, stale);

  const bad = (m: string) => invalid("INVALID_ISSUE", m);
  if (input.assignments.length === 0) throw bad("assignments must not be empty");
  // 배정 = 슬롯·파트마다 스템 하나(결정 SL1). partNo가 없으면 파트 1(하위 호환).
  const picks = input.assignments.map((a) => ({ slotId: a.slotId, partNo: a.partNo ?? 1, stemId: a.stemId }));
  if (picks.some((a) => !Number.isInteger(a.partNo) || a.partNo < 1)) throw bad("partNo must be a positive integer");
  if (new Set(picks.map((a) => `${a.slotId}#${a.partNo}`)).size !== picks.length) throw bad("duplicate slot part in assignments");
  const stems = (await tx.query(
    `SELECT st.stem_id, st.slot_id, st.part_no, st.performer_party_id, st.rights_bearing, p.kind, p.start_ms, p.end_ms, p.duration_ms, s.facts_scope_id
       FROM stem st JOIN slot_part p ON p.slot_id = st.slot_id AND p.part_no = st.part_no
       JOIN recording_version r ON r.recording_id = st.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE st.stem_id = ANY($1)`,
    [picks.map((a) => a.stemId)],
  )).rows;
  const byStem = new Map(stems.map((s) => [s.stem_id as string, s]));
  for (const a of picks) {
    const s = byStem.get(a.stemId);
    if (s === undefined || s.slot_id !== a.slotId || s.part_no !== a.partNo || s.facts_scope_id !== pack.factsScopeId) throw bad(`stem ${a.stemId} is not in slot ${a.slotId} part ${a.partNo} of this song`);
  }
  // 배정한 슬롯의 보컬 파트는 모두 채워야 한다(SL1). 그룹 파트는 원곡 그룹 스템으로만(SL7).
  const vocal = (await tx.query(
    "SELECT slot_id, part_no FROM slot_part WHERE kind = 'VOCAL' AND slot_id = ANY($1) ORDER BY slot_id, part_no",
    [[...new Set(picks.map((a) => a.slotId))]],
  )).rows;
  const missing = vocal.filter((v) => !picks.some((a) => a.slotId === v.slot_id && a.partNo === v.part_no));
  if (missing.length > 0) throw invalid("PART_MISSING", `vocal parts are not assigned: ${missing.map((m) => `${m.slot_id}#${m.part_no}`).join(", ")}`);
  for (const a of picks) {
    if (byStem.get(a.stemId)!.kind === "GROUP" && !(await isOriginalGroupStem(tx, a.stemId))) {
      throw invalid("GROUP_PART_FIXED", `slot ${a.slotId} part ${a.partNo} is a group part; only its original stem can be used`);
    }
  }
  // 쓰지 않음으로 뺀 스템은 새 발행에 쓰지 않는다(0047). 이미 발행된 조합은 그대로다.
  const retired = (await withSystemScope(tx, async () => (await tx.query("SELECT stem_id FROM stem_retirement WHERE stem_id = ANY($1) ORDER BY stem_id", [picks.map((a) => a.stemId)])).rows));
  if (retired.length > 0) {
    throw invalid("STEM_RETIRED", `stems are no longer used: ${retired.map((r) => r.stem_id).join(", ")}`,
      retired.map((r) => ({ code: "STEM_RETIRED", path: `$.assignments.${r.stem_id}`, message: "stem is retired (쓰지 않음)" })));
  }
  // 오디오를 올린 스템은 검수·출처 검사를 통과(READY)해야 쓸 수 있다(다음 작업 9). 오디오 없이 등록된 메타데이터 스템은 검사 대상이 아니다.
  const notReady = (await tx.query("SELECT stem_id, status FROM stem_audio WHERE stem_id = ANY($1) AND status <> 'READY' ORDER BY stem_id", [picks.map((a) => a.stemId)])).rows;
  if (notReady.length > 0) {
    throw invalid("STEM_NOT_READY", `stems are not ready: ${notReady.map((r) => `${r.stem_id}:${r.status}`).join(", ")}`,
      notReady.map((r) => ({ code: "STEM_NOT_READY", path: `$.assignments.${r.stem_id}`, message: `stem audio is ${r.status}` })));
  }
  const memberEntries = Object.entries(input.members);
  if (memberEntries.some(([, v]) => !Number.isInteger(v) || v < 0 || v > 10000)) throw bad("member bps must be integers 0..10000");
  if (memberEntries.reduce((acc, [, v]) => acc + v, 0) !== 10000) throw bad("member bps must sum to 10000");
  const known = (await tx.query("SELECT party_id FROM party WHERE party_id = ANY($1)", [memberEntries.map(([p]) => p)])).rows.length;
  if (known !== memberEntries.length) throw bad("unknown member party");
  // 멤버는 배정된 정산 대상 스템을 실연한 party여야 한다(레이블·작가 등은 멤버 비율을 받을 수 없다).
  const performers = new Set(picks.map((a) => byStem.get(a.stemId)!).filter((s) => s.rights_bearing && s.performer_party_id !== null).map((s) => s.performer_party_id as string));
  const outsiders = memberEntries.map(([p]) => p).filter((p) => !performers.has(p));
  if (outsiders.length > 0) throw bad(`members must perform an assigned rights-bearing stem: ${outsiders.sort().join(", ")}`);

  const issuedAt = clock.now();
  const license = await decideIssueLicense(tx, {
    factsScopeId: pack.factsScopeId, stemIds: picks.map((a) => a.stemId),
    rightsBearingStemIds: picks.filter((a) => byStem.get(a.stemId)!.rights_bearing).map((a) => a.stemId),
    usage: input.usage ?? FAN_APP_USAGE, at: issuedAt,
  });
  if (license.decision.result !== "PERMIT" && license.decision.result !== "PERMIT_WITH_OBLIGATION") {
    throw invalid("ISSUE_NOT_LICENSED", `combination ${input.vcId} is not licensed: ${license.decision.result}`, licenseDiagnostics(license.decision));
  }
  const snapshotId = `snp_${input.vcId}`;
  await tx.query("INSERT INTO rights_snapshot (snapshot_id, vc_id, pack_id, policy_id, policy_version, created_at, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [snapshotId, input.vcId, input.packId, active.policyId, active.version, issuedAt, actor.userId]);
  const usageMs: Record<string, number> = {};
  for (const a of picks) {
    const s = byStem.get(a.stemId)!;
    await tx.query(
      "INSERT INTO snapshot_stem_assignment (snapshot_id, slot_id, part_no, stem_id, party_id, start_ms, end_ms, duration_ms, rights_bearing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [snapshotId, a.slotId, a.partNo, a.stemId, s.performer_party_id, s.start_ms, s.end_ms, s.duration_ms, s.rights_bearing],
    );
    // 사용 시간 = 파트 길이(SL2). 그룹 파트는 넣지 않는다(SL7). 반주 파트의 스템은 권리 부담이 없어 빠진다(SL6) —
    // 파트를 따로 주지 않고 만든 기존 슬롯(반주 파트 1에 권리 부담 스템)은 지금처럼 넣는다.
    if (s.rights_bearing && s.kind !== "GROUP") usageMs[a.stemId] = (usageMs[a.stemId] ?? 0) + (s.duration_ms as number);
  }
  for (const [party, bps] of memberEntries) {
    await tx.query("INSERT INTO snapshot_member_pct (snapshot_id, party_id, pct_bps) VALUES ($1,$2,$3)", [snapshotId, party, bps]);
  }
  const seal = await sealIssue(ctx, tx, { snapshotId, factsDigest: active.factsDigest, policyDigest: active.policyDigest, usageMs, members: input.members, issuedAt });
  // 사전 검사(통합 설계 11.2-1): 정산할 수 없는 조합은 발행하지 않는다. 던지면 트랜잭션이 롤백돼 스냅샷·봉인 행이 남지 않는다.
  const diags = await preflightIssue(ctx, tx, seal);
  if (diags.length > 0) throw invalid("ISSUE_NOT_SETTLEABLE", `combination ${input.vcId} cannot be settled under ${active.policyId}@${active.version}`, diags);
  await audit(tx, clock, { actor: actor.userId, action: "ISSUED", entityType: "rights_snapshot", entityId: snapshotId, after: { projection: seal.projectionDigest, license: license.decision.digest } });
  // 실연자 앱 알림: 내 보이스(스템)가 새 조합에 쓰였다.
  const used = new Map<string, string[]>();
  for (const a of picks) {
    const s = byStem.get(a.stemId)!;
    if (s.rights_bearing && s.performer_party_id !== null) used.set(s.performer_party_id as string, [...(used.get(s.performer_party_id as string) ?? []), a.slotId]);
  }
  for (const [party, slots] of [...used].sort(([a], [b]) => (a < b ? -1 : 1))) {
    await notifyParty(tx, clock, party, { kind: "USAGE", title: "내 보이스가 새 조합에 쓰였습니다", body: `조합 ${input.vcId}의 ${slots.join(", ")} 파트`, ref: { vcId: input.vcId, snapshotId } });
  }
  return seal;
}

/** 그룹 파트의 원곡 스템 = 그 파트에 처음 등록된 스템(SL7). */
async function isOriginalGroupStem(tx: Tx, stemId: string): Promise<boolean> {
  const r = (await tx.query(
    `SELECT o.stem_id FROM stem st JOIN stem o ON o.slot_id = st.slot_id AND o.part_no = st.part_no
      WHERE st.stem_id = $1 ORDER BY o.created_at, o.stem_id LIMIT 1`, [stemId])).rows[0];
  return r?.stem_id === stemId;
}

const GATE_CODES = new Set(["PART_MISSING", "GROUP_PART_FIXED", "ISSUE_NOT_LICENSED", "ISSUE_NOT_SETTLEABLE", "STEM_NOT_READY", "INVALID_ISSUE", "PACK_NOT_ACTIVE", "FACTS_DISPUTE_OPEN", "REBIND_REQUIRED", "NO_ACTIVE_POLICY"]);

/**
 * 발행 게이트 거부를 관제용으로 남긴다(⑧ 게이트 거부율). 발행 트랜잭션은 롤백되므로 별도 트랜잭션(system 범위)으로 쓴다.
 * 게이트 거부가 아닌 오류(권한·형식·충돌)와 모르는 사용자는 남기지 않는다. 기록 실패는 원래 오류를 가리지 않는다.
 */
export async function recordIssueRejection(
  db: Db, clock: Clock, e: unknown, ctx: { channel: string; actorUserId: unknown; packId?: unknown; vcId?: unknown },
): Promise<void> {
  if (!(e instanceof DomainError) || !GATE_CODES.has(e.code) || typeof ctx.actorUserId !== "string") return;
  await db.tx((tx) => tx.query(
    `INSERT INTO issue_rejection (occurred_at, channel, actor_user_id, pack_id, vc_id, code, diagnostics)
     SELECT $1,$2,$3::text,$4,$5,$6,$7 WHERE EXISTS (SELECT 1 FROM user_account WHERE user_id = $3::text)`,
    [clock.now(), ctx.channel, ctx.actorUserId, typeof ctx.packId === "string" ? ctx.packId : null, typeof ctx.vcId === "string" ? ctx.vcId : null,
      e.code, JSON.stringify(e.diagnostics ?? [])],
  )).catch((err: Error) => console.error("issue rejection log failed:", err.message));
}

/** Outbox 핸들러: 분쟁이 열리면 그 facts 범위의 ACTIVE 팩을 일시정지한다(통합 설계 5.6-1). 재활성화는 수동이다. */
export const OUTBOX_HANDLERS: OutboxHandlers = {
  /** 알림 푸시: 기본은 아무것도 보내지 않는다(알림함에만 남음). 푸시가 설정되면 pushOutboxHandlers가 이 처리기를 덮어쓴다. */
  async notification_push() {},
  async dispute_opened(tx, payload: { factsScopeId: string; disputeId: string }, clock) {
    // openDispute와 같은 순서(pack_id)로 먼저 잠근다. UPDATE의 행 순서는 정해져 있지 않아 교착할 수 있다.
    await tx.query("SELECT pack_id FROM vocal_pack WHERE facts_scope_id = $1 ORDER BY pack_id FOR UPDATE", [payload.factsScopeId]);
    const paused = (await tx.query(
      "UPDATE vocal_pack SET status = 'PAUSED' WHERE facts_scope_id = $1 AND status = 'ACTIVE' RETURNING pack_id", [payload.factsScopeId],
    )).rows;
    if (paused.length > 0) await invalidateDecisions(tx, payload.factsScopeId, { all: true });
    for (const p of paused) {
      await audit(tx, clock, { actor: "system:outbox", action: "PACK_PAUSED", entityType: "vocal_pack", entityId: p.pack_id, after: { disputeId: payload.disputeId } });
    }
  },
  /**
   * 동의 철회의 영향 기록: 그 범위에서 철회한 파티의 스템을 쓴 발행 조합을 감사 로그에 남긴다.
   * 새 발행은 발행 게이트가 막는다(다음 작업 3). 기존 조합은 노출 보류를 건다(다음 작업 17): 철회된 자산을 쓴 조합의 마스터 다운로드·재생 기록을 멈춘다.
   * 미정산 매출의 보류·역분개 검토는 관제 영향 분석(다음 작업 8)이 보여 주고 정산 담당이 정한다.
   */
  async consent_revoked(tx, payload: { consentId: string; factsScopeId: string; partyId: string }, clock) {
    const affected = (await tx.query(
      `SELECT DISTINCT s.snapshot_id FROM rights_snapshot s JOIN vocal_pack p ON p.pack_id = s.pack_id
         JOIN snapshot_stem_assignment a ON a.snapshot_id = s.snapshot_id
        WHERE p.facts_scope_id = $1 AND a.party_id = $2 ORDER BY s.snapshot_id`, [payload.factsScopeId, payload.partyId],
    )).rows.map((r) => r.snapshot_id as string);
    await audit(tx, clock, { actor: "system:outbox", action: "CONSENT_IMPACT", entityType: "consent_agreement", entityId: payload.consentId, after: { partyId: payload.partyId, snapshots: affected } });
    const stopped = await holdExposureForConsent(tx, clock, payload.consentId);
    if (stopped.length > 0) {
      await audit(tx, clock, { actor: "system:outbox", action: "EXPOSURE_STOPPED", entityType: "consent_agreement", entityId: payload.consentId, after: { snapshots: stopped } });
    }
  },
};
