import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { notifyUser } from "../performer/notifications.ts";
import { openDispute } from "./disputes.ts";
import { currentClaim, currentMandate, recordClaim, recordMandate } from "./service.ts";
import { currentAssignment, reviseAssignment, type PartAssignment } from "./part-assignment.ts";
import { hasPermission } from "../platform/permissions.ts";

/** 확인 기한(결정 D5): 14일. 지나면 정합성 경고가 차단으로 오를 뿐이다 — 확정은 상대 당사자의 확인·서명으로만 된다(결정 WD3). */
export const CONFIRMATION_DAYS = 14;
/** 돈의 흐름을 바꾸는 주장(지분·권리자 지정). 크레딧 표기(CONTRIBUTED_BY)는 확인 대상이 아니다. 위임은 언제나 대상이다. */
const CONFIRM_EDGES = new Set(["CONTROLLED_BY", "WRITTEN_BY", "OWNED_BY", "PERFORMED_BY"]);

/** PART: IR 생성 뒤 원곡 파트 담당 바로잡기(0046) — 상대는 바뀐 멤버 둘(새 담당·이전 담당)이고 모두 확인해야 VERIFIED. */
type RecordType = "CLAIM" | "MANDATE" | "PART";
export const needsConfirmation = (type: RecordType, edge?: string) => type !== "CLAIM" || (edge !== undefined && CONFIRM_EDGES.has(edge));

/**
 * 상대 당사자: 이 기록으로 권리를 얻거나 내주는 쪽.
 * - 녹음·작품·보이스 소유 주장: 대상 파티(권리자로 지정되는 사람)
 * - 스템 실연 주장: 그 보이스의 소유자
 * - 위임: 위임하는 파티(자기 몫을 넘기는 쪽)
 */
export async function counterpartyOf(tx: Tx, type: RecordType, r: { edge?: string; targetId?: string; fromPartyId?: string; factsScopeId: string }): Promise<string> {
  if (type === "MANDATE") return r.fromPartyId!;
  if (r.edge !== "PERFORMED_BY") return r.targetId!;
  const owner = await withSystemScope(tx, async () => (await tx.query(
    "SELECT target_id FROM right_claim WHERE facts_scope_id = $1 AND source_id = $2 AND edge = 'OWNED_BY' AND superseded_at IS NULL ORDER BY claim_id LIMIT 1",
    [r.factsScopeId, r.targetId])).rows[0]?.target_id as string | undefined);
  if (owner === undefined) throw invalid("NO_COUNTERPARTY", `voice ${r.targetId} has no owner claim to confirm with`);
  return owner;
}

/** 사람 당사자(개인). 관리 테넌트가 등록·관리해도 확인·서명은 본인이 한다(결정 WD2). */
export const PERSON_PARTY_TYPES = ["MEMBER", "ARTIST", "AUTHOR", "SESSION", "FAN"] as const;

/**
 * 요청자가 그 파티 자신인가: 본인 계정이거나, 기관 당사자(레이블·소속사 등)면 그 파티가 속한 테넌트의 사용자.
 * 사람 당사자(작가 등)는 관리 테넌트가 대신 확인하지 못한다 — 본인 계정이나 전자서명 링크로 본인이 한다(결정 WD2).
 */
export async function actsFor(tx: Tx, actor: Actor, partyId: string): Promise<boolean> {
  if (actor.partyId === partyId) return true;
  if (actor.scope !== "tenant") return false;
  const p = await withSystemScope(tx, async () => (await tx.query("SELECT tenant_id, party_type FROM party WHERE party_id = $1", [partyId])).rows[0]);
  return p !== undefined && p.tenant_id === actor.tenantId && !(PERSON_PARTY_TYPES as readonly string[]).includes(p.party_type);
}

/**
 * 확인 없이 VERIFIED로 기록해도 되는가: 상대 당사자 자신만. 그 밖에는 ASSERTED로 기록하고 확인을 요청해야 한다.
 * 플랫폼 운영은 권리를 확정하지 않는다(결정 WD3) — 운영 역할에는 rights.edit가 없어 이 경로에 오지 못한다(test/platform/no-platform-rights.test.ts).
 * 남은 예외: 플랫폼 소유 시험·합성 곡의 레거시 권리 편집 계정(플랫폼 소속 RIGHTS_EDITOR, 새로 발급할 수 없다 — TR5).
 */
