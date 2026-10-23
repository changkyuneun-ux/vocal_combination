import { readFileSync } from "node:fs";
import pg from "pg";
import { DomainError } from "../platform/errors.ts";
import { DEV_CLOCK_START } from "./clock.ts";
import { DEV_DB_NAME } from "./env.ts";

/** DB 이름이 허용된 이름이 아니면 던진다(검증용 초기화는 개발 DB에서만 — 통합 설계 12.2-7). */
export function assertDevDbName(name: string, allowed: string = DEV_DB_NAME): void {
  if (name !== allowed) throw new DomainError("DEV_ONLY", 403, `refusing to reset database "${name}" (only ${allowed})`);
}

/**
 * 마이그레이션이 넣는 시드 행(migrations/*.sql의 INSERT INTO 전부). 초기화가 TRUNCATE 뒤에 같은 값으로 다시 넣는다.
 * 목록: 0014_holds_payout.sql의 payout_policy 'default', 0017·0018의 플랫폼·개인 기본 테넌트(0030의 validation_enforced 값 포함), 0032의 표준 계약 템플릿, 0038의 표준 분배 규칙 템플릿,
 * 0039의 권한·역할·역할–권한·위임 업무 권한, 0040의 직무 분리 규칙, 0041의 총괄 역할, 0044의 읽기 틀 승인 권한·권리 확인서 템플릿. migrations-dev의 dev_clock은 아래에서 따로 넣는다.
 */
export const MIGRATION_SEED_SQL: readonly string[] = [
  `INSERT INTO payout_policy VALUES ('default', 10000, 30, '{"DOMESTIC_INDIVIDUAL":330,"DOMESTIC_CORP":0,"FOREIGN":2200,"EXEMPT":0}')`,
  // 0030: 플랫폼 소유 곡은 정합성 검증을 경고만 한다(validation_enforced = false).
  `INSERT INTO tenant VALUES ('tnt_platform', 'PLATFORM_OPS', 'dobedupop 플랫폼 운영', 'ACTIVE', '2026-01-01T00:00:00Z', false)`,
  `INSERT INTO tenant VALUES ('tnt_platform_default', 'PLATFORM_DEFAULT', '개인(소속 없음)', 'ACTIVE', '2026-01-01T00:00:00Z')`,
  // 0032: 표준 계약 템플릿 v1 5종(법무 초안 시드). 문안이 길어 마이그레이션 파일의 문장을 그대로 읽는다.
  /INSERT INTO contract_template \(template_id[\s\S]*?\);\n/.exec(readFileSync(new URL("../../migrations/0032_contracts.sql", import.meta.url), "utf8"))![0],
  // 0038: 표준 분배 규칙 템플릿 2종(법무 초안 시드).
  /INSERT INTO policy_template \(template_id[\s\S]*?\);\n/.exec(readFileSync(new URL("../../migrations/0038_policy_templates.sql", import.meta.url), "utf8"))![0],
  // 0039: 권한 목록·legacy 역할·역할–권한·위임 업무 권한(파일 순서대로 — 역할·권한이 먼저).
  ...migrationInserts("0039_rbac.sql"),
  // 0040: 직무 분리 규칙(모두 꺼짐).
  ...migrationInserts("0040_sod_rules.sql"),
  // 0041: 총괄 역할과 그 권한.
  ...migrationInserts("0041_super_roles.sql"),
  // 0044: 읽기 틀 승인 권한과 권리 확인서 템플릿 2종.
  ...migrationInserts("0044_contract_import.sql"),
];

/** 마이그레이션 파일의 줄 첫머리 INSERT 문 전부(파일 순서). */
function migrationInserts(file: string): string[] {
  return readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8").match(/^INSERT INTO [\s\S]*?;\n/gm) ?? [];
}

async function resetWith(c: pg.Client): Promise<{ truncated: string[] }> {
  await c.query("BEGIN");
  try {
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename")).rows.map((r) => r.tablename as string);
    // TRUNCATE는 행 트리거를 부르지 않으므로 추가 전용 트리거를 우회한다 — 개발 DB에서만 쓴다.
    if (tables.length > 0) await c.query(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await c.query("DELETE FROM pgboss.job");
    for (const sql of MIGRATION_SEED_SQL) await c.query(sql);
    if (tables.includes("dev_clock")) await c.query("INSERT INTO dev_clock (base_at, set_real_at) VALUES ($1, now())", [DEV_CLOCK_START]);
    await c.query("COMMIT");
    return { truncated: tables };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** 개발 DB 초기화: URL의 이름과 연결된 current_database()가 모두 rights_core_dev여야 한다. 봉인 blob은 내용 주소라 지우지 않는다. */
export async function resetDevDatabase(adminUrl: string, allowedName: string = DEV_DB_NAME): Promise<{ truncated: string[] }> {
  assertDevDbName(decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, "")), allowedName);
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    assertDevDbName((await c.query("SELECT current_database() AS n")).rows[0].n as string, allowedName);
    return await resetWith(c);
  } finally {
    await c.end();
  }
}
