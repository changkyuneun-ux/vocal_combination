import { withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { recordMandate } from "../registry/service.ts";
import { revalidate } from "../validation/service.ts";
import { hasPermission, requirePermission, type Permission } from "../platform/permissions.ts";
import { sodEnabled } from "../platform/sod.ts";

/**
 * 참여 기관의 연결(테넌트 정책 4절, 결정 TD10·TD11, 진행 TN9·TN10).
 * - 신탁 연결(TRUST): 작가 ↔ 신탁단체. 권리 테넌트(또는 위탁 당사자를 관리하는 플랫폼)가 등록 정보로 제안하면 신탁단체가 확인하고,
 *   신탁단체가 요청하면 작가의 관리 주체가 확인한다. 활성이 되면 그 작가가 작품 몫을 가진 곡마다 작가 → 신탁단체 작품 몫 위임을
 *   자동으로 기록한다(source_ref = link:<id>). 정책이 작품 몫을 위임대로 보내야(via mandate) 실제로 신탁단체가 받는다.
 * - 유통 연결(DISTRIBUTION): 권리 테넌트 ↔ 유통 파트너. 한쪽이 제안하고 다른 쪽이 확인한다. 상품 대응은 파트너가 제안하고 권리 테넌트가 확인한다.
 * 일방으로 성립하지 않고, 끊으면 그 뒤 발행·정산부터 반영된다(봉인된 기록은 그대로).
 */
export type LinkType = "TRUST" | "DISTRIBUTION";
type Side = "RIGHTS" | "PARTICIPANT";
const ID = /^[A-Za-z0-9._-]+$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 참여 기관 쪽 연결 결정 권한: 신탁단체는 신탁 담당, 유통 파트너는 연동 담당(둘 다 조직 관리자 포함 — 0039 role_permission). */
const participantDecider = (tenantType: string): Permission => (tenantType === "CMO" ? "link.decide_trust" : "link.decide_partner");

async function tenantOf(tx: Tx, tenantId: string) {
  const t = (await tx.query("SELECT tenant_id, tenant_type, org_class, status FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  return t as { tenant_id: string; tenant_type: string; org_class: string; status: string };
}

/** 작가 당사자의 관리 주체(party.tenant_id)와 그 참여 구분. */
async function managerOf(tx: Tx, partyId: string) {
  const p = (await tx.query("SELECT p.party_id, p.party_type, p.tenant_id, t.org_class FROM party p JOIN tenant t ON t.tenant_id = p.tenant_id WHERE p.party_id = $1", [partyId])).rows[0];
  if (p === undefined) throw notFound("party", partyId);
  return p as { party_id: string; party_type: string; tenant_id: string; org_class: string };
}

export async function proposeLink(tx: Tx, clock: Clock, actor: Actor, b: Record<string, unknown>) {
  const linkType = b.linkType as LinkType;
  if (linkType !== "TRUST" && linkType !== "DISTRIBUTION") throw invalid("BAD_REQUEST", "linkType must be TRUST or DISTRIBUTION");
  if (typeof b.linkId !== "string" || !ID.test(b.linkId)) throw invalid("BAD_REQUEST", "linkId must be an id");
  const validFrom = typeof b.validFrom === "string" ? b.validFrom : clock.now();
  if (!INSTANT.test(validFrom)) throw invalid("BAD_REQUEST", "validFrom must be ms UTC ISO");
  if (b.validTo !== undefined && (typeof b.validTo !== "string" || !INSTANT.test(b.validTo) || b.validTo <= validFrom)) throw invalid("BAD_REQUEST", "validTo must be ms UTC ISO after validFrom");
  const linkId = b.linkId;
  const str = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string).trim() : null);
  let side: Side;
  let participant: string;
  let rightsTenant: string | null = null;
  let author: string | null = null;
  let payee: string | null = null;

  await withSystemScope(tx, async () => {
    if (actor.orgClass === "PARTICIPANT") {
      side = "PARTICIPANT";
      participant = actor.tenantId;
      requirePermission(actor, participantDecider(actor.tenantType));
    } else if (actor.orgClass === "RIGHTS" || actor.scope === "platform") {
      side = "RIGHTS";
      if (typeof b.participantTenantId !== "string") throw invalid("BAD_REQUEST", "participantTenantId is required");
      participant = b.participantTenantId;
      requirePermission(actor, actor.scope === "platform" ? "link.decide_platform" : "link.decide");
      if (actor.scope !== "platform") rightsTenant = actor.tenantId;
    } else {
      throw new DomainError("TENANT_FORBIDDEN", 403, "only rights tenants, participant organizations and the platform make links");
    }
    const pt = await tenantOf(tx, participant!);
    if (linkType === "TRUST") {
      if (pt.tenant_type !== "CMO") throw invalid("NOT_A_CMO", `${participant!} is not a collective management organization`);
      if (typeof b.authorPartyId !== "string") throw invalid("BAD_REQUEST", "authorPartyId is required");
      author = b.authorPartyId;
      const m = await managerOf(tx, author);
      if (m.party_type !== "AUTHOR") throw invalid("NOT_AN_AUTHOR", `${author} is ${m.party_type}; trust links are for authors`);
      if (side! === "RIGHTS") {
        // 제안하는 쪽이 그 작가를 안다: 관리 주체이거나, 자기 곡에 그 작가의 작품 몫 주장이 있다(등록 정보로 연결된다).
        const knows = m.tenant_id === actor.tenantId || (await tx.query(
          "SELECT 1 FROM right_claim c JOIN facts_scope s ON s.facts_scope_id = c.facts_scope_id WHERE c.edge = 'WRITTEN_BY' AND c.target_id = $1 AND c.superseded_at IS NULL AND s.owner_tenant_id = $2 LIMIT 1",
          [author, actor.tenantId])).rowCount !== 0;
        if (!knows) throw new DomainError("TENANT_FORBIDDEN", 403, `${actor.tenantId} has no work by ${author}`);
      }
      const payees = (await tx.query("SELECT party_id FROM party WHERE tenant_id = $1 ORDER BY party_id", [participant!])).rows;
      if (payees.length !== 1) throw conflict("CMO_PARTY_MISSING", `${participant!} needs exactly one payee party (register it at onboarding)`);
      payee = payees[0].party_id as string;
    } else {
      if (side! === "RIGHTS") {
        if (pt.tenant_type !== "B2B_PARTNER") throw invalid("NOT_A_PARTNER", `${participant!} is not a distribution partner`);
        if (actor.scope === "platform") throw invalid("BAD_REQUEST", "a distribution contract is between a rights tenant and a partner");
      } else {
        if (actor.tenantType !== "B2B_PARTNER") throw invalid("NOT_A_PARTNER", "only distribution partners propose distribution links");
        if (typeof b.rightsTenantId !== "string") throw invalid("BAD_REQUEST", "rightsTenantId is required");
        const rt = await tenantOf(tx, b.rightsTenantId);
        if (rt.org_class !== "RIGHTS") throw invalid("NOT_A_RIGHTS_TENANT", `${b.rightsTenantId} is not a rights tenant`);
        rightsTenant = b.rightsTenantId;
      }
    }
    if (pt.status === "TERMINATED" || pt.status === "SUSPENDED") throw conflict("PARTICIPANT_NOT_ACTIVE", `${participant!} is ${pt.status}`);
    // 열린 연결 중복(부분 유니크 인덱스)은 미리 본다 — 실패한 INSERT는 트랜잭션을 깨뜨려 범위 복원까지 막는다.
    const open = linkType === "TRUST"
      ? await tx.query("SELECT 1 FROM participant_link WHERE link_type = 'TRUST' AND status IN ('PROPOSED','ACTIVE') AND author_party_id = $1", [author])
      : await tx.query("SELECT 1 FROM participant_link WHERE link_type = 'DISTRIBUTION' AND status IN ('PROPOSED','ACTIVE') AND participant_tenant_id = $1 AND rights_tenant_id = $2", [participant!, rightsTenant]);
    if (open.rowCount !== 0) throw conflict("LINK_EXISTS", linkType === "TRUST" ? `${author} already has an open trust link` : "this distribution link is already open");
    if ((await tx.query("SELECT 1 FROM participant_link WHERE link_id = $1", [linkId])).rowCount !== 0) throw conflict("LINK_EXISTS", `link ${linkId} exists`);
    {
      await tx.query(
        `INSERT INTO participant_link (link_id, link_type, participant_tenant_id, author_party_id, payee_party_id, rights_tenant_id, member_ref, usage_media,
           valid_from, valid_to, evidence_document_id, status, proposed_side, proposed_by, proposed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PROPOSED',$12,$13,$14)`,
        [linkId, linkType, participant!, author, payee, rightsTenant, str("memberRef"), Array.isArray(b.usageMedia) ? b.usageMedia.map(String) : null,
          validFrom, b.validTo ?? null, str("evidenceDocumentId"), side!, actor.userId, clock.now()]);
    }
    await audit(tx, clock, { actor: actor.userId, action: "LINK_PROPOSED", entityType: "participant_link", entityId: linkId, after: { linkType, participant: participant!, author, rightsTenant, side: side! } });
  });
  return getLink(tx, linkId);
}

type LinkRow = {
  link_id: string; link_type: LinkType; participant_tenant_id: string; author_party_id: string | null; payee_party_id: string | null; rights_tenant_id: string | null;
  status: string; proposed_side: Side; proposed_by: string; valid_from: Date; valid_to: Date | null; evidence_document_id: string | null;
};

async function linkRow(tx: Tx, linkId: string, lock = false): Promise<LinkRow> {
  const r = (await tx.query(`SELECT * FROM participant_link WHERE link_id = $1${lock ? " FOR UPDATE" : ""}`, [linkId])).rows[0];
  if (r === undefined) throw notFound("link", linkId);
  return r as LinkRow;
}

/** 이 행위자가 연결의 어느 쪽인지(권한 있는 역할까지 확인). 어느 쪽도 아니면 undefined. */
async function sideOf(tx: Tx, actor: Actor, l: LinkRow): Promise<Side | "PLATFORM" | undefined> {
  if (actor.scope === "platform") return hasPermission(actor, "link.decide_platform") ? "PLATFORM" : undefined;
  if (actor.tenantId === l.participant_tenant_id) {
    const pt = await tenantOf(tx, l.participant_tenant_id);
    return hasPermission(actor, participantDecider(pt.tenant_type)) ? "PARTICIPANT" : undefined;
  }
  if (l.link_type === "DISTRIBUTION") return actor.tenantId === l.rights_tenant_id && hasPermission(actor, "link.decide") ? "RIGHTS" : undefined;
  // 신탁: 작가의 관리 주체(권리 테넌트·본인), 또는 제안한 권리 테넌트.
  const m = await managerOf(tx, l.author_party_id!);
  if (m.org_class === "INDIVIDUAL") return actor.partyId === l.author_party_id ? "RIGHTS" : undefined;
  if ((actor.tenantId === m.tenant_id || actor.tenantId === l.rights_tenant_id) && hasPermission(actor, "link.decide")) return "RIGHTS";
  return undefined;
}

/**
 * 확인·거절: 제안하지 않은 쪽만 한다. 신탁단체가 요청한 신탁 연결은 작가의 관리 주체가 확인한다 — 권리 테넌트(그 작가를 관리하면),
 * 플랫폼 위탁 작가면 플랫폼 온보딩, 개인이면 본인. 확인하려면 참여 기관이 활성이어야 한다.
 */
export async function decideLink(tx: Tx, clock: Clock, actor: Actor, linkId: string, accept: boolean, reason?: unknown) {
  return withSystemScope(tx, async () => {
    const l = await linkRow(tx, linkId, true);
    if (l.status !== "PROPOSED") throw conflict("INVALID_STATE", `link ${linkId} is ${l.status}`);
    const side = await sideOf(tx, actor, l);
    const deciderSide: Side = l.proposed_side === "RIGHTS" ? "PARTICIPANT" : "RIGHTS";
    // 플랫폼은 위탁 당사자(플랫폼 관리 작가)의 관리 주체로서만 권리 쪽을 대신한다.
    const platformAsRights = side === "PLATFORM" && deciderSide === "RIGHTS" && l.link_type === "TRUST" && (await managerOf(tx, l.author_party_id!)).org_class === "PLATFORM";
    if (side !== deciderSide && !platformAsRights) throw new DomainError("NOT_THE_COUNTERPARTY", 403, `link ${linkId} is decided by the ${deciderSide.toLowerCase()} side`);
    if (actor.userId === l.proposed_by && (await sodEnabled(tx, "link.propose-confirm"))) throw new DomainError("SAME_PERSON", 403, "the proposer cannot confirm the link");
    const now = clock.now();
    if (accept) {
      const pt = await tenantOf(tx, l.participant_tenant_id);
      if (pt.status !== "ACTIVE") throw conflict("PARTICIPANT_NOT_ACTIVE", `${l.participant_tenant_id} is ${pt.status}; links become active only with an ACTIVE participant`);
      await tx.query("UPDATE participant_link SET status = 'ACTIVE', decided_by = $2, decided_at = $3 WHERE link_id = $1", [linkId, actor.userId, now]);
      if (l.link_type === "TRUST") await applyTrust(tx, clock, linkId, actor.userId);
    } else {
      await tx.query("UPDATE participant_link SET status = 'DECLINED', decided_by = $2, decided_at = $3, decline_reason = $4 WHERE link_id = $1",
        [linkId, actor.userId, now, typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null]);
    }
    await audit(tx, clock, { actor: actor.userId, action: accept ? "LINK_CONFIRMED" : "LINK_DECLINED", entityType: "participant_link", entityId: linkId });
    return getLink(tx, linkId);
  });
}

/** 끊기: 양쪽 누구나 또는 플랫폼(사유 필요). 신탁 연결이면 자동 위임을 지금 시각으로 끝낸다(그 뒤 발행·정산부터). */
export async function endLink(tx: Tx, clock: Clock, actor: Actor, linkId: string, reason: unknown) {
  if (typeof reason !== "string" || reason.trim() === "") throw invalid("REASON_REQUIRED", "a reason is required to end a link");
  return withSystemScope(tx, async () => {
    const l = await linkRow(tx, linkId, true);
    if (l.status !== "ACTIVE" && l.status !== "PROPOSED") throw conflict("INVALID_STATE", `link ${linkId} is ${l.status}`);
    if ((await sideOf(tx, actor, l)) === undefined) throw new DomainError("NOT_THE_COUNTERPARTY", 403, `${actor.userId} is not a side of link ${linkId}`);
    await closeLink(tx, clock, l, actor.userId, reason.trim());
    return getLink(tx, linkId);
  });
}

async function closeLink(tx: Tx, clock: Clock, l: LinkRow, by: string, reason: string) {
  const now = clock.now();
  await tx.query("UPDATE participant_link SET status = 'ENDED', ended_by = $2, ended_at = $3, end_reason = $4 WHERE link_id = $1", [l.link_id, by, now, reason]);
  if (l.link_type === "TRUST" && l.status === "ACTIVE") await endTrust(tx, clock, l.link_id);
  await audit(tx, clock, { actor: by, action: "LINK_ENDED", entityType: "participant_link", entityId: l.link_id, after: { reason } });
}

/** 조직 해지(TD7): 그 조직이 참여 기관이거나 유통 계약의 권리 테넌트인 연결을 모두 끝낸다. */
export async function endLinksOfTenant(tx: Tx, clock: Clock, tenantId: string) {
  await withSystemScope(tx, async () => {
    const rows = (await tx.query(
      "SELECT * FROM participant_link WHERE status IN ('PROPOSED','ACTIVE') AND (participant_tenant_id = $1 OR (link_type = 'DISTRIBUTION' AND rights_tenant_id = $1)) FOR UPDATE", [tenantId])).rows as LinkRow[];
    for (const l of rows) await closeLink(tx, clock, l, "sys_verifier", `tenant ${tenantId} terminated`);
  });
}

// ── 신탁 수령(TD11) ──────────────────────────────────────────────────────────────────────────
const trustMandateId = (linkId: string, scopeId: string) => `mdt_trust_${linkId}_${scopeId}`.slice(0, 120);

/** 곡의 소유 테넌트 범위로 기록한다(자동 위임도 그 곡을 등록한 테넌트 소유다). */
async function asOwner<T>(tx: Tx, scopeId: string, fn: () => Promise<T>): Promise<T> {
  const owner = (await tx.query("SELECT owner_tenant_id FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rows[0]?.owner_tenant_id as string;
  const prev = (await tx.query("SELECT current_setting('rc.tenant_id', true) AS t")).rows[0].t as string | null;
  await tx.query("SELECT set_config('rc.tenant_id', $1, true)", [owner]);
  try { return await fn(); } finally { await tx.query("SELECT set_config('rc.tenant_id', $1, true)", [prev ?? ""]); }
}

/** 신탁 연결 하나를 그 작가가 작품 몫을 가진 곡들에 적용한다(이미 있으면 그대로). 시스템 범위에서 부른다. */
async function applyTrust(tx: Tx, clock: Clock, linkId: string, by: string) {
  const l = await linkRow(tx, linkId);
  const scopes = (await tx.query(
    "SELECT DISTINCT facts_scope_id FROM right_claim WHERE edge = 'WRITTEN_BY' AND target_id = $1 AND superseded_at IS NULL ORDER BY facts_scope_id", [l.author_party_id])).rows;
  for (const s of scopes) await applyTrustToScope(tx, clock, l, s.facts_scope_id as string, by);
}

async function applyTrustToScope(tx: Tx, clock: Clock, l: LinkRow, scopeId: string, by: string) {
  const id = trustMandateId(l.link_id, scopeId);
  if ((await tx.query("SELECT 1 FROM mandate WHERE mandate_id = $1 AND superseded_at IS NULL", [id])).rowCount !== 0) return;
  const docVersion = l.evidence_document_id === null ? undefined
    : (await tx.query("SELECT max(version)::int AS v FROM source_document WHERE document_id = $1", [l.evidence_document_id])).rows[0]?.v as number | undefined;
  await asOwner(tx, scopeId, () => recordMandate(tx, clock, {
    mandateId: id, factsScopeId: scopeId, fromPartyId: l.author_party_id!, toPartyId: l.payee_party_id!, rightKind: "WORK", shareBps: 10000, status: "VERIFIED",
    validFrom: iso(l.valid_from)!, ...(l.valid_to !== null && { validTo: iso(l.valid_to)! }), sourceRef: `link:${l.link_id}`,
    ...(docVersion !== undefined && docVersion !== null && { evidenceDocuments: [{ documentId: l.evidence_document_id!, version: docVersion }], linkedBy: by }),
  }));
  await revalidate(tx, clock, scopeId);
}

/** 신탁 연결이 끝나면 자동 위임을 지금 시각으로 끝낸다(새 버전, valid_to = 지금). */
async function endTrust(tx: Tx, clock: Clock, linkId: string) {
  const now = clock.now();
  const rows = (await tx.query("SELECT * FROM mandate WHERE source_ref = $1 AND superseded_at IS NULL", [`link:${linkId}`])).rows;
  for (const m of rows) {
    const end = iso(m.valid_from)! >= now ? undefined : now;
    if (end === undefined || (m.valid_to !== null && iso(m.valid_to)! <= now)) continue;
    await asOwner(tx, m.facts_scope_id, () => recordMandate(tx, clock, {
      mandateId: m.mandate_id, factsScopeId: m.facts_scope_id, fromPartyId: m.from_party_id, toPartyId: m.to_party_id, rightKind: "WORK", shareBps: m.share_bps,
      status: "VERIFIED", validFrom: iso(m.valid_from)!, validTo: end, sourceRef: m.source_ref, ...(m.evidence_digest !== null && { evidenceDigest: m.evidence_digest }),
    }, { expectedVersion: m.version }));
    await revalidate(tx, clock, m.facts_scope_id);
  }
}

/** 새 작품 몫 주장(WRITTEN_BY)이 기록되면, 그 작가에게 활성 신탁 연결이 있으면 그 곡에도 자동 위임을 단다. */
export async function applyTrustOnClaim(tx: Tx, clock: Clock, scopeId: string, authorPartyId: string, by: string) {
  await withSystemScope(tx, async () => {
    const l = (await tx.query("SELECT * FROM participant_link WHERE link_type = 'TRUST' AND status = 'ACTIVE' AND author_party_id = $1", [authorPartyId])).rows[0] as LinkRow | undefined;
    if (l !== undefined) await applyTrustToScope(tx, clock, l, scopeId, by);
  });
}

// ── 조회 ─────────────────────────────────────────────────────────────────────────────────
function view(r: any) {
  return {
    linkId: r.link_id as string, linkType: r.link_type as LinkType, participantTenantId: r.participant_tenant_id as string, participantName: r.participant_name as string,
    authorPartyId: r.author_party_id as string | null, authorName: r.author_name as string | null, payeePartyId: r.payee_party_id as string | null,
    rightsTenantId: r.rights_tenant_id as string | null, rightsTenantName: r.rights_name as string | null, memberRef: r.member_ref as string | null,
    usageMedia: r.usage_media as string[] | null, validFrom: iso(r.valid_from)!, validTo: iso(r.valid_to) ?? null, evidenceDocumentId: r.evidence_document_id as string | null,
    status: r.status as string, proposedSide: r.proposed_side as Side, proposedBy: r.proposed_by as string, proposedAt: iso(r.proposed_at)!,
    decidedBy: r.decided_by as string | null, decidedAt: iso(r.decided_at) ?? null, declineReason: r.decline_reason as string | null,
    endedAt: iso(r.ended_at) ?? null, endReason: r.end_reason as string | null,
  };
}
const LINK_SELECT = `SELECT l.*, pt.name AS participant_name, a.display_name AS author_name, rt.name AS rights_name
  FROM participant_link l JOIN tenant pt ON pt.tenant_id = l.participant_tenant_id LEFT JOIN party a ON a.party_id = l.author_party_id LEFT JOIN tenant rt ON rt.tenant_id = l.rights_tenant_id`;

export async function getLink(tx: Tx, linkId: string) {
  const r = (await tx.query(`${LINK_SELECT} WHERE l.link_id = $1`, [linkId])).rows[0];
  if (r === undefined) throw notFound("link", linkId);
  return view(r);
}

/** 보이는 연결(RLS: 양쪽과 플랫폼). 권리 테넌트는 자기 곡에 작품 몫이 있는 작가의 신탁 연결도 본다(누가 받는지 알아야 한다). */
export async function listLinks(tx: Tx, actor: Actor, f: { type?: string; status?: string } = {}) {
  const known = actor.orgClass === "RIGHTS" ? (await tx.query(
    "SELECT DISTINCT c.target_id FROM right_claim c WHERE c.edge = 'WRITTEN_BY' AND c.superseded_at IS NULL")).rows.map((r) => r.target_id as string) : [];
  return withSystemScope(tx, async () => {
    const rows = (await tx.query(
      `${LINK_SELECT} WHERE ($1::boolean OR l.participant_tenant_id = $2 OR l.rights_tenant_id = $2 OR a.tenant_id = $2 OR l.author_party_id = ANY($3) OR l.author_party_id = $4)
         AND ($5::text IS NULL OR l.link_type = $5) AND ($6::text IS NULL OR l.status = $6) ORDER BY l.proposed_at DESC, l.link_id`,
      [actor.scope === "platform", actor.tenantId, known, actor.partyId ?? null, f.type ?? null, f.status ?? null])).rows;
    return rows.map(view);
  });
}

/**
 * 신탁단체가 보는 신탁 작품(연결 열쇠, 필요한 항목만): 곡·작품 제목, 신탁한 작가와 작품 몫 지분, 이용 실적(발행 조합 수·매출 건수·금액).
 * 녹음·실연·레이블 몫·계약서는 주지 않는다.
 */
export async function trustWorks(tx: Tx, actor: Actor) {
  if (actor.tenantType !== "CMO") throw new DomainError("CMO_ONLY", 403, "trust works are for collective management organizations");
  const claims = (await tx.query(
    `SELECT c.facts_scope_id, w.work_id, w.title, w.iswc, c.target_id, p.display_name, c.share_bps
       FROM right_claim c JOIN facts_scope s ON s.facts_scope_id = c.facts_scope_id JOIN work w ON w.work_id = s.work_id JOIN party p ON p.party_id = c.target_id
      WHERE c.edge = 'WRITTEN_BY' AND c.superseded_at IS NULL ORDER BY w.title, c.target_id`)).rows;
  const scopes = [...new Set(claims.map((c) => c.facts_scope_id as string))];
  const usage = await withSystemScope(tx, async () => new Map((await tx.query(
    `SELECT k.facts_scope_id, count(DISTINCT s.snapshot_id)::int AS combos, count(e.event_id)::int AS events, COALESCE(sum(e.net_amount_krw), 0)::text AS amount
       FROM vocal_pack k LEFT JOIN rights_snapshot s ON s.pack_id = k.pack_id LEFT JOIN revenue_event e ON e.vc_id = s.vc_id AND e.event_type = 'PURCHASE'
      WHERE k.facts_scope_id = ANY($1) GROUP BY k.facts_scope_id`, [scopes])).rows.map((r) => [r.facts_scope_id as string, r])));
  return scopes.map((sc) => {
    const cs = claims.filter((c) => c.facts_scope_id === sc);
    const u = usage.get(sc);
    return {
      factsScopeId: sc, workId: cs[0].work_id as string, title: cs[0].title as string, iswc: (cs[0].iswc as string | null) ?? null,
      authors: cs.map((c) => ({ partyId: c.target_id as string, displayName: c.display_name as string, shareBps: c.share_bps as number })),
      usage: { combinations: (u?.combos as number) ?? 0, purchases: (u?.events as number) ?? 0, amountKrw: (u?.amount as string) ?? "0" },
    };
  });
}

// ── 유통 파트너의 상품 대응(TD10) ─────────────────────────────────────────────────────────────
/** 파트너가 자기 상품 코드 → 조합 대응을 제안한다. 그 조합의 팩을 가진 권리 테넌트와 유통 연결이 활성이어야 한다. */
export async function proposeAsset(tx: Tx, clock: Clock, actor: Actor, b: { externalId?: unknown; vcId?: unknown }) {
  if (actor.tenantType !== "B2B_PARTNER") throw new DomainError("PARTNER_ONLY", 403, "only distribution partners propose product mappings");
  requirePermission(actor, "asset.propose");
  if (typeof b.externalId !== "string" || b.externalId.trim() === "" || typeof b.vcId !== "string") throw invalid("BAD_REQUEST", "externalId and vcId are required");
  const externalId = b.externalId.trim();
  const owner = await withSystemScope(tx, async () => (await tx.query(
    "SELECT k.owner_tenant_id FROM rights_snapshot s JOIN vocal_pack k ON k.pack_id = s.pack_id WHERE s.vc_id = $1 LIMIT 1", [b.vcId])).rows[0]?.owner_tenant_id as string | undefined);
  if (owner === undefined) throw notFound("combination", b.vcId);
  const link = await withSystemScope(tx, async () => (await tx.query(
    "SELECT link_id FROM participant_link WHERE link_type = 'DISTRIBUTION' AND status = 'ACTIVE' AND participant_tenant_id = $1 AND rights_tenant_id = $2", [actor.tenantId, owner])).rows[0]?.link_id as string | undefined);
  if (link === undefined) throw conflict("NO_DISTRIBUTION_LINK", `no active distribution link between ${actor.tenantId} and ${owner}`);
  await tx.query("INSERT INTO partner_asset (tenant_id, external_id, vc_id, created_by, created_at, status, link_id) VALUES ($1,$2,$3,$4,$5,'PROPOSED',$6)",
    [actor.tenantId, externalId, b.vcId, actor.userId, clock.now(), link]);
  await audit(tx, clock, { actor: actor.userId, action: "PARTNER_ASSET_PROPOSED", entityType: "partner_asset", entityId: `${actor.tenantId}/${externalId}`, after: { vcId: b.vcId, link } });
  return { tenantId: actor.tenantId, externalId, vcId: b.vcId, status: "PROPOSED" as const };
}

/** 권리 테넌트가 자기 조합에 대한 파트너의 상품 대응 제안을 확인·거절한다. */
export async function decideAsset(tx: Tx, clock: Clock, actor: Actor, partnerTenantId: string, externalId: string, accept: boolean) {
  requirePermission(actor, "link.decide");
  return withSystemScope(tx, async () => {
    const a = (await tx.query(
      `SELECT a.status, a.vc_id, k.owner_tenant_id FROM partner_asset a JOIN rights_snapshot s ON s.vc_id = a.vc_id JOIN vocal_pack k ON k.pack_id = s.pack_id
        WHERE a.tenant_id = $1 AND a.external_id = $2 LIMIT 1 FOR UPDATE OF a`, [partnerTenantId, externalId])).rows[0];
    if (a === undefined || a.owner_tenant_id !== actor.tenantId) throw notFound("product mapping", `${partnerTenantId}/${externalId}`);
    if (a.status !== "PROPOSED") throw conflict("INVALID_STATE", `mapping ${partnerTenantId}/${externalId} is ${a.status}`);
    await tx.query("UPDATE partner_asset SET status = $3, decided_by = $4, decided_at = $5 WHERE tenant_id = $1 AND external_id = $2",
      [partnerTenantId, externalId, accept ? "CONFIRMED" : "DECLINED", actor.userId, clock.now()]);
    await audit(tx, clock, { actor: actor.userId, action: accept ? "PARTNER_ASSET_CONFIRMED" : "PARTNER_ASSET_DECLINED", entityType: "partner_asset", entityId: `${partnerTenantId}/${externalId}` });
    return { tenantId: partnerTenantId, externalId, vcId: a.vc_id as string, status: accept ? "CONFIRMED" : "DECLINED" };
  });
}

/** 상품 대응 목록: 파트너는 자기 것, 권리 테넌트는 자기 조합에 대한 것, 플랫폼은 전부. */
export async function listAssetMappings(tx: Tx, actor: Actor) {
  return withSystemScope(tx, async () => (await tx.query(
    `SELECT a.tenant_id, t.name AS partner_name, a.external_id, a.vc_id, a.status, a.created_at, a.decided_at, k.owner_tenant_id
       FROM partner_asset a JOIN tenant t ON t.tenant_id = a.tenant_id
       LEFT JOIN LATERAL (SELECT k.owner_tenant_id FROM rights_snapshot s JOIN vocal_pack k ON k.pack_id = s.pack_id WHERE s.vc_id = a.vc_id LIMIT 1) k ON true
      WHERE $1 OR a.tenant_id = $2 OR k.owner_tenant_id = $2 ORDER BY a.created_at DESC, a.external_id`, [actor.scope === "platform", actor.tenantId])).rows.map((r) => ({
    partnerTenantId: r.tenant_id as string, partnerName: r.partner_name as string, externalId: r.external_id as string, vcId: r.vc_id as string,
    status: r.status as string, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at) ?? null, ownerTenantId: (r.owner_tenant_id as string | null) ?? null,
  })));
}
