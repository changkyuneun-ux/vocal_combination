import { withSystemScope, type Actor, type OrgClass, type TenantStatus } from "./actor.ts";
import { audit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { iso, type Tx } from "./db.ts";
import { conflict, DomainError, invalid, notFound } from "./errors.ts";
import { requirePermission } from "./permissions.ts";

/**
 * 권리 테넌트·참여 기관의 등록과 수명주기(테넌트 정책 7절, 결정 TD5·TD7, 진행 TN1·TN3).
 * 신청 → 확인됨(사업자·대표자·플랫폼 계약) → 활성(권리 보유 증빙 / 기관 자격) ⇄ 정지 → 해지.
 * 상태의 효과: 로그인·쓰기는 actor.ts(loadActor)와 withActor가, 활성화·발행은 assertOwnerTenantActive가, 지급 보류는 지급 실행이 본다.
 */
export const REGISTRABLE_TYPES = ["LABEL", "AGENCY", "PUBLISHER", "INDEPENDENT_ARTIST", "CMO", "B2B_PARTNER"] as const;
export type CheckItem = "BUSINESS_ID" | "IDENTITY" | "REPRESENTATIVE" | "PLATFORM_AGREEMENT" | "RIGHTS_EVIDENCE" | "TRUST_LICENSE" | "DISTRIBUTION_AGREEMENT";
const CHECK_ITEMS: readonly CheckItem[] = ["BUSINESS_ID", "IDENTITY", "REPRESENTATIVE", "PLATFORM_AGREEMENT", "RIGHTS_EVIDENCE", "TRUST_LICENSE", "DISTRIBUTION_AGREEMENT"];

/** 그 상태로 가려면 확인해야 하는 항목(TD5). 독립 아티스트는 사업자 대신 본인 확인이고 대표자 항목이 없다. */
export function requiredChecks(tenantType: string, to: "VERIFIED" | "ACTIVE"): CheckItem[] {
  const verified: CheckItem[] = tenantType === "INDEPENDENT_ARTIST" ? ["IDENTITY", "PLATFORM_AGREEMENT"] : ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT"];
  if (to === "VERIFIED") return verified;
  return [...verified, tenantType === "CMO" ? "TRUST_LICENSE" : tenantType === "B2B_PARTNER" ? "DISTRIBUTION_AGREEMENT" : "RIGHTS_EVIDENCE"];
}

const TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  APPLIED: ["VERIFIED", "TERMINATED"],
  VERIFIED: ["ACTIVE", "TERMINATED"],
  ACTIVE: ["SUSPENDED", "TERMINATED"],
  SUSPENDED: ["ACTIVE", "TERMINATED"],
  TERMINATED: [],
};

function assertPlatform(actor: Actor): void {
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators manage organizations");
}

export async function registerTenant(tx: Tx, clock: Clock, actor: Actor, b: Record<string, unknown>) {
  requirePermission(actor, "tenant.onboard");
  assertPlatform(actor);
  const { tenantId, tenantType, name } = b;
  if (typeof tenantId !== "string" || typeof tenantType !== "string" || typeof name !== "string" || name.trim() === "") {
    throw new DomainError("BAD_REQUEST", 400, "missing required fields: tenantId, tenantType, name");
  }
  if (!/^tnt_[a-z0-9_]+$/.test(tenantId)) throw new DomainError("BAD_REQUEST", 400, "tenantId must look like tnt_<소문자·숫자·_>");
  if (!(REGISTRABLE_TYPES as readonly string[]).includes(tenantType)) throw new DomainError("BAD_REQUEST", 400, `tenantType must be one of ${REGISTRABLE_TYPES.join(", ")}`);
  const opt = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string).trim() : null);
  const country = opt("country");
  if (country !== null && !/^[A-Z]{2}$/.test(country)) throw invalid("BAD_REQUEST", "country must be an ISO 3166-1 alpha-2 code (KR, US …)");
  if ((await tx.query("SELECT 1 FROM tenant WHERE tenant_id = $1", [tenantId])).rowCount !== 0) throw new DomainError("TENANT_EXISTS", 409, `tenant ${tenantId} exists`);
  await tx.query(
    "INSERT INTO tenant (tenant_id, tenant_type, name, status, created_at, business_no, country, representative, status_changed_at) VALUES ($1,$2,$3,'APPLIED',$4,$5,$6,$7,$4)",
    [tenantId, tenantType, name.trim(), clock.now(), opt("businessNo"), country, opt("representative")]);
  await audit(tx, clock, { actor: actor.userId, action: "TENANT_REGISTER", entityType: "tenant", entityId: tenantId, after: { tenantType, name: name.trim(), status: "APPLIED" } });
  return { tenantId, status: "APPLIED" as const };
}

