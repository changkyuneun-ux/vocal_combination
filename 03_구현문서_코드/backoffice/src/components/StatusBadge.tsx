const OK = new Set(["ACTIVE", "CONFIRMED", "PAID", "POSTED", "APPROVED", "ISSUED", "SETTLED", "RESOLVED", "RELEASED", "PUBLISHED", "OK"]);
const INFO = new Set(["PENDING", "CALCULATED", "SUBMITTED", "RUNNING", "PROPOSED", "DRAFT", "OPEN", "PROCESSING", "IN_PROGRESS"]);
const WARN = new Set(["HOLD", "HELD", "QUARANTINED", "CARRIED", "CARRY_OVER", "CARRIED_OVER", "PAUSED", "SUSPENDED"]);
const BAD = new Set(["FAILED", "INVALID", "REJECTED", "VOID", "VOIDED", "REVOKED", "CANCELLED", "EXPIRED", "STUCK"]);

export function statusTone(status: string): "ok" | "info" | "warn" | "bad" | "muted" {
  const s = status.toUpperCase();
  if (OK.has(s)) return "ok";
  if (INFO.has(s)) return "info";
  if (WARN.has(s)) return "warn";
  if (BAD.has(s)) return "bad";
  return "muted";
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${statusTone(status)}`}>{status}</span>;
}
