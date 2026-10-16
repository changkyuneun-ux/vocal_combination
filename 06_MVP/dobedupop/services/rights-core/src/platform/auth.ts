import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { assertChannel, type Channel } from "../http/channels.ts";
import { createUser, loadActor, requireRole, withSystemScope, type Actor, type Role } from "./actor.ts";
import { audit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { conflict, DomainError, invalid, notFound } from "./errors.ts";
import { confirmVerification, startVerification, type IdentityProvider } from "../performer/identity.ts";

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

async function issueSession(tx: Tx, clock: Clock, userId: string, channel: Channel, method: LoginMethod, meta: SessionMeta) {
  const t = token();
  await tx.query(
    `INSERT INTO user_session (token_sha256, user_id, channel, method, created_at, expires_at, last_seen_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$5,$7,$8)`,
    [sha(t), userId, channel, method, clock.now(), at(clock, SESSION_TTL_MS[channel]), meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null]);
  await audit(tx, clock, { actor: userId, action: "LOGIN", entityType: "user_account", entityId: userId, after: { channel, method } });
  return { token: t, expiresAt: at(clock, SESSION_TTL_MS[channel]) };
}

/** 쿠키의 세션 → 사용자. 다른 채널에서 만든 세션, 만료·폐기·잠긴 계정이면 null. 마지막 사용 시각은 5분마다만 고친다. */
export async function resolveSession(tx: Tx, clock: Clock, raw: string, channel: Channel): Promise<string | null> {
  return withSystemScope(tx, async () => {
    const s = (await tx.query(
      `SELECT s.user_id, s.channel, s.expires_at, s.last_seen_at, s.revoked_at, u.disabled_at FROM user_session s JOIN user_account u USING (user_id) WHERE s.token_sha256 = $1`, [sha(raw)])).rows[0];
    if (s === undefined || s.revoked_at !== null || s.disabled_at !== null || s.channel !== channel) return null;
    const now = Date.parse(clock.now());
    if ((s.expires_at as Date).getTime() <= now || (s.last_seen_at as Date).getTime() + IDLE_MS[channel] <= now) return null;
    if ((s.last_seen_at as Date).getTime() + 5 * 60_000 <= now) await tx.query("UPDATE user_session SET last_seen_at = $2 WHERE token_sha256 = $1", [sha(raw), clock.now()]);
    return s.user_id as string;
  });
}

export async function logout(tx: Tx, clock: Clock, raw: string): Promise<void> {
  await withSystemScope(tx, () => tx.query("UPDATE user_session SET revoked_at = $2 WHERE token_sha256 = $1 AND revoked_at IS NULL", [sha(raw), clock.now()]));
}

/** 채널에 들어올 수 있는 계정인지(로그인 전에 확인해 다른 채널용 세션을 만들지 않는다). */
async function eligible(tx: Tx, userId: string, channel: Channel): Promise<Actor> {
  const actor = await loadActor(tx, userId);
  assertChannel(channel, actor);
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
export async function passwordLogin(tx: Tx, clock: Clock, channel: Channel, input: { userId?: unknown; password?: unknown; totp?: unknown }, meta: SessionMeta): Promise<LoginResult> {
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
    await eligible(tx, userId, channel);
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
    const s = await issueSession(tx, clock, userId, channel, needTotp ? "PASSWORD_TOTP" : "PASSWORD", meta);
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
    const s = await issueSession(tx, clock, actor.userId, channel, "OTP", meta);
    return { status: "OK" as const, ...s, userId: actor.userId };
  });
}

// ── 데모 환경: 페르소나 빠른 로그인 ──────────────────────────────────────────────────
export async function devLogin(tx: Tx, clock: Clock, channel: Channel, userId: unknown, meta: SessionMeta) {
  if (typeof userId !== "string") throw invalid("BAD_REQUEST", "userId is required");
  return withSystemScope(tx, async () => {
    await eligible(tx, userId, channel);
    const s = await issueSession(tx, clock, userId, channel, "DEV", meta);
    return { status: "OK" as const, ...s, userId };
  });
}

// ── 계정 발급(운영) ───────────────────────────────────────────────────────────────
const ID = /^[A-Za-z0-9._-]+$/;
const ROLES: readonly Role[] = ["RIGHTS_EDITOR", "EDITOR", "WORK_APPROVER", "ACTIVATOR", "ISSUER", "SPACE_OPS", "SPACE_SETTLE", "PERFORMER", "COMPLIANCE", "LEGAL"];

