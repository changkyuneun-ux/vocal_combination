import { generateKeyPairSync } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { DomainError } from "./errors.ts";

export type Role = "RIGHTS_EDITOR" | "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "ISSUER" | "SPACE_OPS" | "SPACE_SETTLE" | "SYSTEM";
export type Actor = { userId: string; roles: ReadonlySet<Role> };

/** 사용자와 역할을 만들고 개발용 Ed25519 키를 발급한다(운영은 KMS — 통합 설계 6.4). */
export async function createUser(tx: Tx, clock: Clock, u: { userId: string; displayName: string; roles: Role[] }): Promise<void> {
  await tx.query("INSERT INTO user_account (user_id, display_name, created_at) VALUES ($1,$2,$3)", [u.userId, u.displayName, clock.now()]);
  for (const r of u.roles) await tx.query("INSERT INTO portal_role (user_id, role) VALUES ($1,$2)", [u.userId, r]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await tx.query("INSERT INTO dev_signing_key (user_id, key_version, public_pem, private_pem) VALUES ($1,'dev-1',$2,$3)", [
    u.userId, publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ]);
}

export async function loadActor(tx: Tx, userId: string): Promise<Actor> {
  const u = await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [userId]);
  if (u.rowCount === 0) throw new DomainError("UNKNOWN_ACTOR", 401, `unknown actor: ${userId}`);
  const roles = (await tx.query("SELECT role FROM portal_role WHERE user_id = $1", [userId])).rows.map((r) => r.role as Role);
  return { userId, roles: new Set(roles) };
}

export function requireRole(actor: Actor, role: Role): void {
  if (!actor.roles.has(role)) throw new DomainError("ROLE_REQUIRED", 403, `${actor.userId} lacks role ${role}`);
}
