/** 지급 화면의 순수 로직(단위 테스트 대상). */

export const OPEN_STATUSES = ["PENDING", "SUBMITTED"] as const;
export const INSTRUCTION_STATUSES = ["PENDING", "SUBMITTED", "PAID", "FAILED", "CARRIED", "HELD"] as const;

/** 가상 시계보다 coolingUntil이 뒤면 냉각 중(시계를 아직 모르면 아님). */
export function isCooling(coolingUntil: string | null, nowIso: string | undefined): boolean {
  return coolingUntil !== null && nowIso !== undefined && Date.parse(coolingUntil) > Date.parse(nowIso);
}

/** 기본 지급 run id: pr-<YYYYMMDD>-<n>(백엔드 id 규칙은 밑줄 불가), 이미 쓰인 id와 겹치지 않는 가장 작은 n. */
export function nextPayoutRunId(asOfIso: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const ymd = asOfIso.slice(0, 10).replaceAll("-", "");
  for (let n = 1; ; n++) {
    const id = `pr-${ymd}-${n}`;
    if (!used.has(id)) return id;
  }
}

export function hasOpen(counts: Record<string, number> | undefined): boolean {
  return counts !== undefined && OPEN_STATUSES.some((s) => (counts[s] ?? 0) > 0);
}

export function openInstructions<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status));
}

export type AuditLike = { action: string; after: unknown };

/** FAILED 사유(ACCOUNT_CHANGED 등)는 지시 행이 아니라 PAYOUT_FAILED 감사의 after.reason에 있다. */
export function failureReason(audit: AuditLike[]): string | null {
  for (const a of audit) {
    if (a.action !== "PAYOUT_FAILED") continue;
    const r = (a.after as { reason?: unknown } | null)?.reason;
    if (typeof r === "string") return r;
  }
  return null;
}
