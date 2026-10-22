import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { actorForChannel, type Channel } from "../http/channels.ts";
import { createUser, PLATFORM_TENANT, withSystemScope, type Actor, type OrgClass, type Role } from "./actor.ts";
import { audit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { conflict, DomainError, invalid, notFound } from "./errors.ts";
import { confirmVerification, startVerification, type IdentityProvider } from "../performer/identity.ts";
import { delegatedActor } from "./delegation.ts";
import { requirePermission } from "./permissions.ts";

/**
 * 인증·세션(MVP 진행계획 M3, 결정 MD3). 코어가 세션을 발급하고, 세션은 발급한 채널(서브도메인)에서만 쓴다.
 * 운영(ops)은 비밀번호 + TOTP 필수, 권리자 포털은 비밀번호(TOTP를 켰으면 함께), 실연자 앱은 본인 인증 공급자의 일회용 코드.
 * 외부 신원 공급자(OIDC)는 이 모듈 앞에 붙일 자리만 남긴다(상용에서 운영 SSO).
 */
export type LoginMethod = "PASSWORD" | "PASSWORD_TOTP" | "OTP" | "DEV";
export const SESSION_COOKIE = (channel: Channel) => `dbp_${channel}`;
/** 세션 수명: 운영은 짧게, 실연자 앱(휴대폰)은 길게. */
export const SESSION_TTL_MS: Record<Channel, number> = { ops: 8 * 3_600_000, portal: 12 * 3_600_000, performer: 30 * 86_400_000, fan: 30 * 86_400_000, partner: 12 * 3_600_000 };
const IDLE_MS: Record<Channel, number> = { ops: 2 * 3_600_000, portal: 8 * 3_600_000, performer: 30 * 86_400_000, fan: 30 * 86_400_000, partner: 8 * 3_600_000 };
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const INVITE_TTL_MS = 7 * 86_400_000;
export const MIN_PASSWORD = 10;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const at = (clock: Clock, plusMs = 0) => new Date(Date.parse(clock.now()) + plusMs).toISOString();

// ── 비밀번호(scrypt) ─────────────────────────────────────────────────────────────
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$15$8$1$${salt.toString("base64url")}$${h.toString("base64url")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = scryptSync(pw, Buffer.from(salt, "base64url"), want.length, { N: 1 << Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(want, got);
}

// ── TOTP(RFC 6238: HMAC-SHA1, 30초, 6자리) ──────────────────────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(b: Uint8Array): string {
  let bits = 0, val = 0, out = "";
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totp(secretB32: string, unixMs: number, step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixMs / 1000 / step)));
  const h = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}
/** 앞뒤 한 칸(±30초)까지 받는다(휴대폰 시계 오차). TOTP는 실제 시각 기준이다(가상 시계와 무관). */
export function verifyTotp(secretB32: string, code: unknown, unixMs = Date.now()): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((k) => totp(secretB32, unixMs + k * 30_000) === code);
}