/** 조직 정보 고치기(이름·사업자번호·국가·대표자): 운영만. */
export async function updateTenantInfo(tx: Tx, clock: Clock, actor: Actor, tenantId: string, b: Record<string, unknown>) {
  assertPlatform(actor);
  requirePermission(actor, "tenant.onboard");
  const t = await tenantRow(tx, tenantId);
  if (t.org_class === "PLATFORM" || t.org_class === "INDIVIDUAL") throw invalid("BAD_REQUEST", "internal organizations have no organization info");
  const fields: [string, string][] = [["name", "name"], ["businessNo", "business_no"], ["country", "country"], ["representative", "representative"]];
  const sets: string[] = [];
  const p: unknown[] = [tenantId];
  for (const [k, col] of fields) {
    if (b[k] === undefined) continue;
    const v = typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string).trim() : null;
    if (k === "name" && v === null) throw invalid("BAD_REQUEST", "name cannot be empty");
    if (k === "country" && v !== null && !/^[A-Z]{2}$/.test(v)) throw invalid("BAD_REQUEST", "country must be an ISO 3166-1 alpha-2 code");
    p.push(v); sets.push(`${col} = $${p.length}`);
  }
  if (sets.length === 0) throw invalid("BAD_REQUEST", "nothing to change");
  await tx.query(`UPDATE tenant SET ${sets.join(", ")} WHERE tenant_id = $1`, p);
  await audit(tx, clock, { actor: actor.userId, action: "TENANT_UPDATE", entityType: "tenant", entityId: tenantId, after: b });
  return getTenant(tx, tenantId);
}

