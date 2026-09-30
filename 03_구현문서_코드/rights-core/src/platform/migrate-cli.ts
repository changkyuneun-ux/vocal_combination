import { fileURLToPath } from "node:url";
import pg from "pg";
import { installJobSchema } from "./jobs.ts";
import { migrate } from "./migrate.ts";

/**
 * 운영 마이그레이션(통합 설계 11.2-14): 관리자 역할로 (1) 스키마 마이그레이션, (2) pg-boss 스키마·큐 설치와 rc_app 권한,
 * (3) rc_app 권한 확인을 순서대로 한다. 멱등이다(두 번째 실행은 적용 0). 적용한 마이그레이션과 큐 목록을 돌려준다.
 */
export async function runMigrations(adminUrl: string): Promise<{ applied: string[]; queues: string[] }> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  let applied: string[];
  try {
    applied = await migrate(c);
  } finally {
    await c.end();
  }
  await installJobSchema(adminUrl);
  const v = new pg.Client({ connectionString: adminUrl });
  await v.connect();
  try {
    const ok = (await v.query(
      `SELECT has_schema_privilege('rc_app', 'pgboss', 'USAGE') AS s, has_table_privilege('rc_app', 'pgboss.job', 'SELECT, INSERT, UPDATE') AS t,
              has_table_privilege('rc_app', 'audit_log', 'INSERT') AS a`)).rows[0];
    if (!ok.s || !ok.t || !ok.a) throw new Error(`rc_app privileges are missing (pgboss schema ${ok.s}, pgboss.job ${ok.t}, audit_log ${ok.a})`);
    const queues = (await v.query("SELECT name FROM pgboss.queue ORDER BY name")).rows.map((r) => r.name as string);
    return { applied, queues };
  } finally {
    await v.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.RC_ADMIN_URL;
  if (url === undefined || url === "") {
    console.error("RC_ADMIN_URL is required");
    process.exit(2);
  }
  const r = await runMigrations(url);
  console.log(`applied migrations (${r.applied.length}): ${r.applied.join(", ") || "none"}`);
  console.log(`queues (${r.queues.length}): ${r.queues.join(", ")}`);
}
