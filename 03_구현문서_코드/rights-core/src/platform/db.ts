import pg from "pg";

export type Tx = pg.PoolClient;
export type Db = { pool: pg.Pool; tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; close(): Promise<void> };

export function createDb(url: string, opts: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  pool.on("error", (e) => console.error("pg pool idle client error:", e.message));
  return {
    pool,
    async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch((re: Error) => {
          broken = re;
        });
        throw e;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
}

/** TIMESTAMPTZ(Date) → 밀리초 ISO 문자열. NULL은 undefined. */
export function iso(v: Date | null): string | undefined {
  return v === null ? undefined : v.toISOString();
}

/**
 * 서버 풀 기본 크기. 워커가 동시에 쥐는 연결 ≈ 큐 수(JOB_NAMES 9) × RC_JOB_CONCURRENCY(기본 4) + post-batch의 추가 동시 분개(POST_CONCURRENCY − 1 = 3)
 * = 39, 여기에 HTTP 요청·outbox 폴러가 더해진다(통합 설계 11.2-14). RC_JOB_CONCURRENCY를 올리면 이 식으로 RC_DB_POOL_MAX도 올린다.
 */
export const DEFAULT_POOL_MAX = 40;

/** RC_DB_POOL_MAX(기본 DEFAULT_POOL_MAX = 40)를 읽는다. 양의 정수가 아니면 시작을 거부한다. */
export function poolMaxFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.RC_DB_POOL_MAX;
  if (raw === undefined || raw === "") return DEFAULT_POOL_MAX;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new Error(`RC_DB_POOL_MAX must be a positive integer, got ${raw}`);
  return n;
}