/** TOTP 비밀은 RC_AUTH_KEY(없으면 원천 문서 키에서 유도)로 암호화해 둔다. */
function authKey(): Buffer {
  const raw = process.env.RC_AUTH_KEY ?? process.env.RC_DOC_KEY;
  const master = raw ? Buffer.from(raw, "base64") : createHash("sha256").update("rc-dev-auth-key").digest();
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("rc-auth"), Buffer.from("totp"), 32));
}
const seal = (plain: string) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", authKey(), iv); const b = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([iv, c.getAuthTag(), b]).toString("base64url"); };
const unseal = (s: string) => { const raw = Buffer.from(s, "base64url"); const d = createDecipheriv("aes-256-gcm", authKey(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString(); };

// ── 세션 ────────────────────────────────────────────────────────────────────────
export type SessionMeta = { ip?: string; userAgent?: string };

async function issueSession(tx: Tx, clock: Clock, actor: Actor, channel: Channel, method: LoginMethod, meta: SessionMeta) {
  const t = token();
  await tx.query(
    `INSERT INTO user_session (token_sha256, user_id, channel, method, created_at, expires_at, last_seen_at, ip, user_agent, tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8,$9)`,
    [sha(t), actor.userId, channel, method, clock.now(), at(clock, SESSION_TTL_MS[channel]), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, actor.tenantId]);
  await audit(tx, clock, { actor: actor.userId, action: "LOGIN", entityType: "user_account", entityId: actor.userId, after: { channel, method, tenantId: actor.tenantId } });
  return { token: t, expiresAt: at(clock, SESSION_TTL_MS[channel]) };
}

/**
 * 쿠키의 세션 → 사용자와 지금 일하는 소속. 다른 채널에서 만든 세션, 만료·폐기·잠긴 계정이면 null. 마지막 사용 시각은 5분마다만 고친다.
 */
export async function resolveSession(tx: Tx, clock: Clock, raw: string, channel: Channel): Promise<{ userId: string; tenantId: string | null; onBehalfOf: string | null } | null> {
  return withSystemScope(tx, async () => {
    const s = (await tx.query(
      `SELECT s.user_id, s.tenant_id, s.on_behalf_of, s.channel, s.expires_at, s.last_seen_at, s.revoked_at, u.disabled_at FROM user_session s JOIN user_account u USING (user_id) WHERE s.token_sha256 = $1`, [sha(raw)])).rows[0];
    if (s === undefined || s.revoked_at !== null || s.disabled_at !== null || s.channel !== channel) return null;
    const now = Date.parse(clock.now());
    if ((s.expires_at as Date).getTime() <= now || (s.last_seen_at as Date).getTime() + IDLE_MS[channel] <= now) return null;
    if ((s.last_seen_at as Date).getTime() + 5 * 60_000 <= now) await tx.query("UPDATE user_session SET last_seen_at = $2 WHERE token_sha256 = $1", [sha(raw), clock.now()]);
    return { userId: s.user_id as string, tenantId: (s.tenant_id as string | null) ?? null, onBehalfOf: (s.on_behalf_of as string | null) ?? null };
  });
}

/** 위임 대행 시작·끝(TN6): 권리자 포털 세션에 대행할 테넌트를 둔다(null이면 끝). 위임이 없으면 시작하지 못한다. */
export async function actFor(tx: Tx, clock: Clock, raw: string, channel: Channel, tenantId: unknown) {
  if (channel !== "portal") throw new DomainError("METHOD_NOT_ALLOWED", 400, "delegated work happens in the rights holder portal");
  if (tenantId !== null && typeof tenantId !== "string") throw invalid("BAD_REQUEST", "tenantId must be a tenant id or null");
  return withSystemScope(tx, async () => {
    const s = await resolveSession(tx, clock, raw, channel);
    if (s === null) throw new DomainError("UNAUTHENTICATED", 401, "sign in first");
    const actor = await eligible(tx, s.userId, channel, s.tenantId);
    if (tenantId !== null) await delegatedActor(tx, actor, tenantId);
    await tx.query("UPDATE user_session SET on_behalf_of = $2 WHERE token_sha256 = $1", [sha(raw), tenantId]);
    await audit(tx, clock, { actor: s.userId, action: tenantId === null ? "DELEGATION_END" : "DELEGATION_START", entityType: "tenant", entityId: (tenantId ?? s.onBehalfOf ?? "") as string });
    return { userId: s.userId, onBehalfOf: tenantId };
  });
}

/** 소속 전환(결정 TD9): 같은 세션에서 지금 일하는 소속을 바꾼다. 그 소속으로 이 채널에 들어올 수 있어야 한다. */
export async function switchTenant(tx: Tx, clock: Clock, raw: string, channel: Channel, tenantId: unknown) {
  if (typeof tenantId !== "string") throw invalid("BAD_REQUEST", "tenantId is required");
  return withSystemScope(tx, async () => {
    const s = await resolveSession(tx, clock, raw, channel);
    if (s === null) throw new DomainError("UNAUTHENTICATED", 401, "sign in first");
    const actor = await eligible(tx, s.userId, channel, tenantId);
    await tx.query("UPDATE user_session SET tenant_id = $2 WHERE token_sha256 = $1", [sha(raw), tenantId]);
    await audit(tx, clock, { actor: s.userId, action: "TENANT_SWITCH", entityType: "user_account", entityId: s.userId, after: { channel, from: s.tenantId, to: tenantId } });
    return { userId: s.userId, tenantId: actor.tenantId, roles: [...actor.roles].sort() };
  });
}

export async function logout(tx: Tx, clock: Clock, raw: string): Promise<void> {
  await withSystemScope(tx, () => tx.query("UPDATE user_session SET revoked_at = $2 WHERE token_sha256 = $1 AND revoked_at IS NULL", [sha(raw), clock.now()]));
}

/** 채널에 들어올 수 있는 계정인지(로그인 전에 확인해 다른 채널용 세션을 만들지 않는다). 소속을 고르면 그 소속으로 본다. */
async function eligible(tx: Tx, userId: string, channel: Channel, tenantId?: unknown): Promise<Actor> {
  const actor = await actorForChannel(tx, userId, channel, typeof tenantId === "string" && tenantId !== "" ? tenantId : undefined);
  const disabled = (await tx.query("SELECT disabled_at FROM user_account WHERE user_id = $1", [userId])).rows[0]?.disabled_at;
  if (disabled != null) throw new DomainError("ACCOUNT_DISABLED", 403, `${userId} is disabled`);
  return actor;
}

// ── 비밀번호 로그인(운영·포털) ─────────────────────────────────────────────────────────
export type LoginResult =
  | { status: "OK"; token: string; expiresAt: string; userId: string }
  | { status: "MFA_REQUIRED" }
  | { status: "MFA_ENROLL"; secret: string; otpauthUrl: string }
  /** 틀림: 실패 횟수를 남겨야 하므로 예외가 아니라 결과로 돌려준다(라우트가 401로 답하고 트랜잭션은 커밋한다). */
  | { status: "FAILED" };

const badLogin = () => new DomainError("LOGIN_FAILED", 401, "wrong login id or password");

/**
 * 운영 채널은 TOTP가 필수다. 아직 등록하지 않았으면 비밀번호가 맞을 때 등록용 비밀을 돌려주고(세션 없음), 그 비밀로 만든 첫 코드와 함께
 * 다시 로그인하면 등록을 마치고 세션을 준다. 포털은 TOTP를 켠 계정만 코드를 묻는다. 5번 틀리면 15분 잠근다.
 */
export async function passwordLogin(tx: Tx, clock: Clock, channel: Channel, input: { userId?: unknown; password?: unknown; totp?: unknown; tenantId?: unknown }, meta: SessionMeta): Promise<LoginResult> {
  if (channel !== "ops" && channel !== "portal" && channel !== "partner") throw new DomainError("METHOD_NOT_ALLOWED", 400, `${channel} does not use password login`);
  if (typeof input.userId !== "string" || typeof input.password !== "string") return { status: "FAILED" };
  const userId = input.userId;
  return withSystemScope(tx, async (): Promise<LoginResult> => {
    const c = (await tx.query("SELECT * FROM user_credential WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
    if (c === undefined || c.password_hash === null) return { status: "FAILED" as const };
    if (c.locked_until !== null && (c.locked_until as Date).toISOString() > clock.now()) throw new DomainError("ACCOUNT_LOCKED", 429, "too many failures; try again later");
    if (!verifyPassword(input.password as string, c.password_hash)) {
      const n = c.failed_count + 1;
      await tx.query("UPDATE user_credential SET failed_count = $2, locked_until = $3 WHERE user_id = $1", [userId, n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER ? at(clock, LOCK_MS) : null]);
      return { status: "FAILED" as const };
    }
    const actor = await eligible(tx, userId, channel, input.tenantId);
    const needTotp = channel === "ops" || c.totp_enabled_at !== null;
    if (needTotp) {
      if (c.totp_secret === null) {
        const secret = base32Encode(randomBytes(20));
        await tx.query("UPDATE user_credential SET totp_secret = $2 WHERE user_id = $1", [userId, seal(secret)]);
        return { status: "MFA_ENROLL" as const, secret, otpauthUrl: `otpauth://totp/dobedupop:${encodeURIComponent(userId)}?secret=${secret}&issuer=dobedupop` };
      }
      const secret = unseal(c.totp_secret);
      if (input.totp === undefined) {
        if (c.totp_enabled_at === null) return { status: "MFA_ENROLL" as const, secret, otpauthUrl: `otpauth://totp/dobedupop:${encodeURIComponent(userId)}?secret=${secret}&issuer=dobedupop` };
        return { status: "MFA_REQUIRED" as const };
      }
      if (!verifyTotp(secret, input.totp)) return { status: "FAILED" as const };
      if (c.totp_enabled_at === null) await tx.query("UPDATE user_credential SET totp_enabled_at = $2 WHERE user_id = $1", [userId, clock.now()]);
    }
    await tx.query("UPDATE user_credential SET failed_count = 0, locked_until = NULL WHERE user_id = $1", [userId]);
    const s = await issueSession(tx, clock, actor, channel, needTotp ? "PASSWORD_TOTP" : "PASSWORD", meta);
    return { status: "OK" as const, ...s, userId };
  });
}

// ── 일회용 코드 로그인(실연자 앱) ─────────────────────────────────────────────────────
/** 계정이 있는지 드러내지 않도록 없는 계정에도 같은 모양을 돌려준다(코드는 보내지 않는다). */
export async function otpStart(tx: Tx, clock: Clock, provider: IdentityProvider | undefined, channel: Channel, loginId: unknown) {
  if (channel !== "performer") throw new DomainError("METHOD_NOT_ALLOWED", 400, `${channel} does not use code login`);
  if (provider === undefined) throw new DomainError("IDENTITY_NOT_CONFIGURED", 503, "identity verification is not configured");
  if (typeof loginId !== "string") throw invalid("BAD_REQUEST", "loginId is required");
  return withSystemScope(tx, async () => {
    let actor: Actor;
    try { actor = await eligible(tx, loginId, channel); } catch { return { challengeId: 0, expiresInSeconds: 300 }; }
    return startVerification(tx, clock, provider, actor);
  });
}

export async function otpConfirm(tx: Tx, clock: Clock, channel: Channel, input: { loginId?: unknown; challengeId?: unknown; code?: unknown }, meta: SessionMeta) {
  if (channel !== "performer") throw new DomainError("METHOD_NOT_ALLOWED", 400, `${channel} does not use code login`);
  if (typeof input.loginId !== "string") throw badLogin();
  return withSystemScope(tx, async () => {
    const actor = await eligible(tx, input.loginId as string, channel).catch(() => { throw badLogin(); });
    const r = await confirmVerification(tx, clock, actor, { challengeId: Number(input.challengeId), code: input.code as string });
    if (!r.verified) return { status: "FAILED" as const, attemptsLeft: r.attemptsLeft };
    const s = await issueSession(tx, clock, actor, channel, "OTP", meta);
    return { status: "OK" as const, ...s, userId: actor.userId };
  });
}

// ── 데모 환경: 페르소나 빠른 로그인 ──────────────────────────────────────────────────
export async function devLogin(tx: Tx, clock: Clock, channel: Channel, userId: unknown, meta: SessionMeta, tenantId?: unknown) {
  if (typeof userId !== "string") throw invalid("BAD_REQUEST", "userId is required");
  return withSystemScope(tx, async () => {
    const actor = await eligible(tx, userId, channel, tenantId);
    const s = await issueSession(tx, clock, actor, channel, "DEV", meta);
    return { status: "OK" as const, ...s, userId };
  });
}

// ── 계정 발급·역할·잠금(테넌트 정책 8절, 결정 TD3·TD4) ─────────────────────────────────────────
const ID = /^[A-Za-z0-9._-]+$/;
const ALL_ROLES: readonly Role[] = ["RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR", "ISSUER", "SPACE_OPS", "SPACE_SETTLE", "PERFORMER", "COMPLIANCE", "LEGAL",
  "TENANT_ADMIN", "ONBOARDING", "TRUST_OFFICER", "PARTNER_INTEGRATION", "PLATFORM_ALL", "RIGHTS_ALL", "PARTICIPANT_ALL"];

/** 참여 구분마다 그 구분의 총괄 역할(0041). 조직 관리 권한(account.manage)을 포함하므로 첫 관리자 역할로도 줄 수 있다. */
const SUPER_ROLE: Partial<Record<OrgClass, Role>> = { PLATFORM: "PLATFORM_ALL", RIGHTS: "RIGHTS_ALL", PARTICIPANT: "PARTICIPANT_ALL" };

/**
 * 조직 종류마다 줄 수 있는 역할(6절 표). 운영 계정에는 권리 결정 역할(편집·승인·활성화·발행)을 주지 않는다(TD3).
 * 신탁단체·유통 파트너는 권리를 만들지 않으므로 권리 역할이 없다(TD12).
 */
export function assignableRoles(orgClass: OrgClass, tenantType: string): readonly Role[] {
  switch (orgClass) {
    case "RIGHTS": return ["TENANT_ADMIN", "RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR", "RIGHTS_ALL"];
    case "PARTICIPANT": return tenantType === "CMO" ? ["TENANT_ADMIN", "TRUST_OFFICER", "PARTICIPANT_ALL"] : ["TENANT_ADMIN", "PARTNER_INTEGRATION", "PARTICIPANT_ALL"];
    case "INDIVIDUAL": return ["PERFORMER"];
    case "PLATFORM": return ["SPACE_OPS", "SPACE_SETTLE", "ONBOARDING", "COMPLIANCE", "LEGAL", "PLATFORM_ALL"];
  }
}

type TenantInfo = { tenantId: string; tenantType: string; orgClass: OrgClass; status: string };
async function tenantInfo(tx: Tx, tenantId: string): Promise<TenantInfo> {
  const t = (await tx.query("SELECT tenant_id, tenant_type, org_class, status FROM tenant WHERE tenant_id = $1", [tenantId])).rows[0];
  if (t === undefined) throw notFound("tenant", tenantId);
  return { tenantId, tenantType: t.tenant_type, orgClass: t.org_class, status: t.status };
}
/** 조직 관리자가 있는지: 역할 이름 대신 조직 관리 권한(account.manage)으로 본다(총괄 역할 포함). */
async function hasAdmin(tx: Tx, tenantId: string): Promise<boolean> {
  return (await tx.query(
    `SELECT 1 FROM portal_role r JOIN role_permission rp ON rp.role_id = r.role AND rp.perm_id = 'account.manage'
       JOIN user_account u ON u.user_id = r.user_id WHERE r.tenant_id = $1 AND u.disabled_at IS NULL LIMIT 1`, [tenantId])).rowCount !== 0;
}

/**
 * 이 행위자가 그 조직의 계정을 관리할 수 있는지(결정 TD4).
 * - 플랫폼 운영: 운영 인력(SPACE_OPS), 개인 계정(SPACE_OPS·ONBOARDING), 그리고 조직 관리자가 아직 없는 조직의 첫 관리자(SPACE_OPS·ONBOARDING).
 * - 조직 관리자(TENANT_ADMIN): 자기 조직(지금 일하는 소속)의 계정만.
 * firstAdmin이면 운영이 첫 관리자를 발급하는 경우라 역할은 TENANT_ADMIN만 줄 수 있다.
 */
async function adminScope(tx: Tx, actor: Actor, t: TenantInfo): Promise<{ firstAdmin: boolean }> {
  if (actor.scope === "platform") {
    if (t.orgClass === "PLATFORM") {
      requirePermission(actor, "staff.manage");
      return { firstAdmin: false };
    }
    requirePermission(actor, "account.onboard");
    if (t.orgClass === "INDIVIDUAL") return { firstAdmin: false };
    if (await hasAdmin(tx, t.tenantId)) throw new DomainError("TENANT_HAS_ADMIN", 409, `${t.tenantId} has an administrator; its administrator manages its accounts`);
    return { firstAdmin: true };
  }
  requirePermission(actor, "account.manage");
  if (actor.tenantId !== t.tenantId) throw new DomainError("TENANT_FORBIDDEN", 403, `${actor.userId} administers ${actor.tenantId}, not ${t.tenantId}`);
  return { firstAdmin: false };
}

function checkRoles(t: TenantInfo, roles: unknown, firstAdmin: boolean): Role[] {
  if (!Array.isArray(roles) || !roles.every((r) => ALL_ROLES.includes(r as Role))) throw invalid("BAD_REQUEST", `roles must be among ${ALL_ROLES.join(", ")}`);
  const allowed = assignableRoles(t.orgClass, t.tenantType);
  const bad = roles.filter((r) => !allowed.includes(r as Role));
  if (bad.length > 0) throw invalid("ROLE_NOT_ASSIGNABLE", `${bad.join(", ")} cannot be given in ${t.tenantId} (${t.orgClass}); allowed: ${allowed.join(", ")}`);
  // 1인 테넌트(독립 아티스트)는 관리자가 곧 담당자라, 첫 관리자에게 권리 역할을 함께 준다(자기 역할은 스스로 못 바꾸므로).
  const adminRoles: readonly Role[] = ["TENANT_ADMIN", ...(SUPER_ROLE[t.orgClass] ? [SUPER_ROLE[t.orgClass]!] : [])];
  if (firstAdmin && t.tenantType !== "INDEPENDENT_ARTIST" && roles.some((r) => !adminRoles.includes(r as Role))) {
    throw invalid("FIRST_ADMIN_ONLY", "operators issue only the first administrator; the administrator adds the other accounts");
  }
  return [...new Set(roles as Role[])];
}

/** 행위자가 관리할 수 있는 조직의 계정인지(대상 계정이 그 조직 소속이어야 한다). */
async function targetMembership(tx: Tx, actor: Actor, userId: string, tenantId?: unknown): Promise<{ t: TenantInfo; firstAdmin: boolean }> {
  const u = (await tx.query("SELECT tenant_id FROM user_account WHERE user_id = $1", [userId])).rows[0];
  if (u === undefined) throw notFound("user", userId);
  const tid = typeof tenantId === "string" ? tenantId : actor.scope === "platform" ? u.tenant_id as string : actor.tenantId;
  if ((await tx.query("SELECT 1 FROM user_membership WHERE user_id = $1 AND tenant_id = $2", [userId, tid])).rowCount === 0) throw notFound("membership", `${userId}@${tid}`);
  const t = await tenantInfo(tx, tid);
  if (actor.scope === "platform" && (t.orgClass === "RIGHTS" || t.orgClass === "PARTICIPANT")) {
    // 운영은 조직 계정의 역할을 바꾸지 않는다. 관리자가 없는(잠긴) 조직이면 관리자를 다시 세우는 것만 한다.
    requirePermission(actor, "account.onboard");
    if (await hasAdmin(tx, t.tenantId)) throw new DomainError("TENANT_HAS_ADMIN", 409, `${t.tenantId} has an administrator; its administrator manages its accounts`);
    return { t, firstAdmin: true };
  }
  return { t, ...(await adminScope(tx, actor, t)) };
}

/**
 * 계정 만들기: 운영은 운영 인력·개인 계정·조직의 첫 관리자, 조직 관리자는 자기 조직 담당자(결정 TD4).
 * 비밀번호 로그인 계정이면 일회용 초대 토큰을 돌려준다(한 번만 보인다). 개인 계정(실연자·팬)은 본인 인증 코드로 들어온다.
 */
export async function createAccount(tx: Tx, clock: Clock, actor: Actor, b: { userId?: unknown; displayName?: unknown; tenantId?: unknown; roles?: unknown; partyId?: unknown }) {
  if (typeof b.userId !== "string" || !ID.test(b.userId)) throw invalid("BAD_REQUEST", "userId must be an id");
  if (typeof b.displayName !== "string" || b.displayName.trim() === "") throw invalid("BAD_REQUEST", "displayName is required");
  const tenantId = typeof b.tenantId === "string" ? b.tenantId : actor.scope === "platform" ? undefined : actor.tenantId;
  if (tenantId === undefined) throw invalid("BAD_REQUEST", "tenantId is required");
  return withSystemScope(tx, async () => {
    const t = await tenantInfo(tx, tenantId);
    if (t.status === "TERMINATED") throw conflict("TENANT_INACTIVE", `${tenantId} is TERMINATED`);
    const { firstAdmin } = await adminScope(tx, actor, t);
    const roles = checkRoles(t, Array.isArray(b.roles) ? b.roles : [], firstAdmin);
    if (firstAdmin && !roles.some((r) => r === "TENANT_ADMIN" || r === SUPER_ROLE[t.orgClass])) throw invalid("FIRST_ADMIN_ONLY", "the first account of an organization is its administrator (TENANT_ADMIN)");
    if ((await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [b.userId])).rowCount !== 0) throw conflict("USER_EXISTS", `user ${b.userId} exists`);
    await createUser(tx, clock, { userId: b.userId as string, displayName: (b.displayName as string).trim(), roles, tenantId, ...(typeof b.partyId === "string" && { partyId: b.partyId }) });
    await audit(tx, clock, { actor: actor.userId, action: "USER_CREATE", entityType: "user_account", entityId: b.userId as string, after: { tenantId, roles } });
    if (t.orgClass === "INDIVIDUAL") return { userId: b.userId as string, login: "OTP" as const };
    const inv = await createInvite(tx, clock, actor, b.userId as string);
    return { userId: b.userId as string, login: "PASSWORD" as const, ...inv };
  });
}

/**
 * 소속 더하기(결정 TD9): 이미 있는 계정을 다른 조직에도 소속시킨다. 그 조직의 관리자(또는 첫 관리자를 세우는 운영)가 한다.
 * 같은 사람이 실연자이면서 독립 아티스트 테넌트를 두는 경우(TN12)가 대표적이다.
 */
export async function addMembership(tx: Tx, clock: Clock, actor: Actor, userId: string, b: { tenantId?: unknown; roles?: unknown }) {
  const tenantId = typeof b.tenantId === "string" ? b.tenantId : actor.scope === "platform" ? undefined : actor.tenantId;
  if (tenantId === undefined) throw invalid("BAD_REQUEST", "tenantId is required");
  return withSystemScope(tx, async () => {
    if ((await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [userId])).rowCount === 0) throw notFound("user", userId);
    const t = await tenantInfo(tx, tenantId);
    if (t.orgClass === "PLATFORM" || t.orgClass === "INDIVIDUAL") throw invalid("BAD_REQUEST", "memberships are for rights tenants and participant organizations");
    const { firstAdmin } = await adminScope(tx, actor, t);
    const roles = checkRoles(t, Array.isArray(b.roles) ? b.roles : [], firstAdmin);
    const ins = await tx.query("INSERT INTO user_membership (user_id, tenant_id, added_by, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [userId, tenantId, actor.userId, clock.now()]);
    if (ins.rowCount === 0) throw conflict("MEMBERSHIP_EXISTS", `${userId} is already a member of ${tenantId}`);
    for (const r of roles) await tx.query("INSERT INTO portal_role (user_id, tenant_id, role) VALUES ($1,$2,$3)", [userId, tenantId, r]);
    await audit(tx, clock, { actor: actor.userId, action: "MEMBERSHIP_ADD", entityType: "user_account", entityId: userId, after: { tenantId, roles } });
    return { userId, tenantId, roles: roles.sort() };
  });
}

/** 이 계정이 잠기지 않은 마지막 플랫폼 총괄(PLATFORM_ALL)이면 409 LAST_SUPER_ADMIN(총괄 운영과 권한 구조 3절). */
async function assertNotLastSuperAdmin(tx: Tx, userId: string): Promise<void> {
  const holders = (await tx.query(
    `SELECT r.user_id FROM portal_role r JOIN user_account u ON u.user_id = r.user_id
      WHERE r.role = 'PLATFORM_ALL' AND r.tenant_id = $1 AND u.disabled_at IS NULL`, [PLATFORM_TENANT])).rows.map((x) => x.user_id as string);
  if (holders.length === 1 && holders[0] === userId) throw conflict("LAST_SUPER_ADMIN", `${userId} is the last platform super administrator`);
}

/** 역할 바꾸기: 소속(tenantId, 기본값은 관리자의 조직)마다. 자기 역할은 바꾸지 못한다. */
export async function setRoles(tx: Tx, clock: Clock, actor: Actor, userId: string, roles: unknown, tenantId?: unknown) {
  if (userId === actor.userId) throw new DomainError("SAME_PERSON", 403, "you cannot change your own roles");
  return withSystemScope(tx, async () => {
    const { t, firstAdmin } = await targetMembership(tx, actor, userId, tenantId);
    const next = checkRoles(t, roles, firstAdmin);
    const before = (await tx.query("SELECT role FROM portal_role WHERE user_id = $1 AND tenant_id = $2 ORDER BY role", [userId, t.tenantId])).rows.map((r) => r.role);
    if (before.includes("PLATFORM_ALL") && !next.includes("PLATFORM_ALL")) await assertNotLastSuperAdmin(tx, userId);
    await tx.query("DELETE FROM portal_role WHERE user_id = $1 AND tenant_id = $2", [userId, t.tenantId]);
    for (const r of next) await tx.query("INSERT INTO portal_role (user_id, tenant_id, role) VALUES ($1,$2,$3)", [userId, t.tenantId, r]);
    await audit(tx, clock, { actor: actor.userId, action: "USER_ROLES", entityType: "user_account", entityId: userId, after: { tenantId: t.tenantId, before, roles: next } });
    return { userId, tenantId: t.tenantId, roles: next.sort() };
  });
}

/** 계정 잠금·해제: 잠그면 열린 세션도 모두 끝낸다. 조직 관리자는 자기 조직 소속 계정만, 자기 자신은 잠그지 못한다. */
export async function setDisabled(tx: Tx, clock: Clock, actor: Actor, userId: string, disabled: unknown) {
  if (typeof disabled !== "boolean") throw invalid("BAD_REQUEST", "disabled must be true or false");
  if (userId === actor.userId) throw new DomainError("SAME_PERSON", 403, "you cannot lock your own account");
  return withSystemScope(tx, async () => {
    if (actor.scope === "platform") {
      requirePermission(actor, "staff.manage");
    } else {
      requirePermission(actor, "account.manage");
      // 다른 조직에도 소속된 사람의 계정은 그 사람 전체를 잠그므로, 기본 소속 조직의 관리자만 잠근다.
      const u = (await tx.query("SELECT tenant_id FROM user_account WHERE user_id = $1", [userId])).rows[0];
      if (u === undefined) throw notFound("user", userId);
      if (u.tenant_id !== actor.tenantId) throw new DomainError("TENANT_FORBIDDEN", 403, `${userId} belongs to ${u.tenant_id}`);
    }
    if (disabled) await assertNotLastSuperAdmin(tx, userId);
    const r = await tx.query("UPDATE user_account SET disabled_at = $2 WHERE user_id = $1", [userId, disabled ? clock.now() : null]);
    if (r.rowCount === 0) throw notFound("user", userId);
    if (disabled) await tx.query("UPDATE user_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, clock.now()]);
    await audit(tx, clock, { actor: actor.userId, action: disabled ? "USER_DISABLE" : "USER_ENABLE", entityType: "user_account", entityId: userId });
    return { userId, disabled };
  });
}

/** 초대 다시 보내기: 그 계정을 관리할 수 있는 사람만(운영 인력·개인은 SPACE_OPS, 조직 계정은 그 조직 관리자 또는 첫 관리자를 세우는 운영). */
export async function reinvite(tx: Tx, clock: Clock, actor: Actor, userId: string) {
  return withSystemScope(tx, async () => {
    const u = (await tx.query("SELECT tenant_id FROM user_account WHERE user_id = $1", [userId])).rows[0];
    if (u === undefined) throw notFound("user", userId);
    const t = await tenantInfo(tx, u.tenant_id);
    if (actor.scope === "platform" && (t.orgClass === "RIGHTS" || t.orgClass === "PARTICIPANT")) {
      requirePermission(actor, "account.onboard");
      const isAdmin = (await tx.query(
        "SELECT 1 FROM portal_role r JOIN role_permission rp ON rp.role_id = r.role AND rp.perm_id = 'account.manage' WHERE r.user_id = $1 AND r.tenant_id = $2", [userId, t.tenantId])).rowCount !== 0;
      if (!isAdmin) throw new DomainError("TENANT_HAS_ADMIN", 409, `${t.tenantId} accounts are managed by its administrator`);
    } else {
      await adminScope(tx, actor, t);
    }
    return createInvite(tx, clock, actor, userId);
  });
}

export async function createInvite(tx: Tx, clock: Clock, actor: Actor, userId: string) {
  const t = token();
  await withSystemScope(tx, () => tx.query("INSERT INTO user_invitation (token_sha256, user_id, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
    [sha(t), userId, actor.userId, clock.now(), at(clock, INVITE_TTL_MS)]));
  return { inviteToken: t, inviteExpiresAt: at(clock, INVITE_TTL_MS) };
}

/** 초대 수락: 비밀번호를 정한다(10자 이상). 토큰은 한 번만 쓴다. 비밀번호를 바꾸면 TOTP는 그대로 두고 기존 세션은 끝낸다. */
export async function acceptInvite(tx: Tx, clock: Clock, b: { token?: unknown; password?: unknown }) {
  if (typeof b.token !== "string") throw invalid("BAD_REQUEST", "token is required");
  if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD) throw invalid("WEAK_PASSWORD", `password must be at least ${MIN_PASSWORD} characters`);
  return withSystemScope(tx, async () => {
    const inv = (await tx.query("SELECT * FROM user_invitation WHERE token_sha256 = $1 FOR UPDATE", [sha(b.token as string)])).rows[0];
    if (inv === undefined || inv.used_at !== null || (inv.expires_at as Date).toISOString() <= clock.now()) throw new DomainError("INVITE_INVALID", 410, "the invitation is invalid or expired");
    await tx.query("UPDATE user_invitation SET used_at = $2 WHERE token_sha256 = $1", [inv.token_sha256, clock.now()]);
    await tx.query(
      `INSERT INTO user_credential (user_id, password_hash, password_set_at) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_set_at = EXCLUDED.password_set_at, failed_count = 0, locked_until = NULL`,
      [inv.user_id, hashPassword(b.password as string), clock.now()]);
    await tx.query("UPDATE user_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [inv.user_id, clock.now()]);
    await audit(tx, clock, { actor: inv.user_id, action: "PASSWORD_SET", entityType: "user_account", entityId: inv.user_id });
    return { userId: inv.user_id as string };
  });
}

/** 쿠키 헤더에서 이름으로 값을 꺼낸다. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(channel: Channel, value: string, opts: { maxAgeMs: number; secure: boolean }): string {
  return `${SESSION_COOKIE(channel)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(opts.maxAgeMs / 1000)}${opts.secure ? "; Secure" : ""}`;
}
