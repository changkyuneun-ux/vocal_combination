import { createDb, type Db } from "../src/platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../src/platform/dbadmin.ts";

/** 템플릿 DB를 복제한 새 DB에 rc_app 역할로 연결한다. 테스트 파일마다 한 번 호출하고 after()에서 drop한다. */
export async function freshDb(): Promise<{ db: Db; adminUrl: string; drop(): Promise<void> }> {
  const fresh = await createFreshDatabase(ADMIN_URL);
  const db = createDb(fresh.appUrl);
  return {
    db,
    adminUrl: fresh.adminUrl,
    async drop() {
      await db.close();
      await fresh.drop();
    },
  };
}

import pg from "pg";
import type { SodRule } from "../src/platform/sod.ts";

/** 직무 분리 규칙 켜기·끄기(시험 전용, 관리자 연결). 규칙은 기본 꺼짐이라(결정 RD6) 거부를 확인하는 시험만 켠다. */
export async function setSodRules(adminUrl: string, rules: readonly SodRule[] | "all", enabled = true): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    if (rules === "all") await c.query("UPDATE sod_rule SET enabled = $1", [enabled]);
    else await c.query("UPDATE sod_rule SET enabled = $1 WHERE rule_id = ANY($2)", [enabled, [...rules]]);
  } finally {
    await c.end();
  }
}
