import type { Tx } from "./db.ts";
import { DomainError } from "./errors.ts";

/** 직무 분리 규칙(migrations/0040_sod_rules.sql). 현 단계는 모두 꺼짐(결정 RD6). */
export type SodRule = "policy.edit-approve-activate" | "settlement.run-confirm" | "contract-template.author-approve" | "policy-template.author-approve"
  | "validation.request-approve" | "link.propose-confirm" | "payout.account-run";

/** 규칙이 켜져 있으면 true. 같은 사람의 연속 행위를 거부하는 검사는 이 값이 true일 때만 거부한다. */
export async function sodEnabled(tx: Tx, rule: SodRule): Promise<boolean> {
  const r = (await tx.query("SELECT enabled FROM sod_rule WHERE rule_id = $1", [rule])).rows[0];
  if (r === undefined) throw new DomainError("SOD_RULE_UNKNOWN", 500, `unknown separation-of-duty rule ${rule}`);
  return r.enabled as boolean;
}