/**
 * 계정 만들기(권리자 온보딩·운영 인력): 플랫폼 운영(SPACE_OPS)만. 비밀번호 로그인 계정이면 일회용 초대 토큰을 돌려준다(한 번만 보인다).
 * 실연자 계정(파티 연결, PERFORMER)은 비밀번호 없이 본인 인증 코드로 들어온다.
 */
export async function createAccount(tx: Tx, clock: Clock, actor: Actor, b: { userId?: unknown; displayName?: unknown; tenantId?: unknown; roles?: unknown; partyId?: unknown }) {
  requireRole(actor, "SPACE_OPS");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators create accounts");
  if (typeof b.userId !== "string" || !ID.test(b.userId)) throw invalid("BAD_REQUEST", "userId must be an id");
  if (typeof b.displayName !== "string" || b.displayName.trim() === "") throw invalid("BAD_REQUEST", "displayName is required");
  if (typeof b.tenantId !== "string") throw invalid("BAD_REQUEST", "tenantId is required");
  const roles = Array.isArray(b.roles) ? b.roles : [];
  if (!roles.every((r) => ROLES.includes(r as Role))) throw invalid("BAD_REQUEST", `roles must be among ${ROLES.join(", ")}`);
  if (roles.includes("SYSTEM")) throw invalid("BAD_REQUEST", "SYSTEM is not assignable");
  return withSystemScope(tx, async () => {
    if ((await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [b.userId])).rowCount !== 0) throw conflict("USER_EXISTS", `user ${b.userId} exists`);
    if ((await tx.query("SELECT 1 FROM tenant WHERE tenant_id = $1", [b.tenantId])).rowCount === 0) throw notFound("tenant", b.tenantId as string);
    await createUser(tx, clock, { userId: b.userId as string, displayName: (b.displayName as string).trim(), roles: roles as Role[], tenantId: b.tenantId as string, ...(typeof b.partyId === "string" && { partyId: b.partyId }) });
    await audit(tx, clock, { actor: actor.userId, action: "USER_CREATE", entityType: "user_account", entityId: b.userId as string, after: { tenantId: b.tenantId, roles } });
    const passwordless = roles.includes("PERFORMER") || b.tenantId === "tnt_platform_default";
    if (passwordless) return { userId: b.userId as string, login: "OTP" as const };
    const inv = await createInvite(tx, clock, actor, b.userId as string);
    return { userId: b.userId as string, login: "PASSWORD" as const, ...inv };
  });
}

export async function setRoles(tx: Tx, clock: Clock, actor: Actor, userId: string, roles: unknown) {
  requireRole(actor, "SPACE_OPS");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators change roles");
  if (!Array.isArray(roles) || !roles.every((r) => ROLES.includes(r as Role))) throw invalid("BAD_REQUEST", `roles must be among ${ROLES.join(", ")}`);
  if (userId === actor.userId) throw new DomainError("SAME_PERSON", 403, "operators cannot change their own roles");
  return withSystemScope(tx, async () => {
    if ((await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [userId])).rowCount === 0) throw notFound("user", userId);
    const before = (await tx.query("SELECT role FROM portal_role WHERE user_id = $1 ORDER BY role", [userId])).rows.map((r) => r.role);
    await tx.query("DELETE FROM portal_role WHERE user_id = $1", [userId]);
    for (const r of new Set(roles as Role[])) await tx.query("INSERT INTO portal_role (user_id, role) VALUES ($1,$2)", [userId, r]);
    await audit(tx, clock, { actor: actor.userId, action: "USER_ROLES", entityType: "user_account", entityId: userId, after: { before, roles } });
    return { userId, roles: [...new Set(roles)].sort() };
  });
}

/** 계정 잠금·해제: 잠그면 열린 세션도 모두 끝낸다. */
export async function setDisabled(tx: Tx, clock: Clock, actor: Actor, userId: string, disabled: unknown) {
  requireRole(actor, "SPACE_OPS");
  if (actor.scope !== "platform") throw new DomainError("TENANT_FORBIDDEN", 403, "only platform operators disable accounts");
  if (typeof disabled !== "boolean") throw invalid("BAD_REQUEST", "disabled must be true or false");
  return withSystemScope(tx, async () => {
    const r = await tx.query("UPDATE user_account SET disabled_at = $2 WHERE user_id = $1", [userId, disabled ? clock.now() : null]);
    if (r.rowCount === 0) throw notFound("user", userId);
    if (disabled) await tx.query("UPDATE user_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL", [userId, clock.now()]);
    await audit(tx, clock, { actor: actor.userId, action: disabled ? "USER_DISABLE" : "USER_ENABLE", entityType: "user_account", entityId: userId });
    return { userId, disabled };
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
