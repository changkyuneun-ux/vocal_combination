import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";
import { installJobSchema } from "./jobs.ts";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";

const PG_BOSS_VERSION: string = createRequire(import.meta.url)("pg-boss/package.json").version;

export const ADMIN_URL = process.env.RC_ADMIN_URL ?? "postgres://rc:rc@localhost:54329/rights_core";
const APP_CREDENTIALS = process.env.RC_APP_CREDENTIALS ?? "rc_app:rc_app";
const LOCK_KEY = 727001;

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

export function appUrlFor(name: string): string {
  const u = new URL(withDb(ADMIN_URL, name));
  const i = APP_CREDENTIALS.indexOf(":");
  u.username = APP_CREDENTIALS.slice(0, i);
  u.password = APP_CREDENTIALS.slice(i + 1);
  return u.toString();
}

/** 마이그레이션 내용이나 pg-boss 버전이 바뀌면 템플릿 이름도 바뀐다(낡은 템플릿을 쓰지 않는다). */
function templateName(): string {
  const h = createHash("sha256");
  h.update(`pg-boss@${PG_BOSS_VERSION}`);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    h.update(f).update(readFileSync(`${MIGRATIONS_DIR}/${f}`));
  }
  return `rc_tpl_${h.digest("hex").slice(0, 12)}`;
}

/** 템플릿 DB(마이그레이션 적용본)를 복제해 새 DB를 만든다. 동시 실행은 advisory lock으로 직렬화한다. */
export async function createFreshDatabase(adminUrl: string): Promise<{ name: string; appUrl: string; adminUrl: string; drop(): Promise<void> }> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const tpl = templateName();
  const name = `rc_t_${process.pid}_${randomBytes(4).toString("hex")}`;
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [tpl]);
    if (exists.rowCount === 0) {
      const building = `${tpl}_building_${process.pid}`;
      await admin.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${building}`);
      try {
        const c = new pg.Client({ connectionString: withDb(adminUrl, building) });
        await c.connect();
        try {
          await migrate(c);
        } finally {
          await c.end();
        }
        // 소유자 역할로 pg-boss 스키마·큐를 설치한다. 설치 연결이 모두 닫힌 뒤 이름을 바꾼다.
        await installJobSchema(withDb(adminUrl, building));
        await admin.query(`ALTER DATABASE ${building} RENAME TO ${tpl}`);
      } catch (e) {
        await admin.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`).catch(() => undefined);
        throw e;
      }
    }
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${tpl}`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await admin.end();
  }
  return {
    name,
    appUrl: appUrlFor(name),
    adminUrl: withDb(adminUrl, name),
    async drop() {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
