import pg from "pg";

export type Tx = pg.PoolClient;
export type Db = { pool: pg.Pool; tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; close(): Promise<void> };

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    pool,
    async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** TIMESTAMPTZ(Date) → 밀리초 ISO 문자열. NULL은 undefined. */
export function iso(v: Date | null): string | undefined {
  return v === null ? undefined : v.toISOString();
}
