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

/** RC_DB_POOL_MAX(기본 20)를 읽는다. 양의 정수가 아니면 시작을 거부한다. */
export function poolMaxFromEnv(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.RC_DB_POOL_MAX;
  if (raw === undefined || raw === "") return 20;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new Error(`RC_DB_POOL_MAX must be a positive integer, got ${raw}`);
  return n;
}