export async function assertMayRecordVerified(tx: Tx, actor: Actor, type: RecordType, d: { status?: string; edge?: string; targetId?: string; fromPartyId?: string; factsScopeId: string }): Promise<void> {
  if (d.status !== "VERIFIED" || !needsConfirmation(type, d.edge)) return;
  if (actor.scope === "platform" && hasPermission(actor, "rights.edit")) return;
  const cp = await counterpartyOf(tx, type, d);
  if (!(await actsFor(tx, actor, cp))) {
    throw new DomainError("CONFIRMATION_REQUIRED", 422, `record it as ASSERTED; ${cp} must confirm before it becomes VERIFIED`);
  }
}

async function currentOf(tx: Tx, type: RecordType, id: string) {
  return withSystemScope(tx, async () => {
    if (type === "CLAIM") { const c = await currentClaim(tx, id); return { ...c, id, edge: c.edge as string, targetId: c.targetId }; }
    const m = await currentMandate(tx, id);
    return { ...m, id, fromPartyId: m.fromPartyId };
  });
}

export async function notifyParty(tx: Tx, clock: Clock, partyId: string, title: string, body: string, ref: unknown): Promise<void> {
  // 본인 계정과, 그 파티가 기관(레이블·출판사 등)이면 그 테넌트 사용자에게 알린다.
  const users = await withSystemScope(tx, async () => (await tx.query(
    `SELECT DISTINCT u.user_id FROM user_account u JOIN party p ON p.party_id = $1
      WHERE u.party_id = $1 OR (u.tenant_id = p.tenant_id AND p.tenant_id NOT IN ('tnt_platform', 'tnt_platform_default')) ORDER BY u.user_id`, [partyId])).rows);
  for (const u of users) await notifyUser(tx, clock, u.user_id as string, { kind: "CONFIRMATION", title, body, ref });
}

/** 확인 요청: ASSERTED 상태의 확인 대상 기록에 요청을 만들고 상대에게 알린다. 같은 기록에 열린 요청은 하나다. */
export async function requestConfirmation(tx: Tx, clock: Clock, actor: Actor, type: RecordType, recordId: string) {
  if (type === "PART") throw invalid("NOT_REQUESTABLE", "part assignment confirmations are sent when the new version is recorded");
  const r = await currentOf(tx, type, recordId);
  if (r.status !== "ASSERTED") throw conflict("NOT_ASSERTED", `${type} ${recordId} is ${r.status}; only ASSERTED records are confirmed`);
  if (!needsConfirmation(type, (r as { edge?: string }).edge)) throw invalid("NO_CONFIRMATION_NEEDED", `${type} ${recordId} does not need confirmation`);
  const cp = await counterpartyOf(tx, type, r as never);
  const now = clock.now();
  const due = new Date(Date.parse(now) + CONFIRMATION_DAYS * 86_400_000).toISOString();
  const open = (await tx.query("SELECT request_id FROM confirmation_request WHERE record_type = $1 AND record_id = $2 AND status = 'OPEN'", [type, recordId])).rows[0];
  if (open !== undefined) return getConfirmation(tx, Number(open.request_id));
  const id = (await tx.query(
    `INSERT INTO confirmation_request (record_type, record_id, record_version, facts_scope_id, counterparty_id, requested_by, requested_at, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING request_id`, [type, recordId, r.version, r.factsScopeId, cp, actor.userId, now, due])).rows[0].request_id;
  await notifyParty(tx, clock, cp, "권리 기록 확인 요청", `${type === "CLAIM" ? "권리 주장" : "위임"} ${recordId}가 당신을 당사자로 등록됐습니다. ${due.slice(0, 10)}까지 확인해 주세요.`, { requestId: Number(id) });
  await audit(tx, clock, { actor: actor.userId, action: "CONFIRMATION_REQUESTED", entityType: type === "CLAIM" ? "right_claim" : "mandate", entityId: recordId, after: { counterparty: cp, version: r.version } });
  return getConfirmation(tx, Number(id));
}