async function tenantRow(tx: Tx, tenantId: string) {
  const t = (await tx.query("SELECT * FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  return t;
}

/** 확인 항목 체크·해제(운영 ONBOARDING·SPACE_OPS). 근거 원천 문서를 함께 적을 수 있다. */
export async function setCheck(tx: Tx, clock: Clock, actor: Actor, tenantId: string, item: string, b: { checked?: unknown; note?: unknown; documentId?: unknown }) {
  assertPlatform(actor);
  requirePermission(actor, "tenant.onboard");
  if (!CHECK_ITEMS.includes(item as CheckItem)) throw invalid("BAD_REQUEST", `item must be one of ${CHECK_ITEMS.join(", ")}`);
  if (typeof b.checked !== "boolean") throw invalid("BAD_REQUEST", "checked must be true or false");
  const t = await tenantRow(tx, tenantId);
  if (t.org_class === "PLATFORM" || t.org_class === "INDIVIDUAL") throw invalid("BAD_REQUEST", "internal organizations have no checks");
  if (t.status === "TERMINATED") throw conflict("TENANT_INACTIVE", `${tenantId} is TERMINATED`);
  await tx.query("DELETE FROM tenant_check WHERE tenant_id = $1 AND item = $2", [tenantId, item]);
  if (b.checked) {
    await tx.query("INSERT INTO tenant_check (tenant_id, item, checked_by, checked_at, note, document_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [tenantId, item, actor.userId, clock.now(), typeof b.note === "string" && b.note.trim() !== "" ? b.note.trim() : null, typeof b.documentId === "string" ? b.documentId : null]);
  }
  await audit(tx, clock, { actor: actor.userId, action: b.checked ? "TENANT_CHECK" : "TENANT_UNCHECK", entityType: "tenant", entityId: tenantId, after: { item } });
  return getTenant(tx, tenantId);
}

/**
 * 상태 바꾸기(TD7). 확인됨·활성은 필요한 확인 항목이 모두 있어야 한다(ONBOARDING·SPACE_OPS).
 * 정지·재개·해지는 SPACE_OPS·COMPLIANCE가 사유와 함께 한다. 정지·해지되면 그 조직 소속으로 열린 세션을 끝낸다.
 * 해지는 연결(신탁·유통)도 끝낸다(onTerminate — 연결 모듈이 붙인다).
 */
export async function setTenantStatus(tx: Tx, clock: Clock, actor: Actor, tenantId: string, b: { status?: unknown; reason?: unknown },
  hooks: { onTerminate?: (tx: Tx, tenantId: string) => Promise<void> } = {}) {
  assertPlatform(actor);
  const to = b.status as TenantStatus;
  if (!["VERIFIED", "ACTIVE", "SUSPENDED", "TERMINATED"].includes(to)) throw invalid("BAD_REQUEST", "status must be VERIFIED, ACTIVE, SUSPENDED or TERMINATED");
  const t = (await tx.query("SELECT * FROM tenant WHERE tenant_id = $1 FOR UPDATE", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  if (t.org_class === "PLATFORM" || t.org_class === "INDIVIDUAL") throw invalid("BAD_REQUEST", "internal organizations have no lifecycle");
  const from = t.status as TenantStatus;
  if (!TRANSITIONS[from].includes(to)) throw conflict("INVALID_TRANSITION", `${tenantId}: ${from} → ${to} is not allowed`);
  const reason = typeof b.reason === "string" && b.reason.trim() !== "" ? b.reason.trim() : null;
  const enabling = (to === "VERIFIED" || to === "ACTIVE") && from !== "SUSPENDED";
  if (enabling) {
    requirePermission(actor, "tenant.onboard");
    const have = new Set((await tx.query("SELECT item FROM tenant_check WHERE tenant_id = $1", [tenantId])).rows.map((r) => r.item as string));
    const missing = requiredChecks(t.tenant_type, to as "VERIFIED" | "ACTIVE").filter((i) => !have.has(i));
    if (missing.length > 0) throw invalid("CHECKS_MISSING", `${tenantId} → ${to} needs checks: ${missing.join(", ")}`, missing.map((m) => ({ code: "CHECK_MISSING", path: m, message: m })));
  } else {
    requirePermission(actor, "tenant.suspend");
    if (reason === null) throw invalid("REASON_REQUIRED", `a reason is required to move ${tenantId} to ${to}`);
  }
  await tx.query("UPDATE tenant SET status = $2, status_changed_at = $3, status_reason = $4 WHERE tenant_id = $1", [tenantId, to, clock.now(), reason]);
  if (to === "SUSPENDED" || to === "TERMINATED") {
    await tx.query("UPDATE user_session SET revoked_at = $2 WHERE revoked_at IS NULL AND (tenant_id = $1 OR (tenant_id IS NULL AND user_id IN (SELECT user_id FROM user_account WHERE tenant_id = $1)))",
      [tenantId, clock.now()]);
  }
  if (to === "TERMINATED" && hooks.onTerminate) await hooks.onTerminate(tx, tenantId);
  await audit(tx, clock, { actor: actor.userId, action: "TENANT_STATUS", entityType: "tenant", entityId: tenantId, after: { from, to, reason } });
  return getTenant(tx, tenantId);
}

export type TenantView = {
  tenantId: string; tenantType: string; orgClass: OrgClass; name: string; status: TenantStatus; createdAt: string; statusChangedAt: string | null; statusReason: string | null;
  businessNo: string | null; country: string | null; representative: string | null; validationEnforced: boolean;
  checks: { item: CheckItem; checkedBy: string; checkedAt: string; note: string | null; documentId: string | null }[];
  required: { VERIFIED: CheckItem[]; ACTIVE: CheckItem[] } | null; next: TenantStatus[];
};

/** 조직 상세(확인 항목·다음 상태 포함). 호출 쪽이 범위를 정한다(플랫폼은 전부, 조직은 자기 것만). */
export async function getTenant(tx: Tx, tenantId: string): Promise<TenantView> {
  const t = await tenantRow(tx, tenantId);
  const checks = (await tx.query("SELECT * FROM tenant_check WHERE tenant_id = $1 ORDER BY item", [tenantId])).rows.map((r) => ({
    item: r.item as CheckItem, checkedBy: r.checked_by as string, checkedAt: iso(r.checked_at)!, note: r.note as string | null, documentId: r.document_id as string | null,
  }));
  const internal = t.org_class === "PLATFORM" || t.org_class === "INDIVIDUAL";
  return {
    tenantId, tenantType: t.tenant_type, orgClass: t.org_class, name: t.name, status: t.status, createdAt: iso(t.created_at)!,
    statusChangedAt: iso(t.status_changed_at) ?? null, statusReason: t.status_reason, businessNo: t.business_no, country: t.country, representative: t.representative,
    validationEnforced: t.validation_enforced, checks,
    required: internal ? null : { VERIFIED: requiredChecks(t.tenant_type, "VERIFIED"), ACTIVE: requiredChecks(t.tenant_type, "ACTIVE") },
    next: internal ? [] : TRANSITIONS[t.status as TenantStatus],
  };
}

/**
 * 권리 데이터를 판매·발행에 쓰려면 등록한 테넌트가 활성이어야 한다(TD7: 확인됨은 등록까지, 정지는 판매 중지).
 * 곡(facts 범위)의 소유 테넌트를 본다. 플랫폼 소유 곡은 늘 통과한다.
 */
export async function assertOwnerTenantActive(tx: Tx, factsScopeId: string, what: "activate" | "issue"): Promise<void> {
  const r = (await tx.query(
    "SELECT t.tenant_id, t.status FROM facts_scope s JOIN tenant t ON t.tenant_id = s.owner_tenant_id WHERE s.facts_scope_id = $1", [factsScopeId])).rows[0];
  if (r === undefined || r.status === "ACTIVE") return;
  throw conflict(what === "issue" ? "TENANT_NOT_SELLING" : "TENANT_NOT_ACTIVE",
    `${r.tenant_id} is ${r.status}: ${what === "issue" ? "its packs are not on sale" : "packs and policies can be activated only by an ACTIVE tenant"}`);
}

/**
 * 관리 이관(TN2): 당사자의 관리 주체를 옮긴다(플랫폼 온보딩·운영, 사유 필수). 넘겨받은 쪽은 과거 명세도 본다(명세는 당사자 열쇠).
 * 개인이 가입하거나 권리 테넌트·신탁단체가 맡을 때, 해지한 테넌트의 당사자를 옮길 때 쓴다. 플랫폼으로는 옮기지 않는다(결정 WD1).
 */
export async function transferParty(tx: Tx, clock: Clock, actor: Actor, partyId: string, b: { tenantId?: unknown; reason?: unknown }) {
  requirePermission(actor, "tenant.onboard");
  assertPlatform(actor);
  if (typeof b.tenantId !== "string") throw invalid("BAD_REQUEST", "tenantId is required");
  if (typeof b.reason !== "string" || b.reason.trim() === "") throw invalid("REASON_REQUIRED", "a reason is required to change a party's manager");
  return withSystemScope(tx, async () => {
    const p = (await tx.query("SELECT party_type, tenant_id FROM party WHERE party_id = $1 FOR UPDATE", [partyId])).rows[0];
    if (p === undefined) throw notFound("party", partyId);
    const t = await tenantRow(tx, b.tenantId as string);
    if (t.status === "TERMINATED") throw conflict("TENANT_INACTIVE", `${t.tenant_id} is TERMINATED`);
    if (p.tenant_id === t.tenant_id) throw conflict("NO_CHANGE", `${partyId} is already managed by ${t.tenant_id}`);
    if (t.org_class === "PLATFORM") throw invalid("PARTY_NOT_ALLOWED", "the platform does not manage parties (WD1); without a successor the party stays unmanaged");
    const individual = ["MEMBER", "ARTIST", "AUTHOR", "SESSION", "FAN"].includes(p.party_type);
    if (t.org_class === "INDIVIDUAL" && !individual) throw invalid("PARTY_NOT_ALLOWED", `${p.party_type} is an organization`);
    if (t.org_class === "PARTICIPANT") {
      if (t.tenant_type !== "CMO") throw invalid("PARTY_NOT_ALLOWED", "a distribution partner is not a payee party");
      if ((await tx.query("SELECT 1 FROM party WHERE tenant_id = $1", [t.tenant_id])).rowCount !== 0) throw invalid("PARTY_NOT_ALLOWED", `${t.tenant_id} already has its party`);
    }
    await tx.query("UPDATE party SET tenant_id = $2 WHERE party_id = $1", [partyId, t.tenant_id]);
    await audit(tx, clock, { actor: actor.userId, action: "PARTY_MANAGER_CHANGE", entityType: "party", entityId: partyId, after: { from: p.tenant_id, to: t.tenant_id, reason: (b.reason as string).trim() } });
    return { partyId, from: p.tenant_id as string, to: t.tenant_id as string, managerKind: managerKind(t.org_class) };
  });
}

/** 관리 주체 종류(테넌트 정책 TR3, 결정 WD1): 권리 테넌트·본인·참여 기관. 그 밖(플랫폼 소속으로 남은 옛 당사자)은 관리 주체 없음(정지). */
export function managerKind(orgClass: string): "TENANT" | "SELF" | "PARTICIPANT" | "NONE" {
  return orgClass === "RIGHTS" ? "TENANT" : orgClass === "INDIVIDUAL" ? "SELF" : orgClass === "PARTICIPANT" ? "PARTICIPANT" : "NONE";
}

/**
 * 독립 아티스트 1인 온보딩(TN12): 본인 인증을 마친 개인 계정으로 1인 권리 테넌트를 신청 상태로 만들고, 본인 확인 항목을 채우고,
 * 그 계정에 관리자·권리 편집·정책(편집·승인·활성화) 소속을 더하고, 본인 당사자의 관리 주체를 새 테넌트로 옮긴다. 플랫폼 계약 확인 뒤 확인됨으로 올린다.
 * 같은 사람의 실연자 자격(실연자 앱)은 기본 소속 그대로다.
 */
export async function onboardIndependentArtist(tx: Tx, clock: Clock, actor: Actor, b: Record<string, unknown>) {
  requirePermission(actor, "tenant.onboard");
  assertPlatform(actor);
  if (typeof b.userId !== "string") throw invalid("BAD_REQUEST", "userId is required");
  const u = await withSystemScope(tx, async () => (await tx.query(
    "SELECT u.party_id, u.identity_verified_at, u.identity_method, t.org_class FROM user_account u JOIN tenant t ON t.tenant_id = u.tenant_id WHERE u.user_id = $1", [b.userId])).rows[0]);
  if (u === undefined) throw notFound("user", b.userId);
  if (u.org_class !== "INDIVIDUAL" || u.party_id === null) throw invalid("NOT_AN_INDIVIDUAL", `${b.userId} is not a personal account with its own party`);
  if (u.identity_verified_at === null) throw conflict("IDENTITY_REQUIRED", `${b.userId} has not verified identity yet (performer app)`);
  const t = await registerTenant(tx, clock, actor, { ...b, tenantType: "INDEPENDENT_ARTIST" });
  await setCheck(tx, clock, actor, t.tenantId, "IDENTITY", { checked: true, note: `본인 인증(${u.identity_method ?? "IDP"}) ${iso(u.identity_verified_at)}` });
  const { addMembership } = await import("./auth.ts");
  // 1인 테넌트는 혼자 모든 일을 한다. 정책은 표준 템플릿을 값 그대로 쓸 때만 혼자 승인·활성화할 수 있다(결정 TD13).
  const m = await addMembership(tx, clock, actor, b.userId, { tenantId: t.tenantId, roles: ["TENANT_ADMIN", "RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR"] });
  const moved = await transferParty(tx, clock, actor, u.party_id as string, { tenantId: t.tenantId, reason: "독립 아티스트 1인 테넌트 온보딩" });
  return { tenant: await getTenant(tx, t.tenantId), membership: m, party: moved };
}
