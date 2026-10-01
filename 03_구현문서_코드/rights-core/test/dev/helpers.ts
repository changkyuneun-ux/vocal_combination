import pg from "pg";
import { migrate } from "../../src/platform/migrate.ts";
import { MIGRATIONS_DEV_DIR } from "../../src/dev/setup-db.ts";
import type { Db } from "../../src/platform/db.ts";
import { freshDb } from "../helpers.ts";

/** freshDb()에 개발 전용 마이그레이션(migrations-dev)을 더 적용한다. */
export async function freshDevDb(): Promise<{ db: Db; adminUrl: string; drop(): Promise<void> }> {
  const f = await freshDb();
  const c = new pg.Client({ connectionString: f.adminUrl });
  await c.connect();
  try {
    await migrate(c, MIGRATIONS_DEV_DIR);
  } finally {
    await c.end();
  }
  return f;
}