/** 파트 담당 바로잡기의 확인 요청(상대마다 하나). 같은 (기록, 상대)에 열린 요청이 있으면 그것을 돌려준다. */
export async function requestPartConfirmation(tx: Tx, clock: Clock, actor: Actor, a: PartAssignment, counterparty: string) {
  const open = (await tx.query("SELECT request_id FROM confirmation_request WHERE record_type = 'PART' AND record_id = $1 AND counterparty_id = $2 AND status = 'OPEN'", [a.assignmentId, counterparty])).rows[0];
  if (open !== undefined) return getConfirmation(tx, Number(open.request_id));
  const now = clock.now();
  const due = new Date(Date.parse(now) + CONFIRMATION_DAYS * 86_400_000).toISOString();
  const id = (await tx.query(
    `INSERT INTO confirmation_request (record_type, record_id, record_version, facts_scope_id, counterparty_id, requested_by, requested_at, due_at)
     VALUES ('PART',$1,$2,$3,$4,$5,$6,$7) RETURNING request_id`, [a.assignmentId, a.version, a.factsScopeId, counterparty, actor.userId, now, due])).rows[0].request_id;
  await notifyParty(tx, clock, counterparty, "원곡 파트 담당 확인 요청",
    `${a.slotId} 파트 ${a.partNo}의 원곡 담당을 ${a.previousPartyId} → ${a.partyId}로 바로잡았습니다. ${due.slice(0, 10)}까지 확인해 주세요.`, { requestId: Number(id) });
  await audit(tx, clock, { actor: actor.userId, action: "CONFIRMATION_REQUESTED", entityType: "part_assignment", entityId: a.assignmentId, after: { counterparty, version: a.version } });
  return getConfirmation(tx, Number(id));
}

async function openRequest(tx: Tx, requestId: number) {
  const q = (await tx.query("SELECT * FROM confirmation_request WHERE request_id = $1 FOR UPDATE", [requestId])).rows[0];
  if (q === undefined) throw notFound("confirmation request", String(requestId));
  if (q.status !== "OPEN") throw conflict("REQUEST_CLOSED", `request ${requestId} is ${q.status}`);
  return q;
}

/** 확인된 기록을 VERIFIED 새 버전으로 남긴다(근거 연결은 이어받는다). 기록이 그사이 바뀌었으면 요청은 SUPERSEDED. 곡 소유 테넌트의 행이므로 system 범위로 쓴다. */
async function verifyRecord(tx: Tx, clock: Clock, q: any): Promise<boolean> {
  return withSystemScope(tx, async () => {
    const type = q.record_type as RecordType;
    if (type === "PART") {
      const cur = await currentAssignment(tx, q.record_id, true);
      if (cur.version !== q.record_version) {
        await tx.query("UPDATE confirmation_request SET status = 'SUPERSEDED', decided_at = $2 WHERE request_id = $1", [q.request_id, clock.now()]);
        return false;
      }
      // 바뀐 멤버 모두가 확인해야 VERIFIED(이 요청은 이미 CONFIRMED로 바뀌었다).
      const waiting = (await tx.query("SELECT count(*)::int AS n FROM confirmation_request WHERE record_type = 'PART' AND record_id = $1 AND record_version = $2 AND status <> 'CONFIRMED'",
        [q.record_id, q.record_version])).rows[0].n as number;
      if (waiting === 0) await reviseAssignment(tx, clock, cur, "VERIFIED");
      return true;
    }
    const cur = type === "CLAIM" ? await currentClaim(tx, q.record_id) : await currentMandate(tx, q.record_id);
    if (cur.version !== q.record_version) {
      await tx.query("UPDATE confirmation_request SET status = 'SUPERSEDED', decided_at = $2 WHERE request_id = $1", [q.request_id, clock.now()]);
      return false;
    }
    if (type === "CLAIM") {
      const { version, ...draft } = cur as Awaited<ReturnType<typeof currentClaim>>;
      await recordClaim(tx, clock, { ...draft, status: "VERIFIED" }, { expectedVersion: version });
    } else {
      const { version, ...draft } = cur as Awaited<ReturnType<typeof currentMandate>>;
      await recordMandate(tx, clock, { ...draft, status: "VERIFIED" }, { expectedVersion: version });
    }
    return true;
  });
}

/** 상대 당사자의 확인 → VERIFIED. */
export async function confirmRequest(tx: Tx, clock: Clock, actor: Actor, requestId: number) {
  const q = await openRequest(tx, requestId);
  if (!(await actsFor(tx, actor, q.counterparty_id))) throw new DomainError("NOT_COUNTERPARTY", 403, `${actor.userId} does not act for ${q.counterparty_id}`);
  await tx.query("UPDATE confirmation_request SET status = 'CONFIRMED', decided_by = $2, decided_at = $3 WHERE request_id = $1", [requestId, actor.userId, clock.now()]);
  if (!(await verifyRecord(tx, clock, q))) throw conflict("STALE_REQUEST", `${q.record_type} ${q.record_id} changed after the request; ask again`);
  await audit(tx, clock, { actor: actor.userId, action: "CONFIRMATION_CONFIRMED", entityType: "confirmation_request", entityId: String(requestId) });
  return getConfirmation(tx, requestId);
}

