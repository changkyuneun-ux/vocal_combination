/** 정산 화면의 순수 로직(단위 테스트 대상). */

/** 가상 시계 기준 지난달 1일 ~ 이번 달 1일(UTC, 밀리초 ISO). */
export function defaultPeriod(nowIso: string): { start: string; end: string } {
  const d = new Date(nowIso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { start: new Date(Date.UTC(y, m - 1, 1)).toISOString(), end: new Date(Date.UTC(y, m, 1)).toISOString() };
}

/** 기본 배치 id: bat_<YYYYMM>_<n>, 이미 쓰인 id와 겹치지 않는 가장 작은 n. */
export function nextBatchId(periodStartIso: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const ym = periodStartIso.slice(0, 7).replace("-", "");
  for (let n = 1; ; n++) {
    const id = `bat_${ym}_${n}`;
    if (!used.has(id)) return id;
  }
}

export type RunLike = { runId: string; status: string };
export type ConfirmCheck = { ok: true } | { ok: false; reason: string };

const DEAD = new Set(["FAILED", "VOIDED"]);

/** 확정 가능: 배치가 OPEN이고, 살아 있는(FAILED·VOIDED 제외) run이 하나 이상이며 모두 VERIFIED. */
export function canConfirm(batchStatus: string, runs: RunLike[]): ConfirmCheck {
  if (batchStatus !== "OPEN") return { ok: false, reason: `배치가 ${batchStatus} 상태입니다(OPEN일 때만 확정)` };
  const live = runs.filter((r) => !DEAD.has(r.status));
  if (live.length === 0) return { ok: false, reason: "살아 있는 run이 없습니다" };
  const notReady = live.filter((r) => r.status !== "VERIFIED");
  if (notReady.length > 0) return { ok: false, reason: `아직 VERIFIED가 아닌 run: ${notReady.map((r) => `${r.runId}(${r.status})`).join(", ")}` };
  return { ok: true };
}

export type AllocationCheck = { ok: boolean; sum: bigint; diff: bigint; reason?: string };

/** 배분 합 = 보류액(BigInt). 모든 금액은 양의 정수 문자열이어야 한다. diff = 합 − 보류액. */
export function allocationCheck(allocation: Record<string, string>, holdKrw: string): AllocationCheck {
  const entries = Object.entries(allocation);
  const target = BigInt(holdKrw);
  if (entries.length === 0) return { ok: false, sum: 0n, diff: -target, reason: "배분이 비어 있습니다" };
  let sum = 0n;
  for (const [party, amt] of entries) {
    if (!/^[1-9]\d{0,17}$/.test(amt)) return { ok: false, sum, diff: sum - target, reason: `${party}의 금액은 양의 정수여야 합니다` };
    sum += BigInt(amt);
  }
  const diff = sum - target;
  return diff === 0n ? { ok: true, sum, diff } : { ok: false, sum, diff, reason: `합계가 보류액과 ${diff > 0n ? "초과" : "부족"}합니다` };
}

export type HoldLike = { runId: string; eventId: string; bucket: string; reason: string; lineSeq: number; amountKrw: string };

/** 남은 보류액 = line_seq 1 금액 + 같은 (run, event, bucket, reason)의 line_seq > 1 행 금액 합(역분개, 음수). 백엔드 remainingHold와 같다. */
export function remainingHold(hold: HoldLike, all: HoldLike[]): bigint {
  return all
    .filter((x) => x.lineSeq > 1 && x.runId === hold.runId && x.eventId === hold.eventId && x.bucket === hold.bucket && x.reason === hold.reason)
    .reduce((a, x) => a + BigInt(x.amountKrw), BigInt(hold.amountKrw));
}
