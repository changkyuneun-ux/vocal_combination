import type { Clock } from "../platform/clock.ts";
import { onCommit, type Db, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid } from "../platform/errors.ts";

export const DEV_CLOCK_START = "2026-01-01T00:00:00.000Z";

export type DevClock = Clock & {
  state(): { now: string; realNow: string; headroomMs: number };
  /** 새 가상 시각. 메모리 반영은 트랜잭션이 커밋된 뒤에 일어난다. */
  advance(tx: Tx, ms: number): Promise<string>;
  set(tx: Tx, at: string): Promise<string>;
  /** 검증 DB 초기화 전용: 단조 규칙 없이 가상 시각을 되돌린다(앞으로 가는 set·advance와 달리 CLOCK_REGRESSED가 없다). */
  resetTo(tx: Tx, at: string): Promise<string>;
  /** dev_clock 행을 다시 읽는다(초기화 뒤). */
  reload(tx: Tx): Promise<void>;
  /**
   * 여러 프로세스(API·워커·검증 워커)가 같은 가상 시각을 쓰도록 dev_clock을 주기적으로 다시 읽는다.
   * 다른 프로세스가 시계를 옮기면 intervalMs 안에 따라간다. 멈추는 함수를 돌려준다.
   */
  follow(db: Db, intervalMs: number): () => void;
};

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isIsoMs = (s: string) => ISO_MS.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

type Row = { baseMs: number; setRealMs: number };

/**
 * 가상 시계(통합 설계 12.2-5): 가상 시각 = base_at + (realNow − set_real_at). 실제 시간에 따라 흐르고, advance·set은 앞으로만 간다.
 * now()는 동기라서 상태를 메모리에 두고, 변경은 dev_clock을 FOR UPDATE로 잠근 트랜잭션의 커밋 뒤에 메모리에 반영한다.
 */
export async function loadDevClock(db: Db, realNow: () => number = () => Date.now()): Promise<DevClock> {
  let row: Row = await db.tx(read);
  const virtualAt = (r: Row) => r.baseMs + (realNow() - r.setRealMs);
  const iso = (ms: number) => new Date(ms).toISOString();

  async function read(tx: Tx, lock = false): Promise<Row> {
    const r = (await tx.query(`SELECT base_at, set_real_at FROM dev_clock${lock ? " FOR UPDATE" : ""}`)).rows[0];
    if (r === undefined) throw new Error("dev_clock row is missing (run npm run dev:db)");
    return { baseMs: (r.base_at as Date).getTime(), setRealMs: (r.set_real_at as Date).getTime() };
  }

  const clock: DevClock = {
    now: () => iso(virtualAt(row)),
    state() {
      const r = realNow();
      const now = virtualAt(row);
      return { now: iso(now), realNow: iso(r), headroomMs: r - now };
    },
    async set(tx, at) {
      if (typeof at !== "string" || !isIsoMs(at)) throw invalid("INVALID_INSTANT", `at must be a millisecond UTC ISO instant, got ${String(at)}`);
      const cur = await read(tx, true);
      const target = Date.parse(at);
      if (target < virtualAt(cur)) throw conflict("CLOCK_REGRESSED", `cannot move the clock back to ${at} (now ${iso(virtualAt(cur))})`);
      const real = realNow();
      if (target > real) throw conflict("CLOCK_AHEAD_OF_REAL", `cannot move the clock past real time ${iso(real)}`);
      const next: Row = { baseMs: target, setRealMs: real };
      await tx.query("UPDATE dev_clock SET base_at = $1, set_real_at = $2", [at, iso(real)]);
      onCommit(tx, () => { row = next; });
      return at;
    },
    async advance(tx, ms) {
      if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms <= 0) throw new DomainError("BAD_REQUEST", 400, "ms must be a positive integer");
      const cur = await read(tx, true);
      return clock.set(tx, iso(virtualAt(cur) + ms));
    },
    async resetTo(tx, at) {
      if (typeof at !== "string" || !isIsoMs(at)) throw invalid("INVALID_INSTANT", `at must be a millisecond UTC ISO instant, got ${String(at)}`);
      await read(tx, true);
      const real = realNow();
      const next: Row = { baseMs: Date.parse(at), setRealMs: real };
      await tx.query("UPDATE dev_clock SET base_at = $1, set_real_at = $2", [at, iso(real)]);
      onCommit(tx, () => { row = next; });
      return at;
    },
    async reload(tx) {
      const next = await read(tx);
      onCommit(tx, () => { row = next; });
    },
    follow(db, intervalMs) {
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        db.tx(read).then((r) => { row = r; }).catch((e) => console.error("dev clock follow", e)).finally(() => { busy = false; });
      }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return clock;
}
