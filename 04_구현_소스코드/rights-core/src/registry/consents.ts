import { consentToRule, validateConsentRule, type ConsentRow } from "../engine-bridge/grant.ts";
import { requireRole, withSystemScope, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import { enqueue } from "../platform/outbox.ts";
import { notifyParty } from "../performer/notifications.ts";
import { isIdentityVerified } from "../performer/identity.ts";

export type RightType = "PERFORMER" | "MASTER" | "WORK";
export type ConsentDraft = {
  consentId: string; factsScopeId: string; partyId: string; rightType: RightType; assetId: string;
  scope: { actions: string[]; territories: string[]; media: string[]; audience: string[] };
  validFrom: string; validTo: string; sourceContractUri?: string;
};
export type Consent = {
  consentId: string; factsScopeId: string; partyId: string; rightType: string; assetId: string;
  scope: { actions: string[]; territories: string[]; media: string[]; audience: string[] };
  validFrom: string; validTo: string; status: "SIGNED" | "REVOKED"; signedBy: string; signedAt: string;
  revokedBy?: string; revokedAt?: string; revokeReason?: string; sourceContractUri?: string;
};

/**
 * 누가 서명할 수 있나. 실연 동의는 실연자 본인(PERFORMER, 자기 파티)만 한다. 권리자 포털·대리 서명은 받지 않는다.
 * 녹음·작품 허락은 그 파티가 소속된 테넌트의 RIGHTS_EDITOR가 한다(파티 소속은 RLS가 확인한다).
 * 플랫폼은 종이 계약을 옮겨 적을 때만 서명을 대신 기록하며, 그때는 계약 원문 URI가 있어야 한다.
 */
function authorize(actor: Actor, partyId: string, rightType: string, contractUri?: string): void {
  if (actor.scope === "platform") {
    if (contractUri === undefined) throw new DomainError("CONTRACT_REQUIRED", 422, "platform-recorded consent needs sourceContractUri");
    return;
  }
  if (rightType === "PERFORMER") {
    requireRole(actor, "PERFORMER");
    if (actor.partyId !== partyId) throw new DomainError("NOT_SELF", 403, `${actor.userId} can only sign consents for its own party`);
    return;
  }
  requireRole(actor, "RIGHTS_EDITOR");
}

/** 대상 자산 확인(곡 전체를 봐야 하므로 system 범위): 실연은 그 파티 소유 보이스, 녹음은 범위의 녹음, 작품은 범위의 작품. */
async function checkAsset(tx: Tx, d: ConsentDraft): Promise<void> {
  const ok = await withSystemScope(tx, async () => {
    const scope = (await tx.query("SELECT work_id FROM facts_scope WHERE facts_scope_id = $1", [d.factsScopeId])).rows[0];
    if (scope === undefined) return false;
    if (d.rightType === "WORK") return d.assetId === scope.work_id;
    if (d.rightType === "MASTER") {
      return (await tx.query("SELECT 1 FROM recording_version WHERE recording_id = $1 AND work_id = $2", [d.assetId, scope.work_id])).rowCount !== 0;
    }
    return (await tx.query(
      `SELECT 1 FROM voice v JOIN right_claim c ON c.source_id = v.voice_id AND c.edge = 'OWNED_BY' AND c.superseded_at IS NULL AND c.status IN ('VERIFIED','ASSERTED')
        WHERE v.voice_id = $1 AND v.facts_scope_id = $2 AND c.target_id = $3`, [d.assetId, d.factsScopeId, d.partyId],
    )).rowCount !== 0;
  });
  if (!ok) throw invalid("CONSENT_ASSET_MISMATCH", `${d.rightType} consent of ${d.partyId} cannot target ${d.assetId} in ${d.factsScopeId}`);
}

export async function signConsent(tx: Tx, clock: Clock, actor: Actor, d: ConsentDraft): Promise<Consent> {
  authorize(actor, d.partyId, d.rightType, d.sourceContractUri);
  // 실연자 본인 서명은 본인 인증을 마친 계정만(플랫폼의 계약서 옮겨 적기는 계약 원문이 근거다).
  if (d.rightType === "PERFORMER" && actor.scope !== "platform" && !(await isIdentityVerified(tx, actor.userId))) {
    throw new DomainError("IDENTITY_REQUIRED", 403, `${actor.userId} must complete identity verification before signing`);
  }
  await checkAsset(tx, d);
  const signedAt = clock.now();
  const draft: ConsentRow = {
    consent_id: d.consentId, party_id: d.partyId, right_type: d.rightType, asset_id: d.assetId,
    scope_actions: d.scope?.actions ?? [], territories: d.scope?.territories ?? [], media: d.scope?.media ?? [], audience: d.scope?.audience ?? [],
    valid_from: new Date(d.validFrom), valid_to: new Date(d.validTo), signed_at: new Date(signedAt), revoked_at: null,
  };
  if (Number.isNaN(draft.valid_from.getTime()) || Number.isNaN(draft.valid_to.getTime())) throw invalid("CONSENT_INVALID", "validFrom and validTo must be instants");
  const diags = validateConsentRule(consentToRule(draft));
  if (diags.length > 0) throw invalid("CONSENT_INVALID", `consent ${d.consentId} is not a valid grant rule`, diags);
  await tx.query(
    `INSERT INTO consent_agreement (consent_id, facts_scope_id, party_id, right_type, asset_id, scope_actions, territories, media, audience,
                                    valid_from, valid_to, source_contract_uri, signed_by, signed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [d.consentId, d.factsScopeId, d.partyId, d.rightType, d.assetId, draft.scope_actions, draft.territories, draft.media, draft.audience,
      d.validFrom, d.validTo, d.sourceContractUri ?? null, actor.userId, signedAt],
  );
  await audit(tx, clock, { actor: actor.userId, action: "CONSENT_SIGN", entityType: "consent_agreement", entityId: d.consentId, after: { partyId: d.partyId, rightType: d.rightType, assetId: d.assetId } });
  return getConsent(tx, d.consentId);
}

/**
 * 철회: 동의한 쪽(본인·파티의 테넌트) 또는 기록한 테넌트가 한다(RLS가 확인). 한 번만 가능하다.
 * 철회는 Outbox consent_revoked로 알린다. 발행 게이트·노출 중지는 이 사건을 받는다(다음 작업 3·8).
 */
export async function revokeConsent(tx: Tx, clock: Clock, actor: Actor, consentId: string, reason: string): Promise<Consent> {
  if (typeof reason !== "string" || reason.trim() === "") throw new DomainError("BAD_REQUEST", 400, "reason is required");
  const cur = (await tx.query("SELECT party_id, right_type, facts_scope_id, revoked_at FROM consent_agreement WHERE consent_id = $1 FOR UPDATE", [consentId])).rows[0];
  if (cur === undefined) throw notFound("consent", consentId);
  if (cur.right_type === "PERFORMER" && actor.scope !== "platform") {
    requireRole(actor, "PERFORMER");
    if (actor.partyId !== cur.party_id) throw new DomainError("NOT_SELF", 403, `${actor.userId} can only revoke its own consents`);
  } else if (actor.scope !== "platform") {
    requireRole(actor, "RIGHTS_EDITOR");
  }
  if (cur.revoked_at !== null) throw conflict("CONSENT_ALREADY_REVOKED", `consent ${consentId} was revoked at ${iso(cur.revoked_at)}`);
  const at = clock.now();
  await tx.query("UPDATE consent_agreement SET revoked_by = $2, revoked_at = $3, revoke_reason = $4 WHERE consent_id = $1", [consentId, actor.userId, at, reason]);
  await audit(tx, clock, { actor: actor.userId, action: "CONSENT_REVOKE", entityType: "consent_agreement", entityId: consentId, after: { reason } });
  await enqueue(tx, clock, "consent_revoked", { consentId, factsScopeId: cur.facts_scope_id as string, partyId: cur.party_id as string, revokedAt: at });
  await notifyParty(tx, clock, cur.party_id as string, { kind: "CONSENT", title: "동의를 철회했습니다", body: `동의 ${consentId}가 철회됐습니다. 이 보이스를 쓰는 새 조합은 발행되지 않습니다.`, ref: { consentId } });
  return getConsent(tx, consentId);
}

function toConsent(r: any): Consent {
  return {
    consentId: r.consent_id, factsScopeId: r.facts_scope_id, partyId: r.party_id, rightType: r.right_type, assetId: r.asset_id,
    scope: { actions: r.scope_actions, territories: r.territories, media: r.media, audience: r.audience },
    validFrom: iso(r.valid_from)!, validTo: iso(r.valid_to)!, status: r.revoked_at === null ? "SIGNED" : "REVOKED",
    signedBy: r.signed_by, signedAt: iso(r.signed_at)!,
    ...(r.revoked_at !== null && { revokedBy: r.revoked_by, revokedAt: iso(r.revoked_at)!, revokeReason: r.revoke_reason }),
    ...(r.source_contract_uri !== null && { sourceContractUri: r.source_contract_uri }),
  };
}

export async function getConsent(tx: Tx, consentId: string): Promise<Consent> {
  const r = (await tx.query("SELECT * FROM consent_agreement WHERE consent_id = $1", [consentId])).rows[0];
  if (r === undefined) throw notFound("consent", consentId);
  return toConsent(r);
}

/** 요청자 범위에서 보이는 동의 목록. 범위·파티로 거른다. consent_id 순. */
export async function listConsents(tx: Tx, f: { scope?: string; party?: string }): Promise<Consent[]> {
  const p: unknown[] = [];
  const w: string[] = [];
  if (f.scope !== undefined) { p.push(f.scope); w.push(`facts_scope_id = $${p.length}`); }
  if (f.party !== undefined) { p.push(f.party); w.push(`party_id = $${p.length}`); }
  return (await tx.query(`SELECT * FROM consent_agreement ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY consent_id`, p)).rows.map(toConsent);
}

/**
 * 계약서 일괄 반영(플랫폼 온보딩): 한 곡(범위)의 현재 권리 주장에서 허락 주체를 찾아, 계약서를 근거로 동의를 한꺼번에 기록한다.
 * 녹음 = CONTROLLED_BY 파티, 작품 = WRITTEN_BY 파티 각각, 보이스 = OWNED_BY 파티. 이미 같은 id의 동의가 있으면 건너뛴다.
 * 실연자 본인 서명을 대신하는 것이 아니라 종이 계약을 옮겨 적는 것이므로 플랫폼 범위와 계약 URI가 필요하다.
 */
export async function recordContractConsents(
  tx: Tx, clock: Clock, actor: Actor,
  input: { factsScopeId: string; scope: ConsentDraft["scope"]; validFrom: string; validTo: string; contractUri: string },
): Promise<string[]> {
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators can record contract consents");
  const grantors = await withSystemScope(tx, async () => (await tx.query(
    `SELECT DISTINCT CASE c.edge WHEN 'CONTROLLED_BY' THEN 'MASTER' WHEN 'WRITTEN_BY' THEN 'WORK' ELSE 'PERFORMER' END AS right_type,
            c.source_id AS asset_id, c.target_id AS party_id
       FROM right_claim c
      WHERE c.facts_scope_id = $1 AND c.edge IN ('CONTROLLED_BY','WRITTEN_BY','OWNED_BY') AND c.superseded_at IS NULL AND c.status IN ('VERIFIED','ASSERTED')
      ORDER BY 1, 2, 3`, [input.factsScopeId],
  )).rows);
  const recorded: string[] = [];
  for (const g of grantors) {
    const consentId = `cst_${input.factsScopeId}_${g.right_type.toLowerCase()}_${g.asset_id}_${g.party_id}`;
    if ((await tx.query("SELECT 1 FROM consent_agreement WHERE consent_id = $1", [consentId])).rowCount !== 0) continue;
    await signConsent(tx, clock, actor, {
      consentId, factsScopeId: input.factsScopeId, partyId: g.party_id, rightType: g.right_type, assetId: g.asset_id,
      scope: input.scope, validFrom: input.validFrom, validTo: input.validTo, sourceContractUri: input.contractUri,
    });
    recorded.push(consentId);
  }
  return recorded;
}
