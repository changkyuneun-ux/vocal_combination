import type { Clock } from "./clock.ts";
import type { Db, Tx } from "./db.ts";

export async function enqueue(tx: Tx, clock: Clock, topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query("INSERT INTO outbox (topic, payload, created_at) VALUES ($1,$2,$3)", [topic, JSON.stringify(payload), clock.now()]);
}

/** 핸들러는 처리 트랜잭션과 payload, 그리고 시각 기록용 Clock을 받는다. */
export type OutboxHandlers = Record<string, (tx: Tx, payload: any, clock: Clock) => Promise<void>>;

/**
 * 처리 대기 레코드를 잠그고(SKIP LOCKED) 같은 트랜잭션에서 핸들러를 실행한 뒤 processed_at을 기록한다.
 * 핸들러가 없는 topic은 건드리지 않는다. 처리한 개수를 돌려준다.
 */
export async function processOutbox(db: Db, handlers: OutboxHandlers, clock: Clock, limit = 100): Promise<number> {
  const topics = Object.keys(handlers);
  if (topics.length === 0) return 0;
  return db.tx(async (tx) => {
    const rows = (await tx.query(
      "SELECT outbox_id, topic, payload FROM outbox WHERE processed_at IS NULL AND topic = ANY($1) ORDER BY outbox_id LIMIT $2 FOR UPDATE SKIP LOCKED",
      [topics, limit],
    )).rows;
    for (const r of rows) {
      await handlers[r.topic]!(tx, r.payload, clock);
      await tx.query("UPDATE outbox SET processed_at = $2 WHERE outbox_id = $1", [r.outbox_id, clock.now()]);
    }
    return rows.length;
  });
}

export function startOutboxPoller(db: Db, handlers: OutboxHandlers, clock: Clock, intervalMs: number): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    processOutbox(db, handlers, clock).catch((e) => console.error("outbox", e)).finally(() => { busy = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
