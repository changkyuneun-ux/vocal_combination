import { createHash, randomInt } from "node:crypto";
import type { Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, DomainError, notFound } from "../platform/errors.ts";

/**
 * 본인 인증(실연자 앱). 인증 수단(휴대폰 문자·PASS 등)은 공급자가 맡고, 코어는 일회용 코드의 해시와 결과만 기록한다.
 * 실연 동의 서명은 본인 인증을 마친 계정만 할 수 있다(registry/consents.ts).
 */
export type IdentityProvider = {
  method: string;
  /** 코드를 사용자에게 보낸다. 개발용 공급자는 보내는 대신 코드를 돌려준다(devCode). */
  deliver(userId: string, code: string): Promise<{ devCode?: string }>;
};

/** 개발·시험용: 실제로 보내지 않고 응답에 코드를 실어 준다. 운영에는 쓰지 않는다. */
export const devIdentityProvider: IdentityProvider = { method: "DEV_CODE", deliver: async (_u, code) => ({ devCode: code }) };

const TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function startVerification(tx: Tx, clock: Clock, provider: IdentityProvider | undefined, actor: Actor) {
  if (provider === undefined) throw new DomainError("IDENTITY_NOT_CONFIGURED", 503, "identity verification is not configured");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = clock.now();
  const r = (await tx.query(
    "INSERT INTO identity_challenge (user_id, method, code_sha256, created_at, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING challenge_id",
    [actor.userId, provider.method, sha(code), now, new Date(Date.parse(now) + TTL_MS).toISOString()])).rows[0];
  const sent = await provider.deliver(actor.userId, code);
  return { challengeId: Number(r.challenge_id), expiresInSeconds: TTL_MS / 1000, ...sent };
}

export async function confirmVerification(tx: Tx, clock: Clock, actor: Actor, input: { challengeId?: number; code?: string }) {
  const c = (await tx.query("SELECT * FROM identity_challenge WHERE challenge_id = $1 AND user_id = $2 FOR UPDATE", [input.challengeId, actor.userId])).rows[0];
  if (c === undefined) throw notFound("identity challenge", String(input.challengeId));
  if (c.verified_at !== null) throw conflict("ALREADY_VERIFIED", "this challenge was already used");
  const now = clock.now();
  if (c.expires_at.toISOString() <= now) throw new DomainError("CHALLENGE_EXPIRED", 410, "the code expired; start again");
  if (c.attempts >= MAX_ATTEMPTS) throw new DomainError("TOO_MANY_ATTEMPTS", 429, "too many attempts; start again");
  if (typeof input.code !== "string" || sha(input.code) !== c.code_sha256) {
    await tx.query("UPDATE identity_challenge SET attempts = attempts + 1 WHERE challenge_id = $1", [c.challenge_id]);
    // 실패 횟수는 남겨야 하므로 예외 대신 결과로 돌려준다(예외면 트랜잭션이 롤백된다).
    return { verified: false, attemptsLeft: MAX_ATTEMPTS - c.attempts - 1 };
  }
  await tx.query("UPDATE identity_challenge SET verified_at = $2 WHERE challenge_id = $1", [c.challenge_id, now]);
  await markIdentityVerified(tx, clock, actor.userId, c.method as string);
  return { verified: true, attemptsLeft: MAX_ATTEMPTS - c.attempts };
}

/** 본인 인증 완료 기록. 인증 흐름 밖에서 쓰는 곳은 시험·시나리오 시드(인증을 마친 계정으로 시작)다. */
export async function markIdentityVerified(tx: Tx, clock: Clock, userId: string, method: string): Promise<void> {
  await tx.query("UPDATE user_account SET identity_verified_at = $2, identity_method = $3 WHERE user_id = $1", [userId, clock.now(), method]);
  await audit(tx, clock, { actor: userId, action: "IDENTITY_VERIFIED", entityType: "user_account", entityId: userId, after: { method } });
}

export async function isIdentityVerified(tx: Tx, userId: string): Promise<boolean> {
  return (await tx.query("SELECT identity_verified_at IS NOT NULL AS v FROM user_account WHERE user_id = $1", [userId])).rows[0]?.v === true;
}
