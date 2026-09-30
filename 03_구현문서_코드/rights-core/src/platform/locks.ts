import type { Tx } from "./db.ts";

/**
 * 배치 생성과 환불 기록을 직렬화하는 전역 advisory lock(트랜잭션 범위).
 * createBatch는 EXCLUSIVE, 환불 수집·refund-recorded는 SHARED로 잡는다. 그러면 환불은 배치가 후보를 읽기 전에 커밋되어
 * 순액에 포함되거나(id 기록), 배치가 커밋된 뒤에 기록되어 그 작업이 살아 있는 run을 찾는다. 이벤트별 잠금은 이벤트 수만큼
 * 잠금 테이블을 쓰므로 하나로 둔다.
 */
export async function lockBatching(tx: Tx, mode: "EXCLUSIVE" | "SHARED"): Promise<void> {
  const fn = mode === "EXCLUSIVE" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
  await tx.query(`SELECT ${fn}(hashtextextended('settlement:batching', 0))`);
}