/** 상대 당사자의 거절(사유 필수) → 그 기록에 분쟁을 연다(기존 분쟁 흐름: 팩 일시정지, 종결 후 재고정). */
export async function declineRequest(tx: Tx, clock: Clock, actor: Actor, requestId: number, reason: unknown) {
  if (typeof reason !== "string" || reason.trim() === "") throw new DomainError("BAD_REQUEST", 400, "reason is required");
  const q = await openRequest(tx, requestId);
  if (!(await actsFor(tx, actor, q.counterparty_id))) throw new DomainError("NOT_COUNTERPARTY", 403, `${actor.userId} does not act for ${q.counterparty_id}`);
  if (q.record_type === "PART") {
    // 파트 담당은 분쟁 표 대상이 아니다: 기록을 DISPUTED 새 버전으로 남기고(지금 담당 계산에서 빠진다) 같은 버전의 다른 요청은 닫는다.
    await tx.query("UPDATE confirmation_request SET status = 'DECLINED', decided_by = $2, decided_at = $3, reason = $4 WHERE request_id = $1",
      [requestId, actor.userId, clock.now(), reason.trim()]);
    await withSystemScope(tx, async () => {
      await tx.query("UPDATE confirmation_request SET status = 'SUPERSEDED', decided_at = $3 WHERE record_type = 'PART' AND record_id = $1 AND record_version = $2 AND status = 'OPEN'",
        [q.record_id, q.record_version, clock.now()]);
      const cur = await currentAssignment(tx, q.record_id, true);
      if (cur.version === q.record_version) await reviseAssignment(tx, clock, cur, "DISPUTED", `확인 거절: ${reason.trim()}`);
    });
    await audit(tx, clock, { actor: actor.userId, action: "CONFIRMATION_DECLINED", entityType: "confirmation_request", entityId: String(requestId) });
    return getConfirmation(tx, requestId);
  }
  const disputeId = `dsp_cfm_${requestId}`;
  // 요청을 먼저 닫는다(분쟁 개시가 기록의 새 버전을 만들면 열린 요청은 SUPERSEDED가 되므로).
  await tx.query("UPDATE confirmation_request SET status = 'DECLINED', decided_by = $2, decided_at = $3, reason = $4, dispute_id = $5 WHERE request_id = $1",
    [requestId, actor.userId, clock.now(), reason.trim(), disputeId]);
  await withSystemScope(tx, () => openDispute(tx, clock, {
    disputeId, targetType: q.record_type === "CLAIM" ? "RIGHT_CLAIM" : "MANDATE", targetId: q.record_id, reason: `확인 거절: ${reason.trim()}`, openedBy: actor.userId,
  }));
  await audit(tx, clock, { actor: actor.userId, action: "CONFIRMATION_DECLINED", entityType: "confirmation_request", entityId: String(requestId), after: { disputeId } });
  return getConfirmation(tx, requestId);
}

function toConfirmation(r: any) {
  return {
    requestId: Number(r.request_id), recordType: r.record_type as RecordType, recordId: r.record_id as string, recordVersion: r.record_version as number,
    factsScopeId: r.facts_scope_id as string, counterpartyId: r.counterparty_id as string, requestedBy: r.requested_by as string,
    requestedAt: iso(r.requested_at)!, dueAt: iso(r.due_at)!, status: r.status as string,
    ...(r.decided_at !== null && { decidedAt: iso(r.decided_at)! }), ...(r.decided_by !== null && { decidedBy: r.decided_by as string }),
    ...(r.reason !== null && { reason: r.reason as string }), ...(r.dispute_id !== null && { disputeId: r.dispute_id as string }),
  };
}

export async function getConfirmation(tx: Tx, requestId: number) {
  const r = (await tx.query("SELECT * FROM confirmation_request WHERE request_id = $1", [requestId])).rows[0];
  if (r === undefined) throw notFound("confirmation request", String(requestId));
  return toConfirmation(r);
}

/** 보이는 확인 요청(RLS: 요청한 쪽·상대·플랫폼). party를 주면 그 상대 당사자 것만. */
export async function listConfirmations(tx: Tx, f: { status?: string; party?: string }) {
  return (await tx.query(
    `SELECT * FROM confirmation_request WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR counterparty_id = $2) ORDER BY requested_at DESC, request_id DESC`,
    [f.status ?? null, f.party ?? null])).rows.map(toConfirmation);
}
