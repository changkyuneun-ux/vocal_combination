import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { MIGRATIONS_DIR, migrate } from "./migrate.ts";

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
  const [user, pass] = APP_CREDENTIALS.split(":");
  u.username = user!;
  u.password = pass!;
  return u.toString();
}

/** 마이그레이션 내용이 바뀌면 템플릿 이름도 바뀐다(낡은 템플릿을 쓰지 않는다). */
function templateName(): string {
  const h = createHash("sha256");
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    h.update(f).update(readFileSync(`${MIGRATIONS_DIR}/${f}`));
  }
  return `rc_tpl_${h.digest("hex").slice(0, 12)}`;
}

/** 템플릿 DB(마이그레이션 적용본)를 복제해 새 DB를 만든다. 동시 실행은 advisory lock으로 직렬화한다. */
export async function createFreshDatabase(adminUrl: string): Promise<{ name: string; appUrl: string; drop(): Promise<void> }> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const tpl = templateName();
  const name = `rc_t_${process.pid}_${randomBytes(4).toString("hex")}`;
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [tpl]);
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${tpl}`);
      const c = new pg.Client({ connectionString: withDb(adminUrl, tpl) });
      await c.connect();
      try {
        await migrate(c);
      } finally {
        await c.end();
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
