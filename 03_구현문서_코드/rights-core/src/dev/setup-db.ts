import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../platform/migrate.ts";
import { runMigrations } from "../platform/migrate-cli.ts";
import { DEV_DB_NAME } from "./env.ts";

export const MIGRATIONS_DEV_DIR = fileURLToPath(new URL("../../migrations-dev/", import.meta.url));
export const DEFAULT_ADMIN_URL = "postgres://rc:rc@localhost:54329/rights_core";

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

/**
 * 개발 DB(rights_core_dev)를 준비한다(통합 설계 12.2-6): 없으면 CREATE DATABASE, 운영 마이그레이션 스크립트를 재사용해 스키마·pg-boss를 설치하고
 * 개발 전용 마이그레이션(migrations-dev)을 더 적용한다. 두 번 실행해도 안전하다(두 번째는 적용 0).
 */
export async function setupDevDb(serverAdminUrl: string): Promise<{ created: boolean; applied: string[]; appliedDev: string[] }> {
  const admin = new pg.Client({ connectionString: serverAdminUrl });
  await admin.connect();
  let created = false;
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DEV_DB_NAME])).rowCount === 0) {
      await admin.query(`CREATE DATABASE ${DEV_DB_NAME}`);
      created = true;
    }
  } finally {
    await admin.end();
  }
  const devUrl = withDb(serverAdminUrl, DEV_DB_NAME);
  const { applied } = await runMigrations(devUrl);
  const c = new pg.Client({ connectionString: devUrl });
  await c.connect();
  try {
    return { created, applied, appliedDev: await migrate(c, MIGRATIONS_DEV_DIR) };
  } finally {
    await c.end();
  }
}

const isMain = (() => { try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const r = await setupDevDb(process.env.RC_ADMIN_URL ?? DEFAULT_ADMIN_URL);
  console.log(`${DEV_DB_NAME}: ${r.created ? "created" : "already exists"}`);
  console.log(`applied migrations (${r.applied.length}): ${r.applied.join(", ") || "none"}`);
  console.log(`applied dev migrations (${r.appliedDev.length}): ${r.appliedDev.join(", ") || "none"}`);
}
