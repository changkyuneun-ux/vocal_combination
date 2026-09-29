import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** 번호 붙은 .sql 파일을 이름순으로 한 번씩 적용한다. 적용한 파일 이름 목록을 돌려준다. */
export async function migrate(client: pg.ClientBase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  await client.query("GRANT SELECT ON schema_migrations TO rc_app");
  const done = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(`${dir}/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    applied.push(name);
  }
  return applied;
}
