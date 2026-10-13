# I-1 권리 코어 PoC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MDRL 엔진을 실제 PostgreSQL 위의 권리 코어 백엔드(`rights-core`)에 연결해, 권리 등록 → 정책 컴파일·승인·활성화 → 팩 활성화 → 조합 발행(봉인)까지를 최소 HTTP API와 시나리오 러너(합성 곡 1개·1만 조합, 전수 재도출 감사)로 증명한다.

**Architecture:** Node·TypeScript 모듈형 모놀리스. `routes → service → repo(SQL)` 계층, 모듈 사이는 service 함수로만 호출한다. `mdrl`을 import하는 곳은 `src/engine-bridge/`뿐이다. 관계형 행이 원본이고, 결정 입력(정책 IR·facts IR·투영·멤버)은 행에서 결정적으로 만들어 digest로 봉인한 문서(`sealed_document` + 파일시스템 blob)만 쓴다.

**Tech Stack:** Node.js ≥ 24(TypeScript 직접 실행), TypeScript 5.9(`erasableSyntaxOnly`, 타입검사 전용), `node:test`, Fastify 5, node-postgres(`pg`) 8, PostgreSQL 17(Docker Compose), npm workspaces(`mdrl`, `rights-core`).

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` 2~6절과 **9절(I-1 설계 결정)**, `03_dobedupop_플랫폼설계/최신설계/데이터모델_v2.8.md`, `MDRL_아키텍처_코어규격_설계_v1.0.md`.

## Global Constraints

- 작업 디렉터리: `/Users/changkyuneun/Vocal Combination/03_구현문서_코드` (git 루트 `/Users/changkyuneun/Vocal Combination`). 저장소에는 무관한 커밋 안 된 변경이 많다. `git add`는 태스크에 나열된 파일만 한다. `git stash`, `git reset`, `git checkout -- <path>`는 쓰지 않는다. 임시·재현용 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TypeScript는 erasable syntax만: `enum`, `namespace`, 생성자 parameter property 금지(필드를 명시적으로 선언하고 생성자에서 대입). 상대 import는 `.ts` 확장자. 타입 전용 import는 `import type`.
- `mdrl`(`mdrl/core`·`mdrl/facts`·`mdrl/allocation`·`mdrl/text`)을 import하는 파일은 `rights-core/src/engine-bridge/` 아래에만 둔다(Task 3의 아키텍처 테스트가 강제).
- 라이브러리 코드에서 부동소수 금지. 금액·bps는 정수, IR 값은 문자열.
- 시각은 ISO 8601 밀리초 UTC 문자열(`2026-01-01T00:00:00.000Z`)로 다루고, DB에는 `TIMESTAMPTZ`로 밀리초 절사값만 저장한다(`CHECK (x = date_trunc('milliseconds', x))`). 서비스 함수는 현재 시각을 직접 읽지 않고 `Clock`을 인자로 받는다.
- id는 MDRL id 규칙 `^[A-Za-z0-9._-]+$`, `__proto__` 금지(DB 도메인 `mdrl_id`).
- 추가 전용 보호: `right_claim`·`mandate`는 트리거가 UPDATE·DELETE를 거부하고 같은 트랜잭션의 `superseded_at` 1회 설정만 허용한다. 봉인·스냅샷·서명·감사 테이블은 UPDATE·DELETE 모두 거부한다. 앱 DB 역할 `rc_app`은 SELECT·INSERT와 명시된 컬럼 UPDATE만 갖는다.
- 오류 → HTTP: `DomainError.status`를 그대로 쓴다. MDRL 진단 422, 직무 분리·권한 403, 상태 충돌·분쟁 409, 없음 404, 신원 없음 401. PostgreSQL `23505`(유일 위반) → 409 `CONFLICT`, `RC001`(추가 전용 위반) → 409 `APPEND_ONLY`.
- 테스트는 Docker PostgreSQL이 떠 있어야 한다: `docker compose up -d` (작업 디렉터리에서). 테스트 파일마다 템플릿 DB를 복제한 새 DB를 `rc_app` 역할로 쓴다.
- 새 런타임 의존성은 `fastify`, `pg`뿐이다. `rights-core`의 dev 의존성은 `@types/pg`, `@types/node`, `typescript`(mdrl과 같은 버전 범위)뿐이다.

## File Structure

```
04_구현_소스코드/
  package.json                       (Create: workspaces ["mdrl","rights-core"])
  package-lock.json                  (Create by npm install; mdrl/package-lock.json 삭제)
  docker-compose.yml                 (Create: postgres:17, 포트 54329)
  mdrl/scripts/smoke-pack.ts         (Modify: 끌어올린 typescript·@types 경로 해석)
  rights-core/
    package.json  tsconfig.json  .gitignore
    db/init/01-roles.sql             (Create: rc_app 역할)
    migrations/0001_base.sql         (mdrl_id 도메인, 트리거 함수, audit_log, outbox)
    migrations/0002_registry.sql     (party, work, facts_scope, recording_version, part_slot, stem, voice, right_claim, mandate, dispute)
    migrations/0003_seal.sql         (sealed_document)
    migrations/0004_policy.sql       (user_account, portal_role, dev_signing_key, attestation, vocal_pack, pack_claimant, policy_version)
    migrations/0005_issuance.sql     (rights_snapshot, snapshot_stem_assignment, snapshot_member_pct, issue_seal)
    src/platform/  errors.ts clock.ts db.ts migrate.ts dbadmin.ts actor.ts audit.ts outbox.ts
    src/registry/  repo.ts service.ts disputes.ts routes.ts
    src/engine-bridge/  context.ts blob-fs.ts seal-store.ts convert-facts.ts facts.ts policy.ts attest.ts activation.ts issue.ts
    src/policy/    service.ts routes.ts
    src/issuance/  service.ts routes.ts
    src/http/      server.ts seal-routes.ts main.ts
    src/scenario/  prng.ts synthetic-song.ts run.ts main.ts
    test/helpers.ts
    test/platform/migrate.test.ts  test/registry/registry.test.ts  test/registry/disputes.test.ts
    test/engine-bridge/facts.test.ts  test/engine-bridge/architecture.test.ts
    test/policy/policy.test.ts  test/issuance/issuance.test.ts  test/http/api.test.ts  test/scenario/scenario.test.ts
02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md  (Modify in Task 8: 9.5 결과)
```

---

### Task 1: workspace·Docker PostgreSQL·platform 기반

**Files:**
- Create: `package.json`, `docker-compose.yml`, `rights-core/package.json`, `rights-core/tsconfig.json`, `rights-core/.gitignore`, `rights-core/db/init/01-roles.sql`, `rights-core/migrations/0001_base.sql`, `rights-core/src/platform/{errors,clock,db,migrate,dbadmin}.ts`, `rights-core/test/helpers.ts`, `rights-core/test/platform/migrate.test.ts`
- Modify: `mdrl/scripts/smoke-pack.ts`
- Delete: `mdrl/package-lock.json`

**Interfaces:**
- Produces:
  - `class DomainError extends Error { code: string; status: 400|401|403|404|409|422|500; diagnostics: readonly Diagnostic[] }`, `type Diagnostic = { code: string; path: string; message: string }` (`src/platform/errors.ts`)
  - `type Clock = { now(): string }`, `systemClock`, `fixedClock(startIso: string, stepMs = 1): Clock` (`src/platform/clock.ts`)
  - `type Tx = pg.PoolClient`, `type Db = { pool: pg.Pool; tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; close(): Promise<void> }`, `createDb(url: string): Db`, `iso(v: Date | null): string | undefined` (`src/platform/db.ts`)
  - `migrate(client: pg.ClientBase, dir?: string): Promise<string[]>`, `MIGRATIONS_DIR` (`src/platform/migrate.ts`)
  - `createFreshDatabase(adminUrl: string): Promise<{ name: string; appUrl: string; drop(): Promise<void> }>`, `ADMIN_URL`, `appUrlFor(name: string): string` (`src/platform/dbadmin.ts`)
  - 테스트 헬퍼 `freshDb(): Promise<{ db: Db; drop(): Promise<void> }>` (`test/helpers.ts`)

- [ ] **Step 1: workspace와 Docker 구성**

`04_구현_소스코드/package.json`:
```json
{
  "name": "vocal-combination-code",
  "private": true,
  "workspaces": ["mdrl", "rights-core"],
  "engines": { "node": ">=24" }
}
```

`04_구현_소스코드/docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: rc
      POSTGRES_PASSWORD: rc
      POSTGRES_DB: rights_core
    ports:
      - "54329:5432"
    volumes:
      - ./rights-core/db/init:/docker-entrypoint-initdb.d:ro
```

`rights-core/db/init/01-roles.sql`:
```sql
-- 앱 역할: 마이그레이션이 테이블별로 SELECT·INSERT와 필요한 컬럼 UPDATE만 부여한다.
CREATE ROLE rc_app LOGIN PASSWORD 'rc_app';
```

`rights-core/package.json`:
```json
{
  "name": "rights-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "pretest": "npm run build --prefix ../mdrl",
    "test": "node --test --test-concurrency=4 \"test/**/*.test.ts\"",
    "typecheck": "tsc -p tsconfig.json",
    "serve": "node src/http/main.ts",
    "prescenario": "npm run build --prefix ../mdrl",
    "scenario": "node src/scenario/main.ts"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "pg": "^8.13.0",
    "mdrl": "0.1.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/pg": "^8.11.0",
    "typescript": "^5.9.0"
  }
}
```

`rights-core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`rights-core/.gitignore`:
```
node_modules/
.blobs/
```

- [ ] **Step 2: 의존성 설치와 mdrl 스모크 경로 수정**

`mdrl/package.json`의 `devDependencies`(`typescript`, `@types/node`, `ajv`)는 그대로 둔다. workspace 루트에서 설치한다:

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git rm -q mdrl/package-lock.json
npm install
```

설치 후 `typescript`와 `@types/node`가 루트 `node_modules`로 끌어올려지므로, `mdrl/scripts/smoke-pack.ts`에서 하드코딩된 두 경로를 모듈 해석으로 바꾼다. 파일 상단 import에 `import { createRequire } from "node:module";`와 `import { dirname } from "node:path";`(이미 `join`을 import하는 줄에 `dirname`을 추가)를 넣고, `const pkg = …` 줄 아래에 추가:

```ts
const requireFromPkg = createRequire(join(pkg, "package.json"));
const tscBin = requireFromPkg.resolve("typescript/bin/tsc");
const typesRoot = dirname(dirname(requireFromPkg.resolve("@types/node/package.json")));
```

그리고 `typeRoots: [join(pkg, "node_modules", "@types")]`를 `typeRoots: [typesRoot]`로, `sh(process.execPath, [join(pkg, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], app)`를 `sh(process.execPath, [tscBin, "-p", "tsconfig.json"], app)`로 바꾼다.

Run: `npm test -w mdrl 2>&1 | grep -E "^ℹ (pass|fail)" && npm run smoke -w mdrl 2>&1 | tail -1`
Expected: `ℹ pass 254`, `ℹ fail 0`, 마지막 줄 `smoke OK mdrl:sha256:5dc63e54…`.

- [ ] **Step 3: 실패하는 마이그레이션 테스트 작성**

`rights-core/test/helpers.ts`:
```ts
import { createDb, type Db } from "../src/platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../src/platform/dbadmin.ts";

/** 템플릿 DB를 복제한 새 DB에 rc_app 역할로 연결한다. 테스트 파일마다 한 번 호출하고 after()에서 drop한다. */
export async function freshDb(): Promise<{ db: Db; drop(): Promise<void> }> {
  const fresh = await createFreshDatabase(ADMIN_URL);
  const db = createDb(fresh.appUrl);
  return {
    db,
    async drop() {
      await db.close();
      await fresh.drop();
    },
  };
}
```

`rights-core/test/platform/migrate.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";

const { db, drop } = await freshDb();
after(drop);

test("fresh database has migrations applied and connects as rc_app", async () => {
  const r = await db.pool.query("SELECT current_user AS u, (SELECT count(*) FROM schema_migrations)::int AS n");
  assert.equal(r.rows[0].u, "rc_app");
  assert.ok(r.rows[0].n >= 1);
});

test("mdrl_id domain rejects invalid ids and __proto__", async () => {
  await assert.rejects(db.pool.query("SELECT 'a b'::mdrl_id"));
  await assert.rejects(db.pool.query("SELECT '__proto__'::mdrl_id"));
  const ok = await db.pool.query("SELECT 'pty_a.b-1'::mdrl_id AS v");
  assert.equal(ok.rows[0].v, "pty_a.b-1");
});

test("audit_log is insert-only for rc_app", async () => {
  await db.pool.query(
    "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id) VALUES (now(), 'u', 'x', 'y', 'z')",
  );
  await assert.rejects(db.pool.query("UPDATE audit_log SET action_name = 'w'"));
  await assert.rejects(db.pool.query("DELETE FROM audit_log"));
});

test("tx rolls back on error", async () => {
  await assert.rejects(db.tx(async (tx) => {
    await tx.query("INSERT INTO outbox (topic, payload, created_at) VALUES ('t', '{}', now())");
    throw new Error("boom");
  }));
  const r = await db.pool.query("SELECT count(*)::int AS n FROM outbox");
  assert.equal(r.rows[0].n, 0);
});

test("fixedClock steps by the given milliseconds", () => {
  const c = fixedClock("2026-01-01T00:00:00.000Z", 5);
  assert.equal(c.now(), "2026-01-01T00:00:00.000Z");
  assert.equal(c.now(), "2026-01-01T00:00:00.005Z");
  const still = fixedClock("2026-01-01T00:00:00.000Z", 0);
  assert.equal(still.now(), still.now());
});
```

- [ ] **Step 4: 실패 확인**

Run: `cd rights-core && docker compose -f ../docker-compose.yml up -d && node --test test/platform/migrate.test.ts`
Expected: FAIL (`Cannot find module '../src/platform/db.ts'`).

- [ ] **Step 5: platform 구현**

`rights-core/src/platform/errors.ts`:
```ts
export type Diagnostic = { code: string; path: string; message: string };
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/** 서비스 계층의 업무 오류. HTTP 계층은 status와 code, diagnostics를 그대로 응답한다. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: HttpStatus;
  readonly diagnostics: readonly Diagnostic[];
  constructor(code: string, status: HttpStatus, message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

export const notFound = (what: string, id: string) => new DomainError("NOT_FOUND", 404, `${what} not found: ${id}`);
export const conflict = (code: string, message: string) => new DomainError(code, 409, message);
export const invalid = (code: string, message: string, diagnostics: readonly Diagnostic[] = []) =>
  new DomainError(code, 422, message, diagnostics);
```

`rights-core/src/platform/clock.ts`:
```ts
/** 서비스는 현재 시각을 직접 읽지 않고 Clock을 받는다. now()는 밀리초 UTC ISO 문자열이다. */
export type Clock = { now(): string };

export const systemClock: Clock = { now: () => new Date().toISOString() };

/** 테스트·시나리오용: startIso에서 시작해 호출마다 stepMs씩 증가한다(0이면 고정). */
export function fixedClock(startIso: string, stepMs = 1): Clock {
  let t = Date.parse(startIso);
  return {
    now() {
      const s = new Date(t).toISOString();
      t += stepMs;
      return s;
    },
  };
}
```

`rights-core/src/platform/db.ts`:
```ts
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
```

`rights-core/src/platform/migrate.ts`:
```ts
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
```

`rights-core/src/platform/dbadmin.ts`:
```ts
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
```

`rights-core/migrations/0001_base.sql`:
```sql
-- MDRL id 규칙(코어 규격 3절): 영숫자·점·밑줄·하이픈, __proto__ 금지.
CREATE DOMAIN mdrl_id AS TEXT CHECK (VALUE ~ '^[A-Za-z0-9._-]+$' AND VALUE <> '__proto__');

-- 불변 테이블: UPDATE·DELETE 거부.
CREATE FUNCTION rc_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RC001';
END $$;

-- 이중 시간축 테이블: DELETE 거부, UPDATE는 superseded_at을 NULL에서 값으로 한 번 설정하는 것만 허용.
CREATE FUNCTION rc_allow_supersede_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'append-only table %: DELETE rejected', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'append-only table %: only a single superseded_at set is allowed', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;

-- PoC 감사 로그(v2.8 audit_log의 부분 집합, audit_id는 BIGSERIAL).
CREATE TABLE audit_log (
  audit_id      BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL,
  actor_user_id TEXT NOT NULL,
  action_name   VARCHAR(64) NOT NULL,
  entity_type   VARCHAR(64) NOT NULL,
  entity_id     TEXT NOT NULL,
  after_json    JSONB NULL
);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

-- 트랜잭션 Outbox.
CREATE TABLE outbox (
  outbox_id    BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NULL
);
CREATE INDEX outbox_pending ON outbox (outbox_id) WHERE processed_at IS NULL;

GRANT SELECT, INSERT ON audit_log, outbox TO rc_app;
GRANT UPDATE (processed_at) ON outbox TO rc_app;
GRANT USAGE ON SEQUENCE audit_log_audit_id_seq, outbox_outbox_id_seq TO rc_app;
```

- [ ] **Step 6: 통과 확인**

Run: `cd rights-core && node --test test/platform/migrate.test.ts && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 5 PASS, `TSC_OK`.

- [ ] **Step 7: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add package.json package-lock.json docker-compose.yml mdrl/scripts/smoke-pack.ts \
  rights-core/package.json rights-core/tsconfig.json rights-core/.gitignore rights-core/db/init/01-roles.sql \
  rights-core/migrations/0001_base.sql rights-core/src/platform/errors.ts rights-core/src/platform/clock.ts \
  rights-core/src/platform/db.ts rights-core/src/platform/migrate.ts rights-core/src/platform/dbadmin.ts \
  rights-core/test/helpers.ts rights-core/test/platform/migrate.test.ts
git commit -m "feat(rights-core): npm workspaces, Docker PostgreSQL, platform 기반(마이그레이션·트랜잭션·시계·오류)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
(`mdrl/package-lock.json` 삭제는 Step 2의 `git rm`으로 이미 스테이징되어 이 커밋에 들어간다.)

---

### Task 2: registry(권리 등록소) 스키마와 서비스

**Files:**
- Create: `rights-core/migrations/0002_registry.sql`, `rights-core/src/registry/repo.ts`, `rights-core/src/registry/service.ts`
- Test: `rights-core/test/registry/registry.test.ts`

**Interfaces:**
- Consumes: `Tx`, `Clock`, `DomainError`, `notFound`, `conflict`, `invalid` (Task 1).
- Produces (`src/registry/service.ts`):
```ts
export type PartyType = "LABEL"|"AGENCY"|"PUBLISHER"|"CMO"|"AUTHOR"|"ARTIST"|"MEMBER"|"SESSION"|"AI_PROVIDER"|"FAN"|"PLATFORM";
export type ClaimEdge = "PERFORMED_BY"|"OWNED_BY"|"CONTROLLED_BY"|"WRITTEN_BY"|"CONTRIBUTED_BY";
export type RecordStatus = "ASSERTED"|"VERIFIED"|"DISPUTED"|"SUPERSEDED";
export type ClaimDraft = { claimId: string; factsScopeId: string; sourceId: string; edge: ClaimEdge; targetId: string;
  shareBps: number; performerRole?: "FEATURED"|"NON_FEATURED"; roleDetail?: string; status: RecordStatus;
  validFrom: string; validTo?: string; evidenceDigest?: string; visibility?: "PUBLIC"|"PARTIES"|"PRIVATE"; sourceRef?: string };
export type MandateDraft = { mandateId: string; factsScopeId: string; fromPartyId: string; toPartyId: string;
  rightKind: "MASTER"|"WORK"|"PERFORMER"; shareBps: number; status: RecordStatus; validFrom: string; validTo?: string;
  visibility?: "PUBLIC"|"PARTIES"|"PRIVATE"; sourceRef?: string };
export type Recorded = { id: string; version: number; recordedAt: string };
registerParty(tx, clock, { partyId, partyType, displayName, isni?, ipiNo? }): Promise<void>
registerWork(tx, clock, { workId, title, iswc? }): Promise<void>
createScope(tx, clock, { factsScopeId, workId }): Promise<void>
registerRecording(tx, clock, { recordingId, workId, masterOwnerPartyId, isrc?, versionTitle }): Promise<void>
registerSlot(tx, { slotId, recordingId, startMs, endMs, sortOrder }): Promise<void>
registerStem(tx, clock, { stemId, slotId, recordingId, performerPartyId?, rightsBearing }): Promise<void>
registerVoice(tx, clock, { voiceId, factsScopeId, kind: "HUMAN"|"AI" }): Promise<void>
recordClaim(tx, clock, draft: ClaimDraft): Promise<Recorded>
recordMandate(tx, clock, draft: MandateDraft): Promise<Recorded>
currentClaim(tx, claimId): Promise<ClaimDraft & { version: number }>   // 현재(미대체) 버전, 없으면 404
currentMandate(tx, mandateId): Promise<MandateDraft & { version: number }>
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/registry/registry.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as reg from "../../src/registry/service.ts";

const { db, drop } = await freshDb();
after(drop);
const T0 = "2026-01-01T00:00:00.000Z";

async function seed() {
  const c = fixedClock(T0, 0);
  await db.tx(async (tx) => {
    await reg.registerParty(tx, c, { partyId: "pty_label", partyType: "LABEL", displayName: "Label", isni: "0000000123456789" });
    await reg.registerParty(tx, c, { partyId: "pty_m1", partyType: "MEMBER", displayName: "M1" });
    await reg.registerParty(tx, c, { partyId: "pty_fan", partyType: "FAN", displayName: "Fan" });
    await reg.registerParty(tx, c, { partyId: "pty_cmo", partyType: "CMO", displayName: "CMO" });
    await reg.registerWork(tx, c, { workId: "wrk_1", title: "Song" });
    await reg.createScope(tx, c, { factsScopeId: "fsc_1", workId: "wrk_1" });
    await reg.registerRecording(tx, c, { recordingId: "rcd_1", workId: "wrk_1", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
    await reg.registerSlot(tx, { slotId: "slt_1", recordingId: "rcd_1", startMs: 0, endMs: 30000, sortOrder: 1 });
    await reg.registerStem(tx, c, { stemId: "stm_1", slotId: "slt_1", recordingId: "rcd_1", performerPartyId: "pty_m1", rightsBearing: true });
    await reg.registerVoice(tx, c, { voiceId: "vo_1", factsScopeId: "fsc_1", kind: "HUMAN" });
  });
}
await seed();

const claim = (over: Partial<reg.ClaimDraft> = {}): reg.ClaimDraft => ({
  claimId: "c_ctrl", factsScopeId: "fsc_1", sourceId: "rcd_1", edge: "CONTROLLED_BY", targetId: "pty_label",
  shareBps: 10000, status: "VERIFIED", validFrom: T0, ...over,
});

test("recordClaim creates version 1, then a new version supersedes the old one", async () => {
  const c = fixedClock("2026-02-01T00:00:00.000Z", 1000);
  const v1 = await db.tx((tx) => reg.recordClaim(tx, c, claim()));
  assert.deepEqual(v1, { id: "c_ctrl", version: 1, recordedAt: "2026-02-01T00:00:00.000Z" });
  const v2 = await db.tx((tx) => reg.recordClaim(tx, c, claim({ status: "DISPUTED" })));
  assert.equal(v2.version, 2);
  const rows = await db.pool.query("SELECT version, status, superseded_at FROM right_claim WHERE claim_id = 'c_ctrl' ORDER BY version");
  assert.equal(rows.rows[0].superseded_at.toISOString(), "2026-02-01T00:00:01.000Z");
  assert.equal(rows.rows[1].superseded_at, null);
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_ctrl"));
  assert.equal(cur.status, "DISPUTED");
  assert.equal(cur.version, 2);
});

test("right_claim rows cannot be updated or deleted except a single superseded_at set", async () => {
  await assert.rejects(db.pool.query("UPDATE right_claim SET share_bps = 1 WHERE claim_id = 'c_ctrl'"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM right_claim WHERE claim_id = 'c_ctrl'"), /append-only|permission denied/);
  await assert.rejects(
    db.pool.query("UPDATE right_claim SET superseded_at = now() WHERE claim_id = 'c_ctrl' AND version = 1"),
    /append-only/,
  );
});

test("edge endpoint kinds are enforced", async () => {
  const c = fixedClock("2026-03-01T00:00:00.000Z", 1000);
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_bad1", sourceId: "stm_1" }))), { code: "INVALID_REFERENCE" });
  await assert.rejects(
    db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_bad2", edge: "PERFORMED_BY", sourceId: "stm_1", targetId: "pty_m1", performerRole: "FEATURED" }))),
    { code: "INVALID_REFERENCE" },
  );
  const ok = await db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_perf", edge: "PERFORMED_BY", sourceId: "stm_1", targetId: "vo_1", performerRole: "FEATURED" })));
  assert.equal(ok.version, 1);
});

test("FAN and PLATFORM parties cannot appear in facts", async () => {
  const c = fixedClock("2026-04-01T00:00:00.000Z", 1000);
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_fan", targetId: "pty_fan" }))), { code: "INVALID_REFERENCE" });
  await assert.rejects(
    db.tx((tx) => reg.recordMandate(tx, c, {
      mandateId: "m_fan", factsScopeId: "fsc_1", fromPartyId: "pty_fan", toPartyId: "pty_cmo", rightKind: "WORK",
      shareBps: 10000, status: "VERIFIED", validFrom: T0,
    })),
    { code: "INVALID_REFERENCE" },
  );
});

test("a new version must be recorded strictly after the current one and stay in the same scope", async () => {
  const c = fixedClock("2026-05-01T00:00:00.000Z", 0);
  await db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_same" })));
  await assert.rejects(db.tx((tx) => reg.recordClaim(tx, c, claim({ claimId: "c_same" }))), { code: "CLOCK_NOT_MONOTONIC" });
});

test("recordMandate versions like claims and rejects self-mandates", async () => {
  const c = fixedClock("2026-06-01T00:00:00.000Z", 1000);
  const m = { mandateId: "m_1", factsScopeId: "fsc_1", fromPartyId: "pty_m1", toPartyId: "pty_cmo", rightKind: "PERFORMER" as const,
    shareBps: 10000, status: "VERIFIED" as const, validFrom: T0 };
  assert.equal((await db.tx((tx) => reg.recordMandate(tx, c, m))).version, 1);
  assert.equal((await db.tx((tx) => reg.recordMandate(tx, c, { ...m, shareBps: 5000 }))).version, 2);
  await assert.rejects(db.tx((tx) => reg.recordMandate(tx, c, { ...m, mandateId: "m_self", toPartyId: "pty_m1" })), { code: "INVALID_REFERENCE" });
});

test("entities are immutable and stems must belong to their slot's recording", async () => {
  await assert.rejects(db.pool.query("UPDATE party SET display_name = 'x' WHERE party_id = 'pty_m1'"), /append-only|permission denied/);
  const c = fixedClock(T0, 0);
  await assert.rejects(db.tx(async (tx) => {
    await reg.registerRecording(tx, c, { recordingId: "rcd_2", workId: "wrk_1", masterOwnerPartyId: "pty_label", versionTitle: "B" });
    await reg.registerStem(tx, c, { stemId: "stm_x", slotId: "slt_1", recordingId: "rcd_2", rightsBearing: true });
  }));
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/registry/registry.test.ts`
Expected: FAIL (`Cannot find module '../../src/registry/service.ts'`).

- [ ] **Step 3: 마이그레이션 작성**

`rights-core/migrations/0002_registry.sql`:
```sql
-- v2.8 3.1·3.2·3.3의 I-1 부분 집합. 컬럼 이름·타입은 v2.8과 같고, 범위 밖 컬럼은 이후 마이그레이션에서 추가한다.
-- 예외: work.iswc는 표시 형식(T-123.456.789-0)을 담기 위해 TEXT.

CREATE TABLE party (
  party_id     mdrl_id PRIMARY KEY,
  party_type   TEXT NOT NULL CHECK (party_type IN ('LABEL','AGENCY','PUBLISHER','CMO','AUTHOR','ARTIST','MEMBER','SESSION','AI_PROVIDER','FAN','PLATFORM')),
  display_name TEXT NOT NULL,
  isni         CHAR(16) NULL,
  ipi_no       VARCHAR(11) NULL,
  created_at   TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE work (
  work_id    mdrl_id PRIMARY KEY,
  title      TEXT NOT NULL,
  iswc       TEXT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE facts_scope (
  facts_scope_id mdrl_id PRIMARY KEY,
  work_id        mdrl_id NOT NULL UNIQUE REFERENCES work,
  last_version   INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE recording_version (
  recording_id          mdrl_id PRIMARY KEY,
  work_id               mdrl_id NOT NULL REFERENCES work,
  master_owner_party_id mdrl_id NOT NULL REFERENCES party,
  isrc                  CHAR(12) NULL UNIQUE,
  version_title         TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE part_slot (
  slot_id      mdrl_id PRIMARY KEY,
  recording_id mdrl_id NOT NULL REFERENCES recording_version,
  start_ms     INT NOT NULL CHECK (start_ms >= 0),
  end_ms       INT NOT NULL,
  duration_ms  INT GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  sort_order   INT NOT NULL,
  CHECK (end_ms > start_ms),
  UNIQUE (recording_id, sort_order),
  UNIQUE (slot_id, recording_id)
);

CREATE TABLE stem (
  stem_id            mdrl_id PRIMARY KEY,
  slot_id            mdrl_id NOT NULL,
  recording_id       mdrl_id NOT NULL,
  performer_party_id mdrl_id NULL REFERENCES party,
  rights_bearing     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  FOREIGN KEY (slot_id, recording_id) REFERENCES part_slot (slot_id, recording_id)
);

CREATE TABLE voice (
  voice_id       mdrl_id PRIMARY KEY,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  kind           TEXT NOT NULL CHECK (kind IN ('HUMAN','AI')),
  created_at     TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at))
);

CREATE TABLE right_claim (
  claim_id        mdrl_id NOT NULL,
  version         INT NOT NULL CHECK (version >= 1),
  facts_scope_id  mdrl_id NOT NULL REFERENCES facts_scope,
  source_id       mdrl_id NOT NULL,
  edge            TEXT NOT NULL CHECK (edge IN ('PERFORMED_BY','OWNED_BY','CONTROLLED_BY','WRITTEN_BY','CONTRIBUTED_BY')),
  target_id       mdrl_id NOT NULL,
  share_bps       INT NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  performer_role  TEXT NULL CHECK (performer_role IN ('FEATURED','NON_FEATURED')),
  role_detail     TEXT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from      TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to        TIMESTAMPTZ NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  recorded_at     TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  superseded_at   TIMESTAMPTZ NULL CHECK (superseded_at = date_trunc('milliseconds', superseded_at)),
  evidence_digest TEXT NULL CHECK (evidence_digest ~ '^mdrl:sha256:[0-9a-f]{64}$'),
  visibility      TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref      TEXT NULL,
  PRIMARY KEY (claim_id, version),
  UNIQUE (claim_id, recorded_at),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (superseded_at IS NULL OR superseded_at > recorded_at),
  CHECK (performer_role IS NULL OR edge = 'PERFORMED_BY')
);
CREATE UNIQUE INDEX right_claim_current ON right_claim (claim_id) WHERE superseded_at IS NULL;
CREATE INDEX right_claim_scope ON right_claim (facts_scope_id, recorded_at);

CREATE TABLE mandate (
  mandate_id     mdrl_id NOT NULL,
  version        INT NOT NULL CHECK (version >= 1),
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  from_party_id  mdrl_id NOT NULL REFERENCES party,
  to_party_id    mdrl_id NOT NULL REFERENCES party,
  right_kind     TEXT NOT NULL CHECK (right_kind IN ('MASTER','WORK','PERFORMER')),
  share_bps      INT NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  status         TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from     TIMESTAMPTZ NOT NULL CHECK (valid_from = date_trunc('milliseconds', valid_from)),
  valid_to       TIMESTAMPTZ NULL CHECK (valid_to = date_trunc('milliseconds', valid_to)),
  recorded_at    TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  superseded_at  TIMESTAMPTZ NULL CHECK (superseded_at = date_trunc('milliseconds', superseded_at)),
  visibility     TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref     TEXT NULL,
  PRIMARY KEY (mandate_id, version),
  UNIQUE (mandate_id, recorded_at),
  CHECK (from_party_id <> to_party_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (superseded_at IS NULL OR superseded_at > recorded_at)
);
CREATE UNIQUE INDEX mandate_current ON mandate (mandate_id) WHERE superseded_at IS NULL;
CREATE INDEX mandate_scope ON mandate (facts_scope_id, recorded_at);

-- 분쟁(v2.8 3.8 dispute의 I-1 부분 집합). 서비스는 Task 6.
CREATE TABLE dispute (
  dispute_id     mdrl_id PRIMARY KEY,
  target_type    TEXT NOT NULL CHECK (target_type IN ('RIGHT_CLAIM','MANDATE')),
  target_id      mdrl_id NOT NULL,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  dispute_reason TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  opened_at      TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX dispute_one_open ON dispute (target_type, target_id) WHERE status = 'OPEN';
CREATE INDEX dispute_open_scope ON dispute (facts_scope_id) WHERE status = 'OPEN';

-- 엔티티는 I-1에서 불변(IR에 들어가는 값이 바뀌면 digest가 설명 없이 바뀌므로).
CREATE TRIGGER party_immutable BEFORE UPDATE OR DELETE ON party FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER work_immutable BEFORE UPDATE OR DELETE ON work FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER recording_immutable BEFORE UPDATE OR DELETE ON recording_version FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER part_slot_immutable BEFORE UPDATE OR DELETE ON part_slot FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER stem_immutable BEFORE UPDATE OR DELETE ON stem FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER voice_immutable BEFORE UPDATE OR DELETE ON voice FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER right_claim_append_only BEFORE UPDATE OR DELETE ON right_claim FOR EACH ROW EXECUTE FUNCTION rc_allow_supersede_only();
CREATE TRIGGER mandate_append_only BEFORE UPDATE OR DELETE ON mandate FOR EACH ROW EXECUTE FUNCTION rc_allow_supersede_only();

GRANT SELECT, INSERT ON party, work, facts_scope, recording_version, part_slot, stem, voice, right_claim, mandate, dispute TO rc_app;
GRANT UPDATE (last_version) ON facts_scope TO rc_app;
GRANT UPDATE (superseded_at) ON right_claim, mandate TO rc_app;
GRANT UPDATE (status, closed_at) ON dispute TO rc_app;
```

- [ ] **Step 4: repo와 service 구현**

`rights-core/src/registry/repo.ts`:
```ts
import type { Tx } from "../platform/db.ts";

export type EntityKind = "party" | "work" | "recording" | "stem" | "voice";

const LOOKUP: Record<EntityKind, string> = {
  party: "SELECT party_id AS id, party_type AS detail, NULL::text AS scope FROM party WHERE party_id = $1",
  work: "SELECT w.work_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM work w LEFT JOIN facts_scope s ON s.work_id = w.work_id WHERE w.work_id = $1",
  recording: "SELECT r.recording_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM recording_version r LEFT JOIN facts_scope s ON s.work_id = r.work_id WHERE r.recording_id = $1",
  stem: "SELECT st.stem_id AS id, NULL::text AS detail, s.facts_scope_id AS scope FROM stem st JOIN recording_version r ON r.recording_id = st.recording_id LEFT JOIN facts_scope s ON s.work_id = r.work_id WHERE st.stem_id = $1",
  voice: "SELECT voice_id AS id, kind AS detail, facts_scope_id AS scope FROM voice WHERE voice_id = $1",
};

/** 엔티티 존재·소속 범위 조회. detail은 party_type 또는 voice kind. */
export async function lookup(tx: Tx, kind: EntityKind, id: string): Promise<{ id: string; detail: string | null; scope: string | null } | undefined> {
  const r = await tx.query(LOOKUP[kind], [id]);
  return r.rows[0];
}

export async function scopeExists(tx: Tx, scopeId: string): Promise<boolean> {
  return ((await tx.query("SELECT 1 FROM facts_scope WHERE facts_scope_id = $1", [scopeId])).rowCount ?? 0) > 0;
}
```

`rights-core/src/registry/service.ts`:
```ts
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, invalid, notFound } from "../platform/errors.ts";
import { lookup, scopeExists, type EntityKind } from "./repo.ts";

export type PartyType = "LABEL" | "AGENCY" | "PUBLISHER" | "CMO" | "AUTHOR" | "ARTIST" | "MEMBER" | "SESSION" | "AI_PROVIDER" | "FAN" | "PLATFORM";
export type ClaimEdge = "PERFORMED_BY" | "OWNED_BY" | "CONTROLLED_BY" | "WRITTEN_BY" | "CONTRIBUTED_BY";
export type RecordStatus = "ASSERTED" | "VERIFIED" | "DISPUTED" | "SUPERSEDED";
type Visibility = "PUBLIC" | "PARTIES" | "PRIVATE";

export type ClaimDraft = {
  claimId: string; factsScopeId: string; sourceId: string; edge: ClaimEdge; targetId: string; shareBps: number;
  performerRole?: "FEATURED" | "NON_FEATURED"; roleDetail?: string; status: RecordStatus; validFrom: string; validTo?: string;
  evidenceDigest?: string; visibility?: Visibility; sourceRef?: string;
};
export type MandateDraft = {
  mandateId: string; factsScopeId: string; fromPartyId: string; toPartyId: string; rightKind: "MASTER" | "WORK" | "PERFORMER";
  shareBps: number; status: RecordStatus; validFrom: string; validTo?: string; visibility?: Visibility; sourceRef?: string;
};
export type Recorded = { id: string; version: number; recordedAt: string };

/** MDRL CLAIM_EDGE_KINDS와 같은 표(코어 규격 facts/types.ts). */
const EDGE_ENDPOINTS: Record<ClaimEdge, readonly [EntityKind, EntityKind]> = {
  PERFORMED_BY: ["stem", "voice"],
  OWNED_BY: ["voice", "party"],
  CONTROLLED_BY: ["recording", "party"],
  WRITTEN_BY: ["work", "party"],
  CONTRIBUTED_BY: ["recording", "party"],
};
const NON_FACTS_PARTY = new Set(["FAN", "PLATFORM"]);

export async function registerParty(tx: Tx, clock: Clock, p: { partyId: string; partyType: PartyType; displayName: string; isni?: string; ipiNo?: string }): Promise<void> {
  await tx.query("INSERT INTO party (party_id, party_type, display_name, isni, ipi_no, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [p.partyId, p.partyType, p.displayName, p.isni ?? null, p.ipiNo ?? null, clock.now()]);
}

export async function registerWork(tx: Tx, clock: Clock, w: { workId: string; title: string; iswc?: string }): Promise<void> {
  await tx.query("INSERT INTO work (work_id, title, iswc, created_at) VALUES ($1,$2,$3,$4)", [w.workId, w.title, w.iswc ?? null, clock.now()]);
}

export async function createScope(tx: Tx, clock: Clock, s: { factsScopeId: string; workId: string }): Promise<void> {
  await tx.query("INSERT INTO facts_scope (facts_scope_id, work_id, created_at) VALUES ($1,$2,$3)", [s.factsScopeId, s.workId, clock.now()]);
}

export async function registerRecording(tx: Tx, clock: Clock, r: { recordingId: string; workId: string; masterOwnerPartyId: string; isrc?: string; versionTitle: string }): Promise<void> {
  await tx.query("INSERT INTO recording_version (recording_id, work_id, master_owner_party_id, isrc, version_title, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [r.recordingId, r.workId, r.masterOwnerPartyId, r.isrc ?? null, r.versionTitle, clock.now()]);
}

export async function registerSlot(tx: Tx, s: { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number }): Promise<void> {
  await tx.query("INSERT INTO part_slot (slot_id, recording_id, start_ms, end_ms, sort_order) VALUES ($1,$2,$3,$4,$5)",
    [s.slotId, s.recordingId, s.startMs, s.endMs, s.sortOrder]);
}

export async function registerStem(tx: Tx, clock: Clock, s: { stemId: string; slotId: string; recordingId: string; performerPartyId?: string; rightsBearing: boolean }): Promise<void> {
  await tx.query("INSERT INTO stem (stem_id, slot_id, recording_id, performer_party_id, rights_bearing, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [s.stemId, s.slotId, s.recordingId, s.performerPartyId ?? null, s.rightsBearing, clock.now()]);
}

export async function registerVoice(tx: Tx, clock: Clock, v: { voiceId: string; factsScopeId: string; kind: "HUMAN" | "AI" }): Promise<void> {
  await tx.query("INSERT INTO voice (voice_id, facts_scope_id, kind, created_at) VALUES ($1,$2,$3,$4)", [v.voiceId, v.factsScopeId, v.kind, clock.now()]);
}

/** 엔티티가 존재하고, 범위가 있는 종류면 같은 facts 범위에 속하며, party면 facts에 들어갈 수 있는 종류인지 확인한다. */
async function requireEndpoint(tx: Tx, kind: EntityKind, id: string, scopeId: string, role: string): Promise<void> {
  const e = await lookup(tx, kind, id);
  if (e === undefined) throw invalid("INVALID_REFERENCE", `${role}: ${kind} ${id} does not exist`);
  if (kind !== "party" && e.scope !== scopeId) throw invalid("INVALID_REFERENCE", `${role}: ${kind} ${id} is not in facts scope ${scopeId}`);
  if (kind === "party" && NON_FACTS_PARTY.has(e.detail ?? "")) throw invalid("INVALID_REFERENCE", `${role}: party ${id} (${e.detail}) cannot appear in facts`);
}

/**
 * 이중 시간축 버전 추가: 현재 버전을 잠그고, 새 버전을 INSERT한 뒤 직전 버전의 superseded_at을 설정한다.
 * 새 버전은 현재 버전보다 엄격히 늦게 기록되어야 하고 같은 facts 범위에 있어야 한다.
 */
async function nextVersion(tx: Tx, table: "right_claim" | "mandate", idCol: string, id: string, scopeId: string, recordedAt: string): Promise<number> {
  const cur = await tx.query(`SELECT version, recorded_at, facts_scope_id FROM ${table} WHERE ${idCol} = $1 AND superseded_at IS NULL FOR UPDATE`, [id]);
  const row = cur.rows[0];
  if (row === undefined) return 1;
  if (row.facts_scope_id !== scopeId) throw invalid("INVALID_REFERENCE", `${id} belongs to facts scope ${row.facts_scope_id}`);
  if (Date.parse(recordedAt) <= (row.recorded_at as Date).getTime()) {
    throw conflict("CLOCK_NOT_MONOTONIC", `${id}: new version must be recorded after ${iso(row.recorded_at)}`);
  }
  return (row.version as number) + 1;
}

async function supersede(tx: Tx, table: "right_claim" | "mandate", idCol: string, id: string, version: number, at: string): Promise<void> {
  if (version > 1) await tx.query(`UPDATE ${table} SET superseded_at = $3 WHERE ${idCol} = $1 AND version = $2`, [id, version - 1, at]);
}

export async function recordClaim(tx: Tx, clock: Clock, d: ClaimDraft): Promise<Recorded> {
  if (!(await scopeExists(tx, d.factsScopeId))) throw notFound("facts scope", d.factsScopeId);
  const [srcKind, dstKind] = EDGE_ENDPOINTS[d.edge];
  await requireEndpoint(tx, srcKind, d.sourceId, d.factsScopeId, "source");
  await requireEndpoint(tx, dstKind, d.targetId, d.factsScopeId, "target");
  const recordedAt = clock.now();
  const version = await nextVersion(tx, "right_claim", "claim_id", d.claimId, d.factsScopeId, recordedAt);
  await tx.query(
    `INSERT INTO right_claim (claim_id, version, facts_scope_id, source_id, edge, target_id, share_bps, performer_role, role_detail,
       status, valid_from, valid_to, recorded_at, evidence_digest, visibility, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [d.claimId, version, d.factsScopeId, d.sourceId, d.edge, d.targetId, d.shareBps, d.performerRole ?? null, d.roleDetail ?? null,
      d.status, d.validFrom, d.validTo ?? null, recordedAt, d.evidenceDigest ?? null, d.visibility ?? null, d.sourceRef ?? null],
  );
  await supersede(tx, "right_claim", "claim_id", d.claimId, version, recordedAt);
  return { id: d.claimId, version, recordedAt };
}

export async function recordMandate(tx: Tx, clock: Clock, d: MandateDraft): Promise<Recorded> {
  if (!(await scopeExists(tx, d.factsScopeId))) throw notFound("facts scope", d.factsScopeId);
  if (d.fromPartyId === d.toPartyId) throw invalid("INVALID_REFERENCE", `mandate ${d.mandateId}: from and to are the same party`);
  await requireEndpoint(tx, "party", d.fromPartyId, d.factsScopeId, "from");
  await requireEndpoint(tx, "party", d.toPartyId, d.factsScopeId, "to");
  const recordedAt = clock.now();
  const version = await nextVersion(tx, "mandate", "mandate_id", d.mandateId, d.factsScopeId, recordedAt);
  await tx.query(
    `INSERT INTO mandate (mandate_id, version, facts_scope_id, from_party_id, to_party_id, right_kind, share_bps, status,
       valid_from, valid_to, recorded_at, visibility, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [d.mandateId, version, d.factsScopeId, d.fromPartyId, d.toPartyId, d.rightKind, d.shareBps, d.status,
      d.validFrom, d.validTo ?? null, recordedAt, d.visibility ?? null, d.sourceRef ?? null],
  );
  await supersede(tx, "mandate", "mandate_id", d.mandateId, version, recordedAt);
  return { id: d.mandateId, version, recordedAt };
}

export async function currentClaim(tx: Tx, claimId: string): Promise<ClaimDraft & { version: number }> {
  const r = (await tx.query("SELECT * FROM right_claim WHERE claim_id = $1 AND superseded_at IS NULL", [claimId])).rows[0];
  if (r === undefined) throw notFound("claim", claimId);
  return {
    claimId: r.claim_id, version: r.version, factsScopeId: r.facts_scope_id, sourceId: r.source_id, edge: r.edge, targetId: r.target_id,
    shareBps: r.share_bps, status: r.status, validFrom: iso(r.valid_from)!,
    ...(r.performer_role !== null && { performerRole: r.performer_role }),
    ...(r.role_detail !== null && { roleDetail: r.role_detail }),
    ...(r.valid_to !== null && { validTo: iso(r.valid_to) }),
    ...(r.evidence_digest !== null && { evidenceDigest: r.evidence_digest }),
    ...(r.visibility !== null && { visibility: r.visibility }),
    ...(r.source_ref !== null && { sourceRef: r.source_ref }),
  };
}

export async function currentMandate(tx: Tx, mandateId: string): Promise<MandateDraft & { version: number }> {
  const r = (await tx.query("SELECT * FROM mandate WHERE mandate_id = $1 AND superseded_at IS NULL", [mandateId])).rows[0];
  if (r === undefined) throw notFound("mandate", mandateId);
  return {
    mandateId: r.mandate_id, version: r.version, factsScopeId: r.facts_scope_id, fromPartyId: r.from_party_id, toPartyId: r.to_party_id,
    rightKind: r.right_kind, shareBps: r.share_bps, status: r.status, validFrom: iso(r.valid_from)!,
    ...(r.valid_to !== null && { validTo: iso(r.valid_to) }),
    ...(r.visibility !== null && { visibility: r.visibility }),
    ...(r.source_ref !== null && { sourceRef: r.source_ref }),
  };
}
```

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/registry/registry.test.ts && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 7 PASS, `TSC_OK`. (`rc_app`에는 UPDATE 권한이 없는 컬럼이라 일부 거부는 `permission denied`로 나올 수 있다 — 테스트 정규식이 둘 다 받는다. 단 `superseded_at` 재설정 거부는 트리거 메시지 `append-only`여야 한다.)

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0002_registry.sql rights-core/src/registry/repo.ts rights-core/src/registry/service.ts rights-core/test/registry/registry.test.ts
git commit -m "feat(rights-core): 권리 등록소 스키마와 이중 시간축 버전 추가 서비스

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 봉인 저장소와 facts 변환·봉인(engine-bridge)

**Files:**
- Create: `rights-core/migrations/0003_seal.sql`, `rights-core/src/engine-bridge/{context,blob-fs,seal-store,convert-facts,facts}.ts`
- Test: `rights-core/test/engine-bridge/facts.test.ts`, `rights-core/test/engine-bridge/architecture.test.ts`

**Interfaces:**
- Consumes: Task 1(`Tx`, `DomainError`, `invalid`, `notFound`), Task 2 registry 서비스(테스트에서 행 등록).
- Produces:
```ts
// context.ts
export type BlobStore = { put(digest: string, bytes: Uint8Array): Promise<string>; get(uri: string): Promise<Uint8Array> };
export type BridgeCtx = { blobs: BlobStore; cache: Map<string, unknown> };
export function createBridgeCtx(blobs: BlobStore): BridgeCtx;
// blob-fs.ts
export function createFsBlobStore(root: string): BlobStore;
// seal-store.ts
export type SealKind = "facts"|"allocation"|"projection"|"members";
export type Sealed = { digest: string; kind: SealKind; docId?: string; docVersion?: string; format?: string };
export async function sealDocument(ctx, tx, input: { kind: SealKind; value: unknown; docId?: string; docVersion?: string; format?: string }): Promise<Sealed>;
export async function loadSealed(ctx, tx, digest: string): Promise<unknown>;       // 캐시, 없으면 404, digest 재확인
// convert-facts.ts (순수)
export type FactsRows = { scopeId: string; work: WorkRow; recordings: RecordingRow[]; stems: StemRow[]; voices: VoiceRow[];
  parties: PartyRow[]; claims: ClaimRow[]; mandates: MandateRow[] };
export function factsVersion(rows: FactsRows, knownAt: string): number;
export function buildFactsDocument(rows: FactsRows, knownAt: string): FactsDocument;
export const PARTY_KIND: Record<string, string | undefined>;
// facts.ts
export async function loadFactsRows(tx, scopeId: string, knownAt: string): Promise<FactsRows>;
export async function sealFacts(ctx, tx, scopeId: string, knownAt: string): Promise<Sealed & { knownAt: string }>;
export async function loadFacts(ctx, tx, digest: string): Promise<FactsDocument>;
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/engine-bridge/facts.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "mdrl/core";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import type { Tx } from "../../src/platform/db.ts";
import * as reg from "../../src/registry/service.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../../src/engine-bridge/blob-fs.ts";
import { loadSealed } from "../../src/engine-bridge/seal-store.ts";
import { loadFacts, sealFacts } from "../../src/engine-bridge/facts.ts";

const conformance = JSON.parse(readFileSync(new URL("../../../mdrl/conformance/facts/001-basic/input.json", import.meta.url), "utf8"));
const T0 = "2026-01-01T00:00:00.000Z";
const KNOWN_AT = "2026-06-01T00:00:00.000Z";
const KIND_TO_TYPE: Record<string, reg.PartyType> = { AGENCY: "AGENCY", AUTHOR: "AUTHOR", CMO: "CMO", LABEL: "LABEL", PERFORMER: "MEMBER" };

const shuffle = <T>(xs: T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** 적합성 facts 001-basic을 registry 행으로 등록한다(scope id = facts id). order가 있으면 각 목록 안의 순서를 섞는다. */
async function registerConformance(tx: Tx, seed?: number) {
  const c = fixedClock(T0, 0);
  const f = conformance.facts.body;
  const order = <T>(xs: T[]) => (seed === undefined ? xs : shuffle(xs, seed));
  for (const p of order<any>(f.parties)) {
    await reg.registerParty(tx, c, { partyId: p.id, partyType: KIND_TO_TYPE[p.kind]!, displayName: p.id, ...(p.ids?.isni && { isni: p.ids.isni }) });
  }
  await reg.registerWork(tx, c, { workId: "wrk_01", title: "Nova", iswc: f.works[0].ids.iswc });
  await reg.createScope(tx, c, { factsScopeId: conformance.facts.id, workId: "wrk_01" });
  await reg.registerRecording(tx, c, { recordingId: "rcd_01", workId: "wrk_01", masterOwnerPartyId: "pty_label_x", isrc: f.recordings[0].ids.isrc, versionTitle: "Main" });
  let sort = 1;
  for (const s of f.stems) await reg.registerSlot(tx, { slotId: s.slot, recordingId: "rcd_01", startMs: 0, endMs: 1000, sortOrder: sort++ });
  for (const s of order<any>(f.stems)) await reg.registerStem(tx, c, { stemId: s.id, slotId: s.slot, recordingId: s.of, rightsBearing: s.rights_bearing });
  for (const v of order<any>(f.voices)) await reg.registerVoice(tx, c, { voiceId: v.id, factsScopeId: conformance.facts.id, kind: v.kind });
  for (const cl of order<any>(f.claims)) {
    await reg.recordClaim(tx, c, {
      claimId: cl.id, factsScopeId: conformance.facts.id, sourceId: cl.source, edge: cl.edge, targetId: cl.target, shareBps: Number(cl.share),
      status: cl.status, validFrom: cl.valid.from,
      ...(cl.performer_role && { performerRole: cl.performer_role }), ...(cl.role_detail && { roleDetail: cl.role_detail }),
      ...(cl.evidence && { evidenceDigest: cl.evidence }),
    });
  }
  for (const m of order<any>(f.mandates)) {
    await reg.recordMandate(tx, c, {
      mandateId: m.id, factsScopeId: conformance.facts.id, fromPartyId: m.from, toPartyId: m.to, rightKind: m.right,
      shareBps: Number(m.share), status: m.status, validFrom: m.valid.from,
    });
  }
}

const blobRoot = mkdtempSync(join(tmpdir(), "rc-blobs-"));
after(() => rmSync(blobRoot, { recursive: true, force: true }));
const ctx = createBridgeCtx(createFsBlobStore(blobRoot));

test("golden: registry rows for conformance facts/001-basic seal to the conformance digest", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.equal(sealed.digest, digestOf(conformance.facts));
    assert.equal(sealed.docVersion, "1");
    const back = await db.tx((tx) => loadFacts(ctx, tx, sealed.digest));
    assert.deepEqual(back, conformance.facts);
    const again = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.equal(again.digest, sealed.digest);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM sealed_document");
    assert.equal(n.rows[0].n, 1);
  } finally {
    await drop();
  }
});

test("property: registration order does not change the digest", async () => {
  for (const seed of [7, 99, 2026]) {
    const { db, drop } = await freshDb();
    try {
      await db.tx((tx) => registerConformance(tx, seed));
      const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
      assert.equal(sealed.digest, digestOf(conformance.facts), `seed ${seed}`);
    } finally {
      await drop();
    }
  }
});

test("knownAt filters later records and bumps the version; superseded versions keep history", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const later = fixedClock("2026-03-01T00:00:00.000Z", 0);
    await db.tx(async (tx) => {
      const cur = await reg.currentClaim(tx, "c6");
      await reg.recordClaim(tx, later, { ...cur, status: "DISPUTED" });
    });
    const before = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, "2026-02-01T00:00:00.000Z"));
    assert.equal(before.digest, digestOf(conformance.facts));
    const afterDispute = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    assert.notEqual(afterDispute.digest, before.digest);
    assert.equal(afterDispute.docVersion, "2");
    const doc = await db.tx((tx) => loadFacts(ctx, tx, afterDispute.digest));
    const c6 = doc.body.claims.filter((c) => c.id.startsWith("c6"));
    assert.deepEqual(c6.map((c) => [c.id, c.status, c.superseded_at]), [
      ["c6", "VERIFIED", "2026-03-01T00:00:00.000Z"],
      ["c6.v2", "DISPUTED", undefined],
    ]);
  } finally {
    await drop();
  }
});

test("invalid facts are reported as MDRL diagnostics (422)", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const c = fixedClock("2026-03-01T00:00:00.000Z", 0);
    await db.tx(async (tx) => {
      const cur = await reg.currentClaim(tx, "c6");
      await reg.recordClaim(tx, c, { ...cur, shareBps: 5000 });
    });
    await assert.rejects(db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT)), (e: any) => {
      assert.equal(e.code, "FACTS_INVALID");
      assert.equal(e.status, 422);
      assert.ok(e.diagnostics.some((d: any) => d.code === "FACTS_SUM_MISMATCH"));
      return true;
    });
  } finally {
    await drop();
  }
});

test("loadSealed reads storage without the cache and 404s unknown digests", async () => {
  const { db, drop } = await freshDb();
  try {
    await db.tx((tx) => registerConformance(tx));
    const sealed = await db.tx((tx) => sealFacts(ctx, tx, conformance.facts.id, KNOWN_AT));
    const fresh = createBridgeCtx(createFsBlobStore(blobRoot));
    const ok = await db.tx((tx) => loadSealed(fresh, tx, sealed.digest));
    assert.deepEqual(ok, conformance.facts);
    await assert.rejects(db.tx((tx) => loadSealed(fresh, tx, `mdrl:sha256:${"0".repeat(64)}`)), { code: "NOT_FOUND" });
  } finally {
    await drop();
  }
});
```

`rights-core/test/engine-bridge/architecture.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("only src/engine-bridge imports mdrl (design 9.2)", () => {
  const offenders = walk(SRC)
    .filter((p) => !relative(SRC, p).startsWith("engine-bridge/"))
    .filter((p) => /from\s+["']mdrl(\/[a-z]+)?["']/.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p));
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && npm run build --prefix ../mdrl >/dev/null && node --test test/engine-bridge/`
Expected: facts.test.ts FAIL(모듈 없음), architecture.test.ts PASS.

- [ ] **Step 3: 마이그레이션 작성**

`rights-core/migrations/0003_seal.sql`:
```sql
-- 봉인 저장소(v2.8 3.11 sealed_document): 내용 주소, 불변. 원문 JCS 바이트는 blob, 64KiB 이하는 JSONB 사본도 둔다.
CREATE TABLE sealed_document (
  digest      TEXT PRIMARY KEY CHECK (digest ~ '^mdrl:sha256:[0-9a-f]{64}$'),
  kind        TEXT NOT NULL CHECK (kind IN ('facts','allocation','projection','members','events','allocation_result','public_facts','manifest')),
  doc_id      TEXT NULL,
  doc_version TEXT NULL,
  format      TEXT NULL,
  byte_size   BIGINT NOT NULL,
  storage_uri TEXT NOT NULL,
  content     JSONB NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sealed_document_doc ON sealed_document (kind, doc_id, doc_version);
CREATE TRIGGER sealed_document_immutable BEFORE UPDATE OR DELETE ON sealed_document FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON sealed_document TO rc_app;
```

- [ ] **Step 4: engine-bridge 구현**

`rights-core/src/engine-bridge/context.ts`:
```ts
export type BlobStore = { put(digest: string, bytes: Uint8Array): Promise<string>; get(uri: string): Promise<Uint8Array> };

/** 봉인 문서는 불변이므로 digest 기준 프로세스 내 캐시가 항상 유효하다. */
export type BridgeCtx = { blobs: BlobStore; cache: Map<string, unknown> };

export function createBridgeCtx(blobs: BlobStore): BridgeCtx {
  return { blobs, cache: new Map() };
}
```

`rights-core/src/engine-bridge/blob-fs.ts`:
```ts
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BlobStore } from "./context.ts";

/** 개발용 파일시스템 blob 저장소. 경로는 digest hex 앞 4자리로 두 단계 샤딩한다. 쓰기는 임시 파일 후 rename(원자적). */
export function createFsBlobStore(root: string): BlobStore {
  return {
    async put(digest, bytes) {
      const hex = digest.slice("mdrl:sha256:".length);
      const dir = join(root, hex.slice(0, 2), hex.slice(2, 4));
      const path = join(dir, `${hex}.json`);
      const uri = `file://${path}`;
      try {
        await stat(path);
        return uri;
      } catch {
        await mkdir(dir, { recursive: true });
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, path);
        return uri;
      }
    },
    async get(uri) {
      return readFile(uri.slice("file://".length));
    },
  };
}
```

`rights-core/src/engine-bridge/seal-store.ts`:
```ts
import { canonicalize, digestOf } from "mdrl/core";
import type { Tx } from "../platform/db.ts";
import { DomainError, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";

export type SealKind = "facts" | "allocation" | "projection" | "members";
export type Sealed = { digest: string; kind: SealKind; docId?: string; docVersion?: string; format?: string };

const INLINE_LIMIT = 64 * 1024;

/** 값을 JCS로 정규화해 blob에 쓰고 sealed_document에 기록한다. 같은 digest는 한 번만 저장된다(멱등). */
export async function sealDocument(
  ctx: BridgeCtx, tx: Tx, input: { kind: SealKind; value: unknown; docId?: string; docVersion?: string; format?: string },
): Promise<Sealed> {
  const text = canonicalize(input.value);
  const digest = digestOf(input.value);
  const bytes = new TextEncoder().encode(text);
  const uri = await ctx.blobs.put(digest, bytes);
  await tx.query(
    `INSERT INTO sealed_document (digest, kind, doc_id, doc_version, format, byte_size, storage_uri, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (digest) DO NOTHING`,
    [digest, input.kind, input.docId ?? null, input.docVersion ?? null, input.format ?? null, bytes.length, uri,
      bytes.length <= INLINE_LIMIT ? text : null],
  );
  ctx.cache.set(digest, input.value);
  return { digest, kind: input.kind, ...(input.docId && { docId: input.docId }), ...(input.docVersion && { docVersion: input.docVersion }), ...(input.format && { format: input.format }) };
}

/** 봉인 문서를 읽는다. 캐시에 없으면 JSONB 사본 또는 blob에서 읽고 digest를 다시 계산해 대조한다. */
export async function loadSealed(ctx: BridgeCtx, tx: Tx, digest: string): Promise<unknown> {
  if (ctx.cache.has(digest)) return ctx.cache.get(digest);
  const row = (await tx.query("SELECT content, storage_uri FROM sealed_document WHERE digest = $1", [digest])).rows[0];
  if (row === undefined) throw notFound("sealed document", digest);
  const value: unknown = row.content ?? JSON.parse(new TextDecoder().decode(await ctx.blobs.get(row.storage_uri)));
  if (digestOf(value) !== digest) throw new DomainError("SEAL_CORRUPT", 500, `sealed document ${digest} does not match its digest`);
  ctx.cache.set(digest, value);
  return value;
}
```

`rights-core/src/engine-bridge/convert-facts.ts`:
```ts
import type { FactsDocument } from "mdrl/facts";

export type PartyRow = { partyId: string; partyType: string; isni?: string; ipiNo?: string; createdAt: string };
export type WorkRow = { workId: string; iswc?: string; createdAt: string };
export type RecordingRow = { recordingId: string; workId: string; isrc?: string; createdAt: string };
export type StemRow = { stemId: string; recordingId: string; slotId: string; rightsBearing: boolean; createdAt: string };
export type VoiceRow = { voiceId: string; kind: "HUMAN" | "AI"; createdAt: string };
type Recorded = { version: number; status: string; validFrom: string; validTo?: string; recordedAt: string; supersededAt?: string; visibility?: string };
export type ClaimRow = Recorded & {
  claimId: string; sourceId: string; edge: string; targetId: string; shareBps: number;
  performerRole?: string; roleDetail?: string; evidenceDigest?: string;
};
export type MandateRow = Recorded & { mandateId: string; fromPartyId: string; toPartyId: string; rightKind: string; shareBps: number };
export type FactsRows = {
  scopeId: string; work: WorkRow; recordings: RecordingRow[]; stems: StemRow[]; voices: VoiceRow[];
  parties: PartyRow[]; claims: ClaimRow[]; mandates: MandateRow[];
};

/** party_type → MDRL party_kind (통합 설계 9.3-3). FAN·PLATFORM은 facts에 들어갈 수 없다(undefined). */
export const PARTY_KIND: Record<string, string | undefined> = {
  LABEL: "LABEL", AGENCY: "AGENCY", PUBLISHER: "PUBLISHER", CMO: "CMO", AUTHOR: "AUTHOR", SESSION: "SESSION",
  AI_PROVIDER: "AI_PROVIDER", ARTIST: "PERFORMER", MEMBER: "PERFORMER",
};

const byId = <T>(key: (t: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const ids = (entries: [string, string | undefined][]) => {
  const o = Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined));
  return Object.keys(o).length > 0 ? { ids: o } : {};
};
/** IR record id: 버전 1은 원래 id, 이후 버전은 `<id>.v<n>`(같은 문서 안에서 id가 겹치지 않게). */
const recordId = (id: string, version: number) => (version === 1 ? id : `${id}.v${version}`);
/** 기준 시점 이후에 설정된 superseded_at은 그 시점의 지식이 아니므로 비운다. */
const supersededAt = (r: Recorded, knownAt: string) => (r.supersededAt !== undefined && r.supersededAt <= knownAt ? { superseded_at: r.supersededAt } : {});

/**
 * facts IR version(통합 설계 9.3-1): 기준 시점까지 범위 안에서 기록 변화가 일어난 서로 다른 시각의 개수.
 * 엔티티 생성, claim·mandate 기록, 기준 시점 이하의 대체 시각을 모두 센다.
 */
export function factsVersion(rows: FactsRows, knownAt: string): number {
  const instants = new Set<string>();
  const add = (t: string | undefined) => {
    if (t !== undefined && t <= knownAt) instants.add(t);
  };
  add(rows.work.createdAt);
  for (const r of rows.recordings) add(r.createdAt);
  for (const s of rows.stems) add(s.createdAt);
  for (const v of rows.voices) add(v.createdAt);
  for (const p of rows.parties) add(p.createdAt);
  for (const r of [...rows.claims, ...rows.mandates]) {
    add(r.recordedAt);
    add(r.supersededAt);
  }
  return Math.max(1, instants.size);
}

/** 행 → facts IR(순수 함수). 입력 행은 이미 knownAt 이전에 기록된 것만 담고 있어야 한다(loadFactsRows). */
export function buildFactsDocument(rows: FactsRows, knownAt: string): FactsDocument {
  const valid = (r: Recorded) => ({ from: r.validFrom, ...(r.validTo !== undefined && { to: r.validTo }) });
  return {
    mdrl: "1.0",
    module: "facts",
    id: rows.scopeId,
    version: String(factsVersion(rows, knownAt)),
    depends_on: [],
    visibility_default: "PARTIES",
    body: {
      parties: [...rows.parties].sort(byId((p) => p.partyId)).map((p) => ({
        id: p.partyId, kind: PARTY_KIND[p.partyType] as never, ...ids([["ipi", p.ipiNo], ["isni", p.isni]]),
      })),
      works: [{ id: rows.work.workId, ...ids([["iswc", rows.work.iswc]]) }],
      recordings: [...rows.recordings].sort(byId((r) => r.recordingId)).map((r) => ({ id: r.recordingId, of: r.workId, ...ids([["isrc", r.isrc]]) })),
      voices: [...rows.voices].sort(byId((v) => v.voiceId)).map((v) => ({ id: v.voiceId, kind: v.kind })),
      stems: [...rows.stems].sort(byId((s) => s.stemId)).map((s) => ({ id: s.stemId, of: s.recordingId, slot: s.slotId, rights_bearing: s.rightsBearing })),
      claims: rows.claims.map((c) => ({
        id: recordId(c.claimId, c.version), source: c.sourceId, edge: c.edge as never, target: c.targetId, share: String(c.shareBps),
        ...(c.performerRole !== undefined && { performer_role: c.performerRole as never }),
        ...(c.roleDetail !== undefined && { role_detail: c.roleDetail }),
        status: c.status as never, valid: valid(c), recorded_at: c.recordedAt, ...supersededAt(c, knownAt),
        ...(c.evidenceDigest !== undefined && { evidence: c.evidenceDigest }),
        ...(c.visibility !== undefined && { visibility: c.visibility as never }),
      })).sort(byId((c) => c.id)),
      mandates: rows.mandates.map((m) => ({
        id: recordId(m.mandateId, m.version), from: m.fromPartyId, to: m.toPartyId, right: m.rightKind as never, share: String(m.shareBps),
        status: m.status as never, valid: valid(m), recorded_at: m.recordedAt, ...supersededAt(m, knownAt),
        ...(m.visibility !== undefined && { visibility: m.visibility as never }),
      })).sort(byId((m) => m.id)),
    },
  };
}
```

`rights-core/src/engine-bridge/facts.ts`:
```ts
import { validateFacts, type FactsDocument } from "mdrl/facts";
import { iso, type Tx } from "../platform/db.ts";
import { invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { buildFactsDocument, type FactsRows } from "./convert-facts.ts";
import { loadSealed, sealDocument, type Sealed } from "./seal-store.ts";

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/** 범위의 행 중 knownAt까지 기록된 것만 읽는다(통합 설계 9.3-5). 정렬은 변환기가 한다. */
export async function loadFactsRows(tx: Tx, scopeId: string, knownAt: string): Promise<FactsRows> {
  const scope = (await tx.query(
    "SELECT s.facts_scope_id, w.work_id, w.iswc, w.created_at FROM facts_scope s JOIN work w ON w.work_id = s.work_id WHERE s.facts_scope_id = $1",
    [scopeId],
  )).rows[0];
  if (scope === undefined) throw notFound("facts scope", scopeId);
  const recordings = (await tx.query(
    "SELECT recording_id, work_id, isrc, created_at FROM recording_version WHERE work_id = $1 AND created_at <= $2", [scope.work_id, knownAt],
  )).rows;
  const stems = (await tx.query(
    "SELECT stem_id, recording_id, slot_id, rights_bearing, created_at FROM stem WHERE recording_id = ANY($1) AND created_at <= $2",
    [recordings.map((r) => r.recording_id), knownAt],
  )).rows;
  const voices = (await tx.query("SELECT voice_id, kind, created_at FROM voice WHERE facts_scope_id = $1 AND created_at <= $2", [scopeId, knownAt])).rows;
  const claims = (await tx.query("SELECT * FROM right_claim WHERE facts_scope_id = $1 AND recorded_at <= $2", [scopeId, knownAt])).rows;
  const mandates = (await tx.query("SELECT * FROM mandate WHERE facts_scope_id = $1 AND recorded_at <= $2", [scopeId, knownAt])).rows;
  const partyIds = new Set<string>([
    ...claims.filter((c) => c.edge !== "PERFORMED_BY").map((c) => c.target_id as string),
    ...mandates.flatMap((m) => [m.from_party_id as string, m.to_party_id as string]),
  ]);
  const parties = (await tx.query(
    "SELECT party_id, party_type, isni, ipi_no, created_at FROM party WHERE party_id = ANY($1) AND created_at <= $2", [[...partyIds], knownAt],
  )).rows;
  const recorded = (r: any) => ({
    version: r.version, status: r.status, validFrom: iso(r.valid_from)!, validTo: iso(r.valid_to), recordedAt: iso(r.recorded_at)!,
    supersededAt: iso(r.superseded_at), visibility: opt(r.visibility),
  });
  return {
    scopeId,
    work: { workId: scope.work_id, iswc: opt(scope.iswc), createdAt: iso(scope.created_at)! },
    recordings: recordings.map((r) => ({ recordingId: r.recording_id, workId: r.work_id, isrc: opt(r.isrc), createdAt: iso(r.created_at)! })),
    stems: stems.map((s) => ({ stemId: s.stem_id, recordingId: s.recording_id, slotId: s.slot_id, rightsBearing: s.rights_bearing, createdAt: iso(s.created_at)! })),
    voices: voices.map((v) => ({ voiceId: v.voice_id, kind: v.kind, createdAt: iso(v.created_at)! })),
    parties: parties.map((p) => ({ partyId: p.party_id, partyType: p.party_type, isni: opt(p.isni), ipiNo: opt(p.ipi_no), createdAt: iso(p.created_at)! })),
    claims: claims.map((c) => ({
      ...recorded(c), claimId: c.claim_id, sourceId: c.source_id, edge: c.edge, targetId: c.target_id, shareBps: c.share_bps,
      performerRole: opt(c.performer_role), roleDetail: opt(c.role_detail), evidenceDigest: opt(c.evidence_digest),
    })),
    mandates: mandates.map((m) => ({
      ...recorded(m), mandateId: m.mandate_id, fromPartyId: m.from_party_id, toPartyId: m.to_party_id, rightKind: m.right_kind, shareBps: m.share_bps,
    })),
  };
}

/** S1: 범위의 facts를 knownAt 기준으로 만들고, MDRL로 검증한 뒤 봉인한다. 같은 행·같은 knownAt이면 같은 digest다. */
export async function sealFacts(ctx: BridgeCtx, tx: Tx, scopeId: string, knownAt: string): Promise<Sealed & { knownAt: string }> {
  const doc = buildFactsDocument(await loadFactsRows(tx, scopeId, knownAt), knownAt);
  const errors = validateFacts(doc);
  if (errors.length > 0) throw invalid("FACTS_INVALID", `facts ${scopeId} failed MDRL validation`, errors);
  const sealed = await sealDocument(ctx, tx, { kind: "facts", value: doc, docId: doc.id, docVersion: doc.version });
  await tx.query("UPDATE facts_scope SET last_version = GREATEST(last_version, $2) WHERE facts_scope_id = $1", [scopeId, Number(doc.version)]);
  return { ...sealed, knownAt };
}

export async function loadFacts(ctx: BridgeCtx, tx: Tx, digest: string): Promise<FactsDocument> {
  return (await loadSealed(ctx, tx, digest)) as FactsDocument;
}
```

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/engine-bridge/ && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: facts 5 PASS, architecture 1 PASS, `TSC_OK`.
골든 테스트가 digest 불일치로 실패하면, 두 IR을 `assert.deepEqual(back, conformance.facts)` 형태로 비교해 차이 필드를 찾고 **변환기(convert-facts.ts)나 행 적재(facts.ts)를 고친다**. 적합성 파일은 절대 바꾸지 않는다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0003_seal.sql rights-core/src/engine-bridge/context.ts rights-core/src/engine-bridge/blob-fs.ts \
  rights-core/src/engine-bridge/seal-store.ts rights-core/src/engine-bridge/convert-facts.ts rights-core/src/engine-bridge/facts.ts \
  rights-core/test/engine-bridge/facts.test.ts rights-core/test/engine-bridge/architecture.test.ts
git commit -m "feat(rights-core): 봉인 저장소와 행→facts IR 결정적 변환(적합성 digest 일치)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 신원·서명·팩·정책 레지스트리(컴파일·승인·활성화)

**Files:**
- Create: `rights-core/migrations/0004_policy.sql`, `rights-core/src/platform/{actor,audit}.ts`, `rights-core/src/engine-bridge/{policy,attest,activation}.ts`, `rights-core/src/policy/service.ts`, `rights-core/src/issuance/service.ts`(팩 생성·청구권자 설정만; 발행은 Task 5)
- Test: `rights-core/test/policy/policy.test.ts`, 공용 픽스처 `rights-core/test/fixtures.ts`

**Interfaces:**
- Consumes: Task 1~3 전부. `sealFacts`, `loadFacts`, `sealDocument`, `loadSealed`.
- Produces:
```ts
// platform/actor.ts
export type Role = "RIGHTS_EDITOR"|"EDITOR"|"WORK_APPROVER"|"ACTIVATOR"|"ISSUER";
export type Actor = { userId: string; roles: ReadonlySet<Role> };
export async function createUser(tx, clock, u: { userId: string; displayName: string; roles: Role[] }): Promise<void>; // 개발용 Ed25519 키도 생성
export async function loadActor(tx, userId: string): Promise<Actor>;   // 없으면 DomainError UNKNOWN_ACTOR 401
export function requireRole(actor: Actor, role: Role): void;           // 없으면 403 ROLE_REQUIRED
// platform/audit.ts
export async function audit(tx, clock, e: { actor: string; action: string; entityType: string; entityId: string; after?: unknown }): Promise<void>;
// engine-bridge/attest.ts
export type AttestRole = "EDITOR"|"WORK_APPROVER"|"ACTIVATOR";
export async function attest(ctx, tx, clock, a: { userId: string; role: AttestRole; digest: string }): Promise<void>;
export async function signersOf(tx, digest: string): Promise<{ signerId: string; role: string }[]>;
export async function verifyAttestations(tx, digest: string): Promise<boolean>;
// engine-bridge/policy.ts
export async function compilePolicyText(ctx, tx, input: { sourceText: string; policyId: string; version: number; packId: string; facts: Sealed & { knownAt: string } }): Promise<{ sealed: Sealed; canonicalText: string; factsScopeId: string }>;
export async function repinPolicy(ctx, tx, input: { policyDigest: string; version: number; facts: Sealed }): Promise<{ sealed: Sealed; canonicalText: string }>;
// engine-bridge/activation.ts
export type Declared = { role: string; party: string };
export async function checkPackActivation(ctx, tx, input: { factsDigest: string; declared: Declared[]; at: string }): Promise<Diagnostic[]>;
// issuance/service.ts (이 태스크 분량)
export async function createPack(tx, clock, actor, p: { packId: string; packCode: string; title: string; factsScopeId: string }): Promise<void>;  // RIGHTS_EDITOR
export async function setPackClaimants(tx, actor, packId: string, entries: Declared[]): Promise<void>;                                        // RIGHTS_EDITOR, DRAFT·PAUSED만
export async function declaredClaimants(tx, packId: string): Promise<Declared[]>;
// policy/service.ts
export type PolicyVersionRef = { policyId: string; version: number };
export async function compilePolicy(ctx, tx, clock, actor, input: { policyId: string; packId: string; sourceText: string }):
  Promise<PolicyVersionRef & { policyDigest: string; factsDigest: string; canonicalText: string }>;               // EDITOR
export async function approvePolicy(ctx, tx, clock, actor, ref: PolicyVersionRef): Promise<void>;                   // WORK_APPROVER
export async function activatePolicy(ctx, tx, clock, actor, ref: PolicyVersionRef): Promise<void>;                  // ACTIVATOR
export async function activePolicyForPack(tx, packId: string): Promise<{ policyId: string; version: number; policyDigest: string; factsDigest: string; factsKnownAt: string } | undefined>;
```

- [ ] **Step 1: 공용 픽스처와 실패하는 테스트 작성**

`rights-core/test/fixtures.ts`(이후 태스크가 재사용한다):
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/platform/clock.ts";
import type { Tx } from "../src/platform/db.ts";
import { createUser, loadActor, type Actor } from "../src/platform/actor.ts";
import * as reg from "../src/registry/service.ts";
import { createBridgeCtx, type BridgeCtx } from "../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../src/engine-bridge/blob-fs.ts";

export const T0 = "2026-01-01T00:00:00.000Z";
export const SCOPE = "fsc_nova";
export const PACK = "pak_nova";

export function tempBridge(): { ctx: BridgeCtx; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "rc-blobs-"));
  return { ctx: createBridgeCtx(createFsBlobStore(root)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 사용자 5명: 권리 편집, 정책 편집, 승인, 활성화, 발행. */
export async function seedUsers(tx: Tx, clock: Clock): Promise<Record<"rights" | "editor" | "approver" | "activator" | "issuer", Actor>> {
  const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"]] as const;
  const out: Record<string, Actor> = {};
  for (const [name, role] of spec) {
    await createUser(tx, clock, { userId: `usr_${name}`, displayName: name, roles: [role] });
    out[name] = await loadActor(tx, `usr_${name}`);
  }
  return out as never;
}

/**
 * 작은 곡: 멤버 2명(a·b)이 각자 슬롯 1개를 부르고, MR 1개(정산 대상 아님).
 * 작사·작곡 60/40, 작가 b는 CMO에 위임, 멤버 a는 기획사에 위임, 레이블 마스터 100%.
 */
export async function seedSong(tx: Tx, clock: Clock): Promise<void> {
  const P: [string, reg.PartyType][] = [
    ["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"],
    ["pty_cmo", "CMO"], ["pty_member_a", "MEMBER"], ["pty_member_b", "MEMBER"],
  ];
  for (const [id, t] of P) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: id });
  await reg.registerWork(tx, clock, { workId: "wrk_nova", title: "Nova" });
  await reg.createScope(tx, clock, { factsScopeId: SCOPE, workId: "wrk_nova" });
  await reg.registerRecording(tx, clock, { recordingId: "rcd_nova", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  await reg.registerSlot(tx, { slotId: "slt_1", recordingId: "rcd_nova", startMs: 0, endMs: 30000, sortOrder: 1 });
  await reg.registerSlot(tx, { slotId: "slt_2", recordingId: "rcd_nova", startMs: 30000, endMs: 90000, sortOrder: 2 });
  await reg.registerSlot(tx, { slotId: "slt_mr", recordingId: "rcd_nova", startMs: 0, endMs: 90000, sortOrder: 3 });
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await reg.registerStem(tx, clock, { stemId: `stm_${m}${s}`, slotId: `slt_${s}`, recordingId: "rcd_nova", performerPartyId: `pty_member_${m}`, rightsBearing: true });
  }
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: "rcd_nova", rightsBearing: false });
  for (const m of ["a", "b"]) await reg.registerVoice(tx, clock, { voiceId: `vo_${m}`, factsScopeId: SCOPE, kind: "HUMAN" });
  const base = { factsScopeId: SCOPE, status: "VERIFIED" as const, validFrom: T0 };
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${m}${s}`, sourceId: `stm_${m}${s}`, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" });
  }
  for (const m of ["a", "b"]) {
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_music", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 });
}

/** seedSong의 청구권자 선언(적합성 001-basic과 같은 구조). */
export const DECLARED = [
  { role: "AGENCY", party: "pty_agency" }, { role: "CMO", party: "pty_cmo" }, { role: "MASTER_OWNER", party: "pty_label" },
  { role: "PERFORMER_FEATURED", party: "pty_member_a" }, { role: "PERFORMER_FEATURED", party: "pty_member_b" },
  { role: "WORK_AUTHOR", party: "pty_author_b" }, { role: "WORK_AUTHOR", party: "pty_author_c" },
];

/** seedSong용 정책. uses 줄의 digest는 자리표시이며 컴파일 시 현재 facts 봉인으로 덮어쓴다. */
export const POLICY_TEXT = `allocation "pol_nova" version 1 {
  uses facts "fsc_nova"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: pak_nova; events: [PRIMARY]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) : 40%;
      work = graph(WORK_AUTHOR) via mandate : 10%;
      agency = contract(pty_agency) : 10% as AGENCY;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
`;

export async function actorOf(tx: Tx, userId: string): Promise<Actor> {
  return loadActor(tx, userId);
}
```

`rights-core/test/policy/policy.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { signersOf, verifyAttestations } from "../../src/engine-bridge/attest.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });

const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova pack", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, u.rights, PACK, DECLARED);
  return u;
});

test("compile pins depends_on to the current facts seal and stores canonical text", async () => {
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  assert.equal(r.version, 1);
  assert.match(r.canonicalText, new RegExp(`digest "${r.factsDigest}"`));
  assert.doesNotMatch(r.canonicalText, /0{64}/);
  const s = await db.tx((tx) => signersOf(tx, r.policyDigest));
  assert.deepEqual(s, [{ signerId: "usr_editor", role: "EDITOR" }]);
  assert.equal(await db.tx((tx) => verifyAttestations(tx, r.policyDigest)), true);
});

test("roles and separation of duties are enforced", async () => {
  const ref = { policyId: "pol_nova", version: 1 };
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.editor, ref)), { code: "ROLE_REQUIRED" });
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, ref)), { code: "INVALID_STATE" });
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, ref));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, ref));
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, PACK));
  assert.equal(active?.version, 1);
  const s = await db.tx((tx) => signersOf(tx, active!.policyDigest));
  assert.deepEqual(s.map((x) => x.role).sort(), ["ACTIVATOR", "EDITOR", "WORK_APPROVER"]);
});

test("the same person cannot sign two roles on one policy", async () => {
  const both = await db.tx(async (tx) => {
    const { createUser, loadActor } = await import("../../src/platform/actor.ts");
    await createUser(tx, clock, { userId: "usr_both", displayName: "both", roles: ["EDITOR", "WORK_APPROVER"] });
    return loadActor(tx, "usr_both");
  });
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, both, { policyId: "pol_sod", packId: PACK, sourceText: POLICY_TEXT }));
  await assert.rejects(db.tx((tx) => policy.approvePolicy(ctx, tx, clock, both, r)), { code: "SOD_VIOLATION", status: 403 });
});

test("compile rejects a policy whose scope.pack differs from the target pack, with MDRL diagnostics for bad text", async () => {
  await assert.rejects(
    db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_x", packId: PACK, sourceText: POLICY_TEXT.replace("pack: pak_nova", "pack: pak_other") })),
    { code: "POLICY_PACK_MISMATCH", status: 422 },
  );
  await assert.rejects(
    db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_x", packId: PACK, sourceText: "allocation {" })),
    (e: any) => e.status === 422 && e.diagnostics.some((d: any) => d.code === "PARSE_SYNTAX"),
  );
});

test("activation fails with MDRL diagnostics when declared claimants drift", async () => {
  await db.tx(async (tx) => {
    await issuance.createPack(tx, clock, users.rights, { packId: "pak_drift", packCode: "DRIFT", title: "d", factsScopeId: SCOPE });
    await issuance.setPackClaimants(tx, users.rights, "pak_drift", DECLARED.filter((d) => d.role !== "CMO"));
  });
  const text = POLICY_TEXT.replace("pack: pak_nova", "pack: pak_drift");
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_drift", packId: "pak_drift", sourceText: text }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await assert.rejects(db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r)), (e: any) =>
    e.status === 422 && e.diagnostics.some((d: any) => d.code === "FACTS_CLAIMANT_DRIFT"));
});

test("activating a newer version supersedes the previous active version", async () => {
  const r2 = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  assert.equal(r2.version, 2);
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r2));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r2));
  const rows = await db.pool.query("SELECT version, status FROM policy_version WHERE policy_id = 'pol_nova' ORDER BY version");
  assert.deepEqual(rows.rows.map((r) => [r.version, r.status]), [[1, "SUPERSEDED"], [2, "ACTIVE"]]);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/policy/policy.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 마이그레이션 작성**

`rights-core/migrations/0004_policy.sql`:
```sql
-- 신원(v2.8 user_account·portal_role의 I-1 부분 집합). 역할은 PoC 서명·권한 역할.
CREATE TABLE user_account (
  user_id      mdrl_id PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE TABLE portal_role (
  user_id mdrl_id NOT NULL REFERENCES user_account,
  role    TEXT NOT NULL CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER')),
  PRIMARY KEY (user_id, role)
);

-- 개발용 서명키(PoC 전용, 운영은 KMS/HSM — 통합 설계 6.4). 개인키를 DB에 두는 것은 이 테이블뿐이다.
CREATE TABLE dev_signing_key (
  user_id     mdrl_id PRIMARY KEY REFERENCES user_account,
  key_version TEXT NOT NULL,
  public_pem  TEXT NOT NULL,
  private_pem TEXT NOT NULL
);

CREATE TABLE attestation (
  digest      TEXT NOT NULL REFERENCES sealed_document,
  signer_id   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('EDITOR','APPROVER','WORK_APPROVER','ACTIVATOR','SPACE_OPS','SPACE_SETTLE','PLATFORM')),
  key_version TEXT NOT NULL,
  alg         TEXT NOT NULL DEFAULT 'Ed25519',
  signature   TEXT NOT NULL,
  signed_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (digest, signer_id, role)
);

-- 팩(v2.8 vocal_pack의 I-1 부분 집합). facts_scope_id는 base_image를 대신하는 PoC 연결 컬럼.
CREATE TABLE vocal_pack (
  pack_id        mdrl_id PRIMARY KEY,
  pack_code      VARCHAR(32) NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  facts_scope_id mdrl_id NOT NULL REFERENCES facts_scope,
  status         TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED')),
  created_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX vocal_pack_scope ON vocal_pack (facts_scope_id);

-- 선언 청구권자(v2.8 claimant는 grant 단위다. I-1은 grant가 없으므로 팩 단위 대용 테이블).
CREATE TABLE pack_claimant (
  pack_id       mdrl_id NOT NULL REFERENCES vocal_pack,
  party_id      mdrl_id NOT NULL REFERENCES party,
  claimant_role TEXT NOT NULL CHECK (claimant_role IN ('MASTER_OWNER','WORK_AUTHOR','CMO','PERFORMER_FEATURED','PERFORMER_NON_FEATURED','AGENCY','AI_PROVIDER','RECORDING_CONTRIBUTOR')),
  PRIMARY KEY (pack_id, party_id, claimant_role)
);

CREATE TABLE policy_version (
  policy_id         mdrl_id NOT NULL,
  version           INT NOT NULL CHECK (version >= 1),
  source_text       TEXT NOT NULL,
  policy_digest     TEXT NOT NULL REFERENCES sealed_document,
  facts_digest      TEXT NOT NULL REFERENCES sealed_document,
  facts_known_at    TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('DRAFT','COMPILED','APPROVED','ACTIVE','SUPERSEDED','TERMINATED')),
  rebind_of_version INT NULL,
  pack_id           mdrl_id NOT NULL REFERENCES vocal_pack,
  created_by        mdrl_id NOT NULL REFERENCES user_account,
  created_at        TIMESTAMPTZ NOT NULL,
  activated_at      TIMESTAMPTZ NULL,
  PRIMARY KEY (policy_id, version)
);
CREATE UNIQUE INDEX policy_one_active ON policy_version (policy_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX policy_one_active_per_pack ON policy_version (pack_id) WHERE status = 'ACTIVE';

CREATE TRIGGER attestation_immutable BEFORE UPDATE OR DELETE ON attestation FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON user_account, portal_role, dev_signing_key, attestation, vocal_pack, pack_claimant, policy_version TO rc_app;
GRANT DELETE ON pack_claimant TO rc_app;
GRANT UPDATE (status) ON vocal_pack TO rc_app;
GRANT UPDATE (status, activated_at) ON policy_version TO rc_app;
```

- [ ] **Step 4: 구현**

`rights-core/src/platform/actor.ts`:
```ts
import { generateKeyPairSync } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";
import { DomainError } from "./errors.ts";

export type Role = "RIGHTS_EDITOR" | "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "ISSUER";
export type Actor = { userId: string; roles: ReadonlySet<Role> };

/** 사용자와 역할을 만들고 개발용 Ed25519 키를 발급한다(운영은 KMS — 통합 설계 6.4). */
export async function createUser(tx: Tx, clock: Clock, u: { userId: string; displayName: string; roles: Role[] }): Promise<void> {
  await tx.query("INSERT INTO user_account (user_id, display_name, created_at) VALUES ($1,$2,$3)", [u.userId, u.displayName, clock.now()]);
  for (const r of u.roles) await tx.query("INSERT INTO portal_role (user_id, role) VALUES ($1,$2)", [u.userId, r]);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await tx.query("INSERT INTO dev_signing_key (user_id, key_version, public_pem, private_pem) VALUES ($1,'dev-1',$2,$3)", [
    u.userId, publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ]);
}

export async function loadActor(tx: Tx, userId: string): Promise<Actor> {
  const u = await tx.query("SELECT 1 FROM user_account WHERE user_id = $1", [userId]);
  if (u.rowCount === 0) throw new DomainError("UNKNOWN_ACTOR", 401, `unknown actor: ${userId}`);
  const roles = (await tx.query("SELECT role FROM portal_role WHERE user_id = $1", [userId])).rows.map((r) => r.role as Role);
  return { userId, roles: new Set(roles) };
}

export function requireRole(actor: Actor, role: Role): void {
  if (!actor.roles.has(role)) throw new DomainError("ROLE_REQUIRED", 403, `${actor.userId} lacks role ${role}`);
}
```

`rights-core/src/platform/audit.ts`:
```ts
import type { Clock } from "./clock.ts";
import type { Tx } from "./db.ts";

/** 모든 봉인·서명·상태 전이는 감사 로그에 남긴다(통합 설계 6.6). */
export async function audit(tx: Tx, clock: Clock, e: { actor: string; action: string; entityType: string; entityId: string; after?: unknown }): Promise<void> {
  await tx.query(
    "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id, after_json) VALUES ($1,$2,$3,$4,$5,$6)",
    [clock.now(), e.actor, e.action, e.entityType, e.entityId, e.after === undefined ? null : JSON.stringify(e.after)],
  );
}
```

`rights-core/src/engine-bridge/attest.ts`:
```ts
import { signAttestation, verifyAttestation, type Attestation } from "mdrl/core";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";

export type AttestRole = "EDITOR" | "WORK_APPROVER" | "ACTIVATOR";

/** digest에 대한 역할 서명(mdrl-attest/1)을 남긴다. 개발용 키를 쓴다. */
export async function attest(_ctx: BridgeCtx, tx: Tx, clock: Clock, a: { userId: string; role: AttestRole; digest: string }): Promise<void> {
  const key = (await tx.query("SELECT key_version, private_pem FROM dev_signing_key WHERE user_id = $1", [a.userId])).rows[0];
  if (key === undefined) throw new DomainError("NO_SIGNING_KEY", 500, `no signing key for ${a.userId}`);
  const att = signAttestation({ signer: a.userId, role: a.role, over: a.digest, privateKeyPem: key.private_pem });
  await tx.query(
    "INSERT INTO attestation (digest, signer_id, role, key_version, alg, signature, signed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [a.digest, a.userId, a.role, key.key_version, att.alg, att.sig, clock.now()],
  );
}

export async function signersOf(tx: Tx, digest: string): Promise<{ signerId: string; role: string }[]> {
  const r = await tx.query("SELECT signer_id, role FROM attestation WHERE digest = $1 ORDER BY signed_at, role", [digest]);
  return r.rows.map((x) => ({ signerId: x.signer_id, role: x.role }));
}

/** digest의 모든 서명을 공개키로 검증한다. */
export async function verifyAttestations(tx: Tx, digest: string): Promise<boolean> {
  const r = await tx.query(
    "SELECT a.signer_id, a.role, a.alg, a.signature, k.public_pem FROM attestation a JOIN dev_signing_key k ON k.user_id = a.signer_id WHERE a.digest = $1",
    [digest],
  );
  return r.rows.every((x) => {
    const att: Attestation = { signer: x.signer_id, role: x.role, over: digest, alg: x.alg, sig: x.signature };
    return verifyAttestation(att, x.public_pem);
  });
}
```

`rights-core/src/engine-bridge/policy.ts`:
```ts
import { validateAllocation, type AllocationDocument } from "mdrl/allocation";
import { formatAllocation, parseAllocation } from "mdrl/text";
import type { Tx } from "../platform/db.ts";
import { invalid } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed, sealDocument, type Sealed } from "./seal-store.ts";

/** 정책 IR의 id·version·depends_on을 우리 레지스트리 값으로 고정하고 검증·봉인한다(통합 설계 9.3-2). */
async function pinAndSeal(ctx: BridgeCtx, tx: Tx, ir: AllocationDocument, policyId: string, version: number, facts: Sealed) {
  const pinned: AllocationDocument = {
    ...ir,
    id: policyId,
    version: String(version),
    depends_on: [{ ref: `vc:facts/${facts.docId}@${facts.docVersion}`, digest: facts.digest }],
  };
  const errors = validateAllocation(pinned);
  if (errors.length > 0) throw invalid("POLICY_INVALID", `policy ${policyId} failed MDRL validation`, errors);
  const sealed = await sealDocument(ctx, tx, { kind: "allocation", value: pinned, docId: policyId, docVersion: String(version) });
  return { sealed, canonicalText: formatAllocation(pinned), ir: pinned };
}

export async function compilePolicyText(
  ctx: BridgeCtx, tx: Tx, input: { sourceText: string; policyId: string; version: number; packId: string; facts: Sealed },
): Promise<{ sealed: Sealed; canonicalText: string }> {
  const parsed = parseAllocation(input.sourceText);
  if (!parsed.ok) throw invalid("POLICY_INVALID", "policy text failed to parse", parsed.errors);
  if (parsed.value.body.scope.pack !== input.packId) {
    throw invalid("POLICY_PACK_MISMATCH", `policy scope.pack ${parsed.value.body.scope.pack} is not ${input.packId}`);
  }
  const { sealed, canonicalText } = await pinAndSeal(ctx, tx, parsed.value, input.policyId, input.version, input.facts);
  return { sealed, canonicalText };
}

/** 가벼운 재고정: 봉인된 정책 본문은 그대로 두고 facts 고정과 version만 바꾼다(통합 설계 3.3). */
export async function repinPolicy(
  ctx: BridgeCtx, tx: Tx, input: { policyDigest: string; version: number; facts: Sealed },
): Promise<{ sealed: Sealed; canonicalText: string }> {
  const old = (await loadSealed(ctx, tx, input.policyDigest)) as AllocationDocument;
  const { sealed, canonicalText } = await pinAndSeal(ctx, tx, old, old.id, input.version, input.facts);
  return { sealed, canonicalText };
}
```

`rights-core/src/engine-bridge/activation.ts`:
```ts
import { checkActivation, type ClaimantEntry } from "mdrl/facts";
import type { Tx } from "../platform/db.ts";
import type { Diagnostic } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";

export type Declared = { role: string; party: string };

/** 활성화 검사용 사용량: 정산 대상 스템 전부를 같은 가중치로 쓴다(모든 권리 경로를 본다). */
export function fullUsage(stems: readonly { id: string; rights_bearing: boolean }[]): Record<string, string> {
  return Object.fromEntries(stems.filter((s) => s.rights_bearing).map((s) => [s.id, "1"]));
}

/** 팩·정책 활성화 판정(코어 규격 12.20): 분쟁 경로와 청구권자 커버리지. 빈 배열이면 활성화할 수 있다. */
export async function checkPackActivation(ctx: BridgeCtx, tx: Tx, input: { factsDigest: string; declared: Declared[]; at: string }): Promise<Diagnostic[]> {
  const facts = await loadFacts(ctx, tx, input.factsDigest);
  return checkActivation({
    facts, usage: fullUsage(facts.body.stems), asOf: input.at, knownAt: input.at, declared: input.declared as ClaimantEntry[],
  });
}
```

`rights-core/src/issuance/service.ts`(이 태스크 분량):
```ts
import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import type { Declared } from "../engine-bridge/activation.ts";

export async function createPack(tx: Tx, clock: Clock, actor: Actor, p: { packId: string; packCode: string; title: string; factsScopeId: string }): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  await tx.query("INSERT INTO vocal_pack (pack_id, pack_code, title, facts_scope_id, created_at) VALUES ($1,$2,$3,$4,$5)",
    [p.packId, p.packCode, p.title, p.factsScopeId, clock.now()]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_CREATED", entityType: "vocal_pack", entityId: p.packId });
}

export async function packRow(tx: Tx, packId: string, lock = false): Promise<{ packId: string; factsScopeId: string; status: string }> {
  const r = (await tx.query(`SELECT pack_id, facts_scope_id, status FROM vocal_pack WHERE pack_id = $1${lock ? " FOR SHARE" : ""}`, [packId])).rows[0];
  if (r === undefined) throw notFound("pack", packId);
  return { packId: r.pack_id, factsScopeId: r.facts_scope_id, status: r.status };
}

/** 선언 청구권자 교체. 활성 팩은 바꿀 수 없다(일시정지 또는 초안에서만). */
export async function setPackClaimants(tx: Tx, actor: Actor, packId: string, entries: Declared[]): Promise<void> {
  requireRole(actor, "RIGHTS_EDITOR");
  const pack = await packRow(tx, packId);
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is ACTIVE`);
  await tx.query("DELETE FROM pack_claimant WHERE pack_id = $1", [packId]);
  for (const e of entries) {
    await tx.query("INSERT INTO pack_claimant (pack_id, party_id, claimant_role) VALUES ($1,$2,$3)", [packId, e.party, e.role]);
  }
}

export async function declaredClaimants(tx: Tx, packId: string): Promise<Declared[]> {
  const r = await tx.query("SELECT claimant_role, party_id FROM pack_claimant WHERE pack_id = $1 ORDER BY claimant_role, party_id", [packId]);
  return r.rows.map((x) => ({ role: x.claimant_role, party: x.party_id }));
}
```

`rights-core/src/policy/service.ts`:
```ts
import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { sealFacts } from "../engine-bridge/facts.ts";
import { compilePolicyText } from "../engine-bridge/policy.ts";
import { attest, signersOf } from "../engine-bridge/attest.ts";
import { checkPackActivation } from "../engine-bridge/activation.ts";
import { declaredClaimants, packRow } from "../issuance/service.ts";

export type PolicyVersionRef = { policyId: string; version: number };
type Row = { policyId: string; version: number; status: string; policyDigest: string; factsDigest: string; factsKnownAt: string; packId: string };

async function versionRow(tx: Tx, ref: PolicyVersionRef, lock = true): Promise<Row> {
  const r = (await tx.query(
    `SELECT * FROM policy_version WHERE policy_id = $1 AND version = $2${lock ? " FOR UPDATE" : ""}`, [ref.policyId, ref.version],
  )).rows[0];
  if (r === undefined) throw notFound("policy version", `${ref.policyId}@${ref.version}`);
  return { policyId: r.policy_id, version: r.version, status: r.status, policyDigest: r.policy_digest, factsDigest: r.facts_digest, factsKnownAt: iso(r.facts_known_at)!, packId: r.pack_id };
}

/** 이미 이 정책 digest에 서명한 사람은 다른 역할로 다시 서명할 수 없다(통합 설계 6.5). */
async function requireNotSigned(tx: Tx, digest: string, actor: Actor): Promise<void> {
  if ((await signersOf(tx, digest)).some((s) => s.signerId === actor.userId)) {
    throw new DomainError("SOD_VIOLATION", 403, `${actor.userId} already signed ${digest}`);
  }
}

export async function compilePolicy(
  ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: { policyId: string; packId: string; sourceText: string },
): Promise<PolicyVersionRef & { policyDigest: string; factsDigest: string; canonicalText: string }> {
  requireRole(actor, "EDITOR");
  const pack = await packRow(tx, input.packId);
  const knownAt = clock.now();
  const facts = await sealFacts(ctx, tx, pack.factsScopeId, knownAt);
  const version = ((await tx.query("SELECT COALESCE(MAX(version), 0) AS v FROM policy_version WHERE policy_id = $1", [input.policyId])).rows[0].v as number) + 1;
  const { sealed, canonicalText } = await compilePolicyText(ctx, tx, { ...input, version, facts });
  await tx.query(
    `INSERT INTO policy_version (policy_id, version, source_text, policy_digest, facts_digest, facts_known_at, status, pack_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'COMPILED',$7,$8,$9)`,
    [input.policyId, version, canonicalText, sealed.digest, facts.digest, knownAt, input.packId, actor.userId, clock.now()],
  );
  await attest(ctx, tx, clock, { userId: actor.userId, role: "EDITOR", digest: sealed.digest });
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_COMPILED", entityType: "policy_version", entityId: `${input.policyId}@${version}`, after: { policyDigest: sealed.digest, factsDigest: facts.digest } });
  return { policyId: input.policyId, version, policyDigest: sealed.digest, factsDigest: facts.digest, canonicalText };
}

export async function approvePolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, ref: PolicyVersionRef): Promise<void> {
  requireRole(actor, "WORK_APPROVER");
  const row = await versionRow(tx, ref);
  if (row.status !== "COMPILED") throw conflict("INVALID_STATE", `${ref.policyId}@${ref.version} is ${row.status}`);
  await requireNotSigned(tx, row.policyDigest, actor);
  await attest(ctx, tx, clock, { userId: actor.userId, role: "WORK_APPROVER", digest: row.policyDigest });
  await tx.query("UPDATE policy_version SET status = 'APPROVED' WHERE policy_id = $1 AND version = $2", [ref.policyId, ref.version]);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_APPROVED", entityType: "policy_version", entityId: `${ref.policyId}@${ref.version}` });
}

/** 활성 정책 교체: 같은 정책의 이전 ACTIVE는 SUPERSEDED. 다른 정책이 이미 이 팩에서 ACTIVE면 거부. */
export async function supersedeAndActivate(tx: Tx, clock: Clock, row: Row): Promise<void> {
  const other = (await tx.query(
    "SELECT policy_id FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE' AND policy_id <> $2", [row.packId, row.policyId],
  )).rows[0];
  if (other !== undefined) throw conflict("PACK_HAS_ACTIVE_POLICY", `pack ${row.packId} already has active policy ${other.policy_id}`);
  await tx.query("UPDATE policy_version SET status = 'SUPERSEDED' WHERE policy_id = $1 AND status = 'ACTIVE'", [row.policyId]);
  await tx.query("UPDATE policy_version SET status = 'ACTIVE', activated_at = $3 WHERE policy_id = $1 AND version = $2", [row.policyId, row.version, clock.now()]);
}

export async function activatePolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, ref: PolicyVersionRef): Promise<void> {
  requireRole(actor, "ACTIVATOR");
  const row = await versionRow(tx, ref);
  if (row.status !== "APPROVED") throw conflict("INVALID_STATE", `${ref.policyId}@${ref.version} is ${row.status}`);
  await requireNotSigned(tx, row.policyDigest, actor);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: row.factsDigest, declared: await declaredClaimants(tx, row.packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `${ref.policyId}@${ref.version} cannot be activated`, diags);
  await attest(ctx, tx, clock, { userId: actor.userId, role: "ACTIVATOR", digest: row.policyDigest });
  await supersedeAndActivate(tx, clock, row);
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_ACTIVATED", entityType: "policy_version", entityId: `${ref.policyId}@${ref.version}` });
}

export async function activePolicyForPack(tx: Tx, packId: string): Promise<Omit<Row, "status" | "packId"> | undefined> {
  const r = (await tx.query("SELECT * FROM policy_version WHERE pack_id = $1 AND status = 'ACTIVE'", [packId])).rows[0];
  if (r === undefined) return undefined;
  return { policyId: r.policy_id, version: r.version, policyDigest: r.policy_digest, factsDigest: r.facts_digest, factsKnownAt: iso(r.facts_known_at)! };
}

export { versionRow };
```

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/policy/policy.test.ts && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 6 PASS, `TSC_OK`.
"activation fails …" 테스트 외의 활성화가 `FACTS_CLAIMANT_DRIFT`·`ALLOC_UNCOVERED_CLAIMANT`로 실패하면, 진단이 알려 주는 파생 청구권자 집합에 맞춰 `test/fixtures.ts`의 `DECLARED`를 고친다(엔진이 정답이다). 정책 컴파일이 `ALLOC_*`로 실패하면 `POLICY_TEXT`의 버킷을 진단에 맞게 고친다. 어느 쪽이든 보고서에 기록한다.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0004_policy.sql rights-core/src/platform/actor.ts rights-core/src/platform/audit.ts \
  rights-core/src/engine-bridge/attest.ts rights-core/src/engine-bridge/policy.ts rights-core/src/engine-bridge/activation.ts \
  rights-core/src/issuance/service.ts rights-core/src/policy/service.ts rights-core/test/fixtures.ts rights-core/test/policy/policy.test.ts
git commit -m "feat(rights-core): 신원·개발용 서명, 팩, 정책 컴파일·승인·활성화(직무 분리)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 팩 활성화와 발행 트랜잭션(발행 봉인)

**Files:**
- Create: `rights-core/migrations/0005_issuance.sql`, `rights-core/src/engine-bridge/issue.ts`
- Modify: `rights-core/src/issuance/service.ts` (팩 활성화·발행 추가)
- Test: `rights-core/test/issuance/issuance.test.ts`

**Interfaces:**
- Consumes: Task 4의 `packRow`, `declaredClaimants`, `activePolicyForPack`, `checkPackActivation`, `requireRole`, `audit`; Task 3의 `sealDocument`, `loadFacts`, `loadSealed`.
- Produces:
```ts
// engine-bridge/issue.ts
export type IssueSeal = { snapshotId: string; factsDigest: string; policyDigest: string; projectionDigest: string; membersDigest: string; asOf: string; knownAt: string };
export async function sealIssue(ctx, tx, input: { snapshotId: string; factsDigest: string; policyDigest: string;
  usageMs: Record<string, number>; members: Record<string, number>; issuedAt: string }): Promise<IssueSeal>;
export async function rederiveIssue(ctx, tx, snapshotId: string): Promise<{ ok: boolean; expected: IssueSeal; recomputed: { projectionDigest: string; membersDigest: string } }>;
// issuance/service.ts 추가
export async function openDisputeInScope(tx, scopeId: string): Promise<boolean>;
export async function activatePack(ctx, tx, clock, actor, packId: string): Promise<void>;   // ACTIVATOR
export type IssueInput = { packId: string; vcId: string; assignments: { slotId: string; stemId: string }[]; members: Record<string, number> };
export async function issue(ctx, tx, clock, actor, input: IssueInput): Promise<IssueSeal>;  // ISSUER
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/issuance/issuance.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { rederiveIssue } from "../../src/engine-bridge/issue.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);

const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, u.rights, PACK, DECLARED);
  return u;
});

const combo = (vcId: string, a = "a", b = "b") => ({
  packId: PACK, vcId,
  assignments: [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }],
  members: a === b ? { [`pty_member_${a}`]: 10000 } : { [`pty_member_${a}`]: 5000, [`pty_member_${b}`]: 5000 },
});

test("pack activation requires an active policy", async () => {
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "NO_ACTIVE_POLICY" });
  const r = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, users.approver, r));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, users.activator, r));
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_early"))), { code: "PACK_NOT_ACTIVE" });
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK));
});

test("issue writes the snapshot and an issue seal whose projection matches the usage", async () => {
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_1")));
  assert.equal(seal.snapshotId, "snp_vc_1");
  assert.equal(seal.asOf, seal.knownAt);
  const rows = await db.pool.query("SELECT stem_id, duration_ms, rights_bearing FROM snapshot_stem_assignment WHERE snapshot_id = 'snp_vc_1' ORDER BY slot_id");
  assert.deepEqual(rows.rows.map((r) => [r.stem_id, r.duration_ms, r.rights_bearing]), [["stm_a1", 30000, true], ["stm_b2", 60000, true], ["stm_mr", 90000, false]]);
  const proj = (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [seal.projectionDigest])).rows[0].content;
  assert.equal(proj.format, "mdrl-projection/1");
  assert.deepEqual(proj.vectors.PERFORMER_FEATURED, { pty_member_a: "1/3", pty_member_b: "2/3" });
  const members = (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [seal.membersDigest])).rows[0].content;
  assert.deepEqual(members, { members: { pty_member_a: "1/2", pty_member_b: "1/2" } });
});

test("identical combinations share the members seal; projections differ only by as_of", async () => {
  const a = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_2", "b", "b")));
  const b = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_3", "b", "b")));
  assert.equal(a.membersDigest, b.membersDigest);
  assert.notEqual(a.asOf, b.asOf);
  assert.notEqual(a.projectionDigest, b.projectionDigest);
  const load = async (d: string) => (await db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [d])).rows[0].content;
  const [pa, pb] = [await load(a.projectionDigest), await load(b.projectionDigest)];
  assert.deepEqual(pa.vectors, pb.vectors);
  assert.deepEqual(pa.paths, pb.paths);
});

test("invalid assignments and members are rejected and nothing is written", async () => {
  const bad = [
    { ...combo("vc_x1"), assignments: [{ slotId: "slt_1", stemId: "stm_a2" }] },
    { ...combo("vc_x2"), assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_1", stemId: "stm_b1" }] },
    { ...combo("vc_x3"), members: { pty_member_a: 6000, pty_member_b: 3000 } },
    { ...combo("vc_x4"), members: { pty_ghost: 10000 } },
    { ...combo("vc_x5"), assignments: [] },
  ];
  for (const input of bad) {
    await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, input)), { code: "INVALID_ISSUE" });
  }
  const n = await db.pool.query("SELECT count(*)::int AS n FROM rights_snapshot WHERE vc_id LIKE 'vc_x%'");
  assert.equal(n.rows[0].n, 0);
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_1"))), (e: any) => e.code === "23505" || e.code === "CONFLICT");
});

test("an open dispute in the scope blocks issuing even before the pack is paused", async () => {
  await db.tx((tx) => tx.query(
    "INSERT INTO dispute (dispute_id, target_type, target_id, facts_scope_id, dispute_reason, opened_at) VALUES ('dsp_t','RIGHT_CLAIM','c_master',$1,'test',now())", [SCOPE],
  ));
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_d"))), { code: "FACTS_DISPUTE_OPEN", status: 409 });
});

test("every issue seal re-derives from rows with a fresh bridge (no cache)", async () => {
  const fresh = createBridgeCtx(ctx.blobs);
  for (const snap of ["snp_vc_1", "snp_vc_2", "snp_vc_3"]) {
    const r = await db.tx((tx) => rederiveIssue(fresh, tx, snap));
    assert.equal(r.ok, true, snap);
  }
});

test("snapshot and issue seal rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE issue_seal SET as_of = now()"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM snapshot_member_pct"), /append-only|permission denied/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/issuance/issuance.test.ts`
Expected: FAIL (`activatePack` 없음 등).

- [ ] **Step 3: 마이그레이션 작성**

`rights-core/migrations/0005_issuance.sql`:
```sql
-- 발행 스냅샷(v2.8 3.6의 I-1 부분 집합). grant·stamp·recipe 컬럼은 범위 밖이라 이후 마이그레이션에서 추가한다.
CREATE TABLE rights_snapshot (
  snapshot_id    mdrl_id PRIMARY KEY,
  vc_id          mdrl_id NOT NULL UNIQUE,
  pack_id        mdrl_id NOT NULL REFERENCES vocal_pack,
  policy_id      mdrl_id NOT NULL,
  policy_version INT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (policy_id, policy_version) REFERENCES policy_version (policy_id, version)
);

CREATE TABLE snapshot_stem_assignment (
  snapshot_id    mdrl_id NOT NULL REFERENCES rights_snapshot,
  slot_id        mdrl_id NOT NULL REFERENCES part_slot,
  stem_id        mdrl_id NOT NULL REFERENCES stem,
  party_id       mdrl_id NULL REFERENCES party,
  start_ms       INT NOT NULL,
  end_ms         INT NOT NULL,
  duration_ms    INT NOT NULL CHECK (duration_ms > 0),
  rights_bearing BOOLEAN NOT NULL,
  PRIMARY KEY (snapshot_id, slot_id)
);

CREATE TABLE snapshot_member_pct (
  snapshot_id mdrl_id NOT NULL REFERENCES rights_snapshot,
  party_id    mdrl_id NOT NULL REFERENCES party,
  pct_bps     INT NOT NULL CHECK (pct_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (snapshot_id, party_id)
);

-- 발행 봉인(통합 설계 3.2 S3): 정산의 유일한 입력.
CREATE TABLE issue_seal (
  snapshot_id       mdrl_id PRIMARY KEY REFERENCES rights_snapshot,
  facts_digest      TEXT NOT NULL REFERENCES sealed_document,
  policy_digest     TEXT NOT NULL REFERENCES sealed_document,
  projection_digest TEXT NOT NULL REFERENCES sealed_document,
  members_digest    TEXT NOT NULL REFERENCES sealed_document,
  as_of             TIMESTAMPTZ NOT NULL,
  known_at          TIMESTAMPTZ NOT NULL
);

CREATE TRIGGER rights_snapshot_immutable BEFORE UPDATE OR DELETE ON rights_snapshot FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER snapshot_stem_assignment_immutable BEFORE UPDATE OR DELETE ON snapshot_stem_assignment FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER snapshot_member_pct_immutable BEFORE UPDATE OR DELETE ON snapshot_member_pct FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER issue_seal_immutable BEFORE UPDATE OR DELETE ON issue_seal FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON rights_snapshot, snapshot_stem_assignment, snapshot_member_pct, issue_seal TO rc_app;
```

- [ ] **Step 4: 구현**

`rights-core/src/engine-bridge/issue.ts`:
```ts
import { projectToIr, type FactsDocument } from "mdrl/facts";
import { iso, type Tx } from "../platform/db.ts";
import { invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";
import { sealDocument } from "./seal-store.ts";
import { digestOf, formatRatio, fromBps } from "mdrl/core";

export type IssueSeal = {
  snapshotId: string; factsDigest: string; policyDigest: string; projectionDigest: string; membersDigest: string; asOf: string; knownAt: string;
};

const toStrings = (o: Record<string, number>) =>
  Object.fromEntries(Object.keys(o).sort().map((k) => [k, String(o[k])]));

/** 멤버 봉인 = 엔진 Snapshot 형식(`{members: {party: "n/d"}}`, 합 1). 행의 bps를 유리수 문자열로 바꾼다(0 bps 멤버는 뺀다). */
export function membersIr(members: Record<string, number>): { members: Record<string, string> } {
  return { members: Object.fromEntries(Object.keys(members).sort().filter((k) => members[k]! > 0).map((k) => [k, formatRatio(fromBps(members[k]!))])) };
}

function buildProjection(facts: FactsDocument, usageMs: Record<string, number>, at: string) {
  const r = projectToIr(facts, toStrings(usageMs), at, at);
  if (!r.ok) throw invalid("PROJECTION_FAILED", "projection failed", r.errors);
  return r.value;
}

/** S3: 정책이 고정한 facts와 스냅샷 사용량·멤버 비율로 투영을 만들고 봉인한다. as_of = known_at = 발행 시각(9.3-6). */
export async function sealIssue(
  ctx: BridgeCtx, tx: Tx,
  input: { snapshotId: string; factsDigest: string; policyDigest: string; usageMs: Record<string, number>; members: Record<string, number>; issuedAt: string },
): Promise<IssueSeal> {
  const facts = await loadFacts(ctx, tx, input.factsDigest);
  const projection = buildProjection(facts, input.usageMs, input.issuedAt);
  const p = await sealDocument(ctx, tx, { kind: "projection", value: projection, docId: facts.id, format: projection.format });
  const m = await sealDocument(ctx, tx, { kind: "members", value: membersIr(input.members) });
  await tx.query(
    "INSERT INTO issue_seal (snapshot_id, facts_digest, policy_digest, projection_digest, members_digest, as_of, known_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [input.snapshotId, input.factsDigest, input.policyDigest, p.digest, m.digest, input.issuedAt],
  );
  return { snapshotId: input.snapshotId, factsDigest: input.factsDigest, policyDigest: input.policyDigest, projectionDigest: p.digest, membersDigest: m.digest, asOf: input.issuedAt, knownAt: input.issuedAt };
}

/** 감사: 스냅샷 행과 봉인된 facts로 투영·멤버 IR을 다시 만들어 발행 봉인과 대조한다. 봉인을 새로 쓰지 않는다. */
export async function rederiveIssue(ctx: BridgeCtx, tx: Tx, snapshotId: string) {
  const s = (await tx.query("SELECT * FROM issue_seal WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (s === undefined) throw notFound("issue seal", snapshotId);
  const expected: IssueSeal = {
    snapshotId, factsDigest: s.facts_digest, policyDigest: s.policy_digest, projectionDigest: s.projection_digest,
    membersDigest: s.members_digest, asOf: iso(s.as_of)!, knownAt: iso(s.known_at)!,
  };
  const usageMs: Record<string, number> = {};
  for (const r of (await tx.query("SELECT stem_id, duration_ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 AND rights_bearing", [snapshotId])).rows) {
    usageMs[r.stem_id] = (usageMs[r.stem_id] ?? 0) + r.duration_ms;
  }
  const members: Record<string, number> = {};
  for (const r of (await tx.query("SELECT party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = $1", [snapshotId])).rows) members[r.party_id] = r.pct_bps;
  const facts = await loadFacts(ctx, tx, expected.factsDigest);
  const recomputed = {
    projectionDigest: digestOf(buildProjection(facts, usageMs, expected.asOf)),
    membersDigest: digestOf(membersIr(members)),
  };
  const ok = recomputed.projectionDigest === expected.projectionDigest && recomputed.membersDigest === expected.membersDigest;
  return { ok, expected, recomputed };
}
```

`rights-core/src/issuance/service.ts`에 추가(파일 상단 import에 `import type { BridgeCtx } from "../engine-bridge/context.ts";`, `import { checkPackActivation } from "../engine-bridge/activation.ts";`, `import { sealIssue, type IssueSeal } from "../engine-bridge/issue.ts";`, `import { activePolicyForPack } from "../policy/service.ts";`, `invalid`를 errors import에 추가):

```ts
export async function openDisputeInScope(tx: Tx, scopeId: string): Promise<boolean> {
  return ((await tx.query("SELECT 1 FROM dispute WHERE facts_scope_id = $1 AND status = 'OPEN' LIMIT 1", [scopeId])).rowCount ?? 0) > 0;
}

/** F2(통합 설계 5.2): 활성 정책이 있고, 범위에 열린 분쟁이 없고, 활성화 검사를 통과해야 한다. */
export async function activatePack(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, packId: string): Promise<void> {
  requireRole(actor, "ACTIVATOR");
  const pack = await packRow(tx, packId);
  if (pack.status === "ACTIVE") throw conflict("INVALID_STATE", `pack ${packId} is already ACTIVE`);
  const active = await activePolicyForPack(tx, packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${packId} has no active policy`);
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: active.factsDigest, declared: await declaredClaimants(tx, packId), at: clock.now() });
  if (diags.length > 0) throw invalid("ACTIVATION_BLOCKED", `pack ${packId} cannot be activated`, diags);
  await tx.query("UPDATE vocal_pack SET status = 'ACTIVE' WHERE pack_id = $1", [packId]);
  await audit(tx, clock, { actor: actor.userId, action: "PACK_ACTIVATED", entityType: "vocal_pack", entityId: packId, after: { policy: `${active.policyId}@${active.version}` } });
}

export type IssueInput = { packId: string; vcId: string; assignments: { slotId: string; stemId: string }[]; members: Record<string, number> };

/** F3(통합 설계 5.3, 9.3-6·7): 한 트랜잭션에서 스냅샷을 쓰고 발행 봉인을 만든다. 하나라도 실패하면 아무것도 남지 않는다. */
export async function issue(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, input: IssueInput): Promise<IssueSeal> {
  requireRole(actor, "ISSUER");
  const pack = await packRow(tx, input.packId, true);
  if (pack.status !== "ACTIVE") throw conflict("PACK_NOT_ACTIVE", `pack ${input.packId} is ${pack.status}`);
  if (await openDisputeInScope(tx, pack.factsScopeId)) throw conflict("FACTS_DISPUTE_OPEN", `facts scope ${pack.factsScopeId} has an open dispute`);
  const active = await activePolicyForPack(tx, input.packId);
  if (active === undefined) throw conflict("NO_ACTIVE_POLICY", `pack ${input.packId} has no active policy`);

  const bad = (m: string) => invalid("INVALID_ISSUE", m);
  if (input.assignments.length === 0) throw bad("assignments must not be empty");
  if (new Set(input.assignments.map((a) => a.slotId)).size !== input.assignments.length) throw bad("duplicate slot in assignments");
  const stems = (await tx.query(
    `SELECT st.stem_id, st.slot_id, st.performer_party_id, st.rights_bearing, sl.start_ms, sl.end_ms, sl.duration_ms, s.facts_scope_id
       FROM stem st JOIN part_slot sl ON sl.slot_id = st.slot_id
       JOIN recording_version r ON r.recording_id = st.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE st.stem_id = ANY($1)`,
    [input.assignments.map((a) => a.stemId)],
  )).rows;
  const byStem = new Map(stems.map((s) => [s.stem_id as string, s]));
  for (const a of input.assignments) {
    const s = byStem.get(a.stemId);
    if (s === undefined || s.slot_id !== a.slotId || s.facts_scope_id !== pack.factsScopeId) throw bad(`stem ${a.stemId} is not in slot ${a.slotId} of this song`);
  }
  const memberEntries = Object.entries(input.members);
  if (memberEntries.some(([, v]) => !Number.isInteger(v) || v < 0 || v > 10000)) throw bad("member bps must be integers 0..10000");
  if (memberEntries.reduce((acc, [, v]) => acc + v, 0) !== 10000) throw bad("member bps must sum to 10000");
  const known = (await tx.query("SELECT party_id FROM party WHERE party_id = ANY($1)", [memberEntries.map(([p]) => p)])).rows.length;
  if (known !== memberEntries.length) throw bad("unknown member party");

  const issuedAt = clock.now();
  const snapshotId = `snp_${input.vcId}`;
  await tx.query("INSERT INTO rights_snapshot (snapshot_id, vc_id, pack_id, policy_id, policy_version, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [snapshotId, input.vcId, input.packId, active.policyId, active.version, issuedAt]);
  const usageMs: Record<string, number> = {};
  for (const a of input.assignments) {
    const s = byStem.get(a.stemId)!;
    await tx.query(
      "INSERT INTO snapshot_stem_assignment (snapshot_id, slot_id, stem_id, party_id, start_ms, end_ms, duration_ms, rights_bearing) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [snapshotId, a.slotId, a.stemId, s.performer_party_id, s.start_ms, s.end_ms, s.duration_ms, s.rights_bearing],
    );
    if (s.rights_bearing) usageMs[a.stemId] = (usageMs[a.stemId] ?? 0) + (s.duration_ms as number);
  }
  for (const [party, bps] of memberEntries) {
    await tx.query("INSERT INTO snapshot_member_pct (snapshot_id, party_id, pct_bps) VALUES ($1,$2,$3)", [snapshotId, party, bps]);
  }
  const seal = await sealIssue(ctx, tx, { snapshotId, factsDigest: active.factsDigest, policyDigest: active.policyDigest, usageMs, members: input.members, issuedAt });
  await audit(tx, clock, { actor: actor.userId, action: "ISSUED", entityType: "rights_snapshot", entityId: snapshotId, after: { projection: seal.projectionDigest } });
  return seal;
}
```

주의: `policy/service.ts`가 `issuance/service.ts`(packRow·declaredClaimants)를, `issuance/service.ts`가 `policy/service.ts`(activePolicyForPack)를 import하는 순환 참조가 생긴다. ESM 순환은 함수 선언만 주고받으므로 동작하지만, 명확성을 위해 `activePolicyForPack`을 호출 시점에만 쓰는 현재 구조를 유지하고 최상위 코드에서 서로의 export를 즉시 평가하지 않는다.

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/issuance/issuance.test.ts test/policy/policy.test.ts && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: issuance 7 PASS, policy 6 PASS, `TSC_OK`.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0005_issuance.sql rights-core/src/engine-bridge/issue.ts rights-core/src/issuance/service.ts rights-core/test/issuance/issuance.test.ts
git commit -m "feat(rights-core): 팩 활성화와 발행 트랜잭션(발행 봉인·재도출 감사)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 분쟁·Outbox 자동 일시정지·가벼운 재고정

**Files:**
- Create: `rights-core/src/registry/disputes.ts`, `rights-core/src/platform/outbox.ts`
- Modify: `rights-core/src/engine-bridge/activation.ts` (청구권자 집합), `rights-core/src/policy/service.ts` (`rebindPolicy`), `rights-core/src/issuance/service.ts` (`onDisputeOpened` 핸들러)
- Test: `rights-core/test/registry/disputes.test.ts`

**Interfaces:**
- Consumes: `recordClaim`, `recordMandate`, `currentClaim`, `currentMandate`(Task 2), `sealFacts`, `repinPolicy`, `checkPackActivation`, `attest`, `supersedeAndActivate`, `versionRow`, `activePolicyForPack`(Task 3~5).
- Produces:
```ts
// platform/outbox.ts
export async function enqueue(tx, clock, topic: string, payload: Record<string, unknown>): Promise<void>;
export type OutboxHandlers = Record<string, (tx: Tx, payload: any) => Promise<void>>;
export async function processOutbox(db: Db, handlers: OutboxHandlers, clock: Clock, limit?: number): Promise<number>;
export function startOutboxPoller(db, handlers, clock, intervalMs: number): () => void;
// registry/disputes.ts
export async function openDispute(tx, clock, input: { disputeId: string; targetType: "RIGHT_CLAIM"|"MANDATE"; targetId: string; reason: string }): Promise<void>;
export async function closeDispute(tx, clock, input: { disputeId: string; resolution?: { shareBps?: number; targetId?: string } }): Promise<void>;
// engine-bridge/activation.ts 추가
export async function claimantSet(ctx, tx, factsDigest: string, at: string): Promise<string[]>;   // 정렬된 "ROLE:party"
// policy/service.ts 추가
export async function rebindPolicy(ctx, tx, clock, actor, policyId: string): Promise<{ version: number; factsDigest: string; policyDigest: string }>;  // ACTIVATOR
// issuance/service.ts 추가
export const OUTBOX_HANDLERS: OutboxHandlers;   // dispute_opened → 범위의 ACTIVE 팩을 PAUSED
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/registry/disputes.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { processOutbox } from "../../src/platform/outbox.ts";
import * as policy from "../../src/policy/service.ts";
import * as issuance from "../../src/issuance/service.ts";
import { closeDispute, openDispute } from "../../src/registry/disputes.ts";
import * as reg from "../../src/registry/service.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);

const users = await db.tx(async (tx) => {
  await seedSong(tx, fixedClock(T0, 0));
  const u = await seedUsers(tx, fixedClock(T0, 0));
  await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, u.rights, PACK, DECLARED);
  return u;
});
await db.tx(async (tx) => {
  const r = await policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT });
  await policy.approvePolicy(ctx, tx, clock, users.approver, r);
  await policy.activatePolicy(ctx, tx, clock, users.activator, r);
  await issuance.activatePack(ctx, tx, clock, users.activator, PACK);
});
const combo = (vcId: string) => ({
  packId: PACK, vcId, assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }],
  members: { pty_member_a: 5000, pty_member_b: 5000 },
});
const packStatus = async () => (await db.pool.query("SELECT status FROM vocal_pack WHERE pack_id = $1", [PACK])).rows[0].status;

test("opening a dispute records a DISPUTED version and the outbox pauses the pack", async () => {
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_1", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "ownership contested" }));
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_own_b"));
  assert.equal(cur.status, "DISPUTED");
  assert.equal(await packStatus(), "ACTIVE");
  assert.equal(await processOutbox(db, issuance.OUTBOX_HANDLERS, clock), 1);
  assert.equal(await packStatus(), "PAUSED");
  assert.equal(await processOutbox(db, issuance.OUTBOX_HANDLERS, clock), 0);
  await assert.rejects(db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_dup", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "again" })), (e: any) => e.code === "23505" || e.code === "CONFLICT");
});

test("while disputed: issuing, pack activation and rebind are refused", async () => {
  await assert.rejects(db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_d1"))), { code: "PACK_NOT_ACTIVE" });
  await assert.rejects(db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK)), { code: "FACTS_DISPUTE_OPEN" });
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), { code: "REBIND_REQUIRES_APPROVAL" });
});

test("closing restores VERIFIED; a light rebind pins the new facts; the pack reactivates and issues", async () => {
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_1" }));
  const cur = await db.tx((tx) => reg.currentClaim(tx, "c_own_b"));
  assert.equal(cur.status, "VERIFIED");
  const before = await db.tx((tx) => policy.activePolicyForPack(tx, PACK));
  const rb = await db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova"));
  assert.equal(rb.version, before!.version + 1);
  assert.notEqual(rb.factsDigest, before!.factsDigest);
  const rows = await db.pool.query("SELECT version, status, rebind_of_version FROM policy_version WHERE policy_id = 'pol_nova' ORDER BY version");
  assert.deepEqual(rows.rows.map((r) => [r.version, r.status, r.rebind_of_version]), [[1, "SUPERSEDED", null], [2, "ACTIVE", 1]]);
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, users.activator, PACK));
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, users.issuer, combo("vc_after")));
  assert.equal(seal.factsDigest, rb.factsDigest);
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), { code: "REBIND_NOT_NEEDED" });
});

test("a rebind that would change the claimant set requires full approval", async () => {
  // 녹음 기여자(RECORDING_CONTRIBUTOR)가 새로 생기면 파생 청구권자 집합이 바뀐다.
  await db.tx((tx) => reg.recordClaim(tx, clock, {
    claimId: "c_contrib", factsScopeId: SCOPE, sourceId: "rcd_nova", edge: "CONTRIBUTED_BY", targetId: "pty_author_c",
    shareBps: 10000, status: "VERIFIED", validFrom: T0,
  }));
  await assert.rejects(db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, users.activator, "pol_nova")), (e: any) => e.code === "REBIND_REQUIRES_APPROVAL" && e.status === 409);
});

test("closing with a resolution amends the claim in a new VERIFIED version", async () => {
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_2", targetType: "MANDATE", targetId: "m_agency", reason: "term" }));
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_2", resolution: { shareBps: 5000 } }));
  const m = await db.tx((tx) => reg.currentMandate(tx, "m_agency"));
  assert.equal(m.status, "VERIFIED");
  assert.equal(m.shareBps, 5000);
  const d = await db.pool.query("SELECT status, closed_at FROM dispute WHERE dispute_id = 'dsp_2'");
  assert.equal(d.rows[0].status, "CLOSED");
  assert.notEqual(d.rows[0].closed_at, null);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/registry/disputes.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현**

`rights-core/src/platform/outbox.ts`:
```ts
import type { Clock } from "./clock.ts";
import type { Db, Tx } from "./db.ts";

export async function enqueue(tx: Tx, clock: Clock, topic: string, payload: Record<string, unknown>): Promise<void> {
  await tx.query("INSERT INTO outbox (topic, payload, created_at) VALUES ($1,$2,$3)", [topic, JSON.stringify(payload), clock.now()]);
}

export type OutboxHandlers = Record<string, (tx: Tx, payload: any) => Promise<void>>;

/**
 * 처리 대기 레코드를 잠그고(SKIP LOCKED) 같은 트랜잭션에서 핸들러를 실행한 뒤 processed_at을 기록한다.
 * 핸들러가 없는 topic은 건드리지 않는다. 처리한 개수를 돌려준다.
 */
export async function processOutbox(db: Db, handlers: OutboxHandlers, clock: Clock, limit = 100): Promise<number> {
  const topics = Object.keys(handlers);
  if (topics.length === 0) return 0;
  return db.tx(async (tx) => {
    const rows = (await tx.query(
      "SELECT outbox_id, topic, payload FROM outbox WHERE processed_at IS NULL AND topic = ANY($1) ORDER BY outbox_id LIMIT $2 FOR UPDATE SKIP LOCKED",
      [topics, limit],
    )).rows;
    for (const r of rows) {
      await handlers[r.topic]!(tx, r.payload);
      await tx.query("UPDATE outbox SET processed_at = $2 WHERE outbox_id = $1", [r.outbox_id, clock.now()]);
    }
    return rows.length;
  });
}

export function startOutboxPoller(db: Db, handlers: OutboxHandlers, clock: Clock, intervalMs: number): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    processOutbox(db, handlers, clock).catch((e) => console.error("outbox", e)).finally(() => { busy = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
```

`rights-core/src/registry/disputes.ts`:
```ts
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { conflict, notFound } from "../platform/errors.ts";
import { enqueue } from "../platform/outbox.ts";
import { currentClaim, currentMandate, recordClaim, recordMandate } from "./service.ts";

/** 분쟁 개시(통합 설계 5.6): 대상의 새 버전을 DISPUTED로 기록하고 dispute 행과 Outbox 이벤트를 남긴다. */
export async function openDispute(tx: Tx, clock: Clock, input: { disputeId: string; targetType: "RIGHT_CLAIM" | "MANDATE"; targetId: string; reason: string }): Promise<void> {
  let scopeId: string;
  if (input.targetType === "RIGHT_CLAIM") {
    const { version: _v, ...cur } = await currentClaim(tx, input.targetId);
    await recordClaim(tx, clock, { ...cur, status: "DISPUTED" });
    scopeId = cur.factsScopeId;
  } else {
    const { version: _v, ...cur } = await currentMandate(tx, input.targetId);
    await recordMandate(tx, clock, { ...cur, status: "DISPUTED" });
    scopeId = cur.factsScopeId;
  }
  await tx.query(
    "INSERT INTO dispute (dispute_id, target_type, target_id, facts_scope_id, dispute_reason, opened_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [input.disputeId, input.targetType, input.targetId, scopeId, input.reason, clock.now()],
  );
  await enqueue(tx, clock, "dispute_opened", { disputeId: input.disputeId, factsScopeId: scopeId });
}

/** 분쟁 종결: 대상의 새 VERIFIED 버전(해결안이 있으면 지분·대상을 고친다)을 기록하고 dispute를 닫는다. 팩 재활성화는 수동이다. */
export async function closeDispute(tx: Tx, clock: Clock, input: { disputeId: string; resolution?: { shareBps?: number; targetId?: string } }): Promise<void> {
  const d = (await tx.query("SELECT * FROM dispute WHERE dispute_id = $1 FOR UPDATE", [input.disputeId])).rows[0];
  if (d === undefined) throw notFound("dispute", input.disputeId);
  if (d.status !== "OPEN") throw conflict("INVALID_STATE", `dispute ${input.disputeId} is ${d.status}`);
  const res = input.resolution ?? {};
  if (d.target_type === "RIGHT_CLAIM") {
    const { version: _v, ...cur } = await currentClaim(tx, d.target_id);
    await recordClaim(tx, clock, { ...cur, status: "VERIFIED", ...(res.shareBps !== undefined && { shareBps: res.shareBps }), ...(res.targetId !== undefined && { targetId: res.targetId }) });
  } else {
    const { version: _v, ...cur } = await currentMandate(tx, d.target_id);
    await recordMandate(tx, clock, { ...cur, status: "VERIFIED", ...(res.shareBps !== undefined && { shareBps: res.shareBps }), ...(res.targetId !== undefined && { toPartyId: res.targetId }) });
  }
  await tx.query("UPDATE dispute SET status = 'CLOSED', closed_at = $2 WHERE dispute_id = $1", [input.disputeId, clock.now()]);
  await enqueue(tx, clock, "dispute_closed", { disputeId: input.disputeId, factsScopeId: d.facts_scope_id });
}
```

`rights-core/src/engine-bridge/activation.ts`에 추가(import에 `deriveClaimants`, `projectVectors`를 `mdrl/facts`에서, `invalid`를 errors에서 추가):
```ts
/** 투영에서 파생한 청구권자 집합(정렬된 "ROLE:party"). 재고정 판정에 쓴다(통합 설계 3.3). */
export async function claimantSet(ctx: BridgeCtx, tx: Tx, factsDigest: string, at: string): Promise<string[]> {
  const facts = await loadFacts(ctx, tx, factsDigest);
  const projection = projectVectors(facts, fullUsage(facts.body.stems), at, at);
  if (!projection.ok) throw invalid("PROJECTION_FAILED", "projection failed", projection.errors);
  const derived = deriveClaimants(facts, projection.value, at, at);
  if (!derived.ok) throw invalid("PROJECTION_FAILED", "claimant derivation failed", derived.errors);
  return derived.value.map((e) => `${e.role}:${e.party}`).sort();
}
```

`rights-core/src/policy/service.ts`에 추가(import에 `repinPolicy`를 `../engine-bridge/policy.ts`에서, `claimantSet`을 `../engine-bridge/activation.ts`에서 추가):
```ts
/**
 * 가벼운 재고정(통합 설계 3.3): 현재 ACTIVE 버전의 본문을 새 facts 봉인에 다시 고정한 새 버전을 만들어 곧바로 ACTIVE로 한다.
 * 조건: facts가 실제로 바뀌었고, 청구권자 집합이 같고, 활성화 검사가 통과한다. 아니면 전체 재승인이 필요하다.
 */
export async function rebindPolicy(ctx: BridgeCtx, tx: Tx, clock: Clock, actor: Actor, policyId: string): Promise<{ version: number; factsDigest: string; policyDigest: string }> {
  requireRole(actor, "ACTIVATOR");
  const cur = (await tx.query("SELECT version FROM policy_version WHERE policy_id = $1 AND status = 'ACTIVE' FOR UPDATE", [policyId])).rows[0];
  if (cur === undefined) throw conflict("INVALID_STATE", `${policyId} has no ACTIVE version`);
  const row = await versionRow(tx, { policyId, version: cur.version });
  const pack = await packRow(tx, row.packId);
  const now = clock.now();
  const facts = await sealFacts(ctx, tx, pack.factsScopeId, now);
  if (facts.digest === row.factsDigest) throw conflict("REBIND_NOT_NEEDED", `${policyId} is already pinned to the current facts`);
  const diags = await checkPackActivation(ctx, tx, { factsDigest: facts.digest, declared: await declaredClaimants(tx, row.packId), at: now });
  const before = await claimantSet(ctx, tx, row.factsDigest, now);
  const after = diags.length === 0 ? await claimantSet(ctx, tx, facts.digest, now) : [];
  if (diags.length > 0 || before.join("|") !== after.join("|")) {
    throw new DomainError("REBIND_REQUIRES_APPROVAL", 409, `${policyId}: claimants changed or activation blocked; full approval required`, diags);
  }
  const version = ((await tx.query("SELECT MAX(version) AS v FROM policy_version WHERE policy_id = $1", [policyId])).rows[0].v as number) + 1;
  const { sealed, canonicalText } = await repinPolicy(ctx, tx, { policyDigest: row.policyDigest, version, facts });
  await tx.query(
    `INSERT INTO policy_version (policy_id, version, source_text, policy_digest, facts_digest, facts_known_at, status, rebind_of_version, pack_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',$7,$8,$9,$10)`,
    [policyId, version, canonicalText, sealed.digest, facts.digest, now, row.version, row.packId, actor.userId, clock.now()],
  );
  await attest(ctx, tx, clock, { userId: actor.userId, role: "ACTIVATOR", digest: sealed.digest });
  await supersedeAndActivate(tx, clock, { ...row, version, policyDigest: sealed.digest, factsDigest: facts.digest });
  await audit(tx, clock, { actor: actor.userId, action: "POLICY_REBOUND", entityType: "policy_version", entityId: `${policyId}@${version}`, after: { rebindOf: row.version, factsDigest: facts.digest } });
  return { version, factsDigest: facts.digest, policyDigest: sealed.digest };
}
```

`rights-core/src/issuance/service.ts`에 추가(import에 `type OutboxHandlers`를 `../platform/outbox.ts`에서 추가):
```ts
/** Outbox 핸들러: 분쟁이 열리면 그 facts 범위의 ACTIVE 팩을 일시정지한다(통합 설계 5.6-1). 재활성화는 수동이다. */
export const OUTBOX_HANDLERS: OutboxHandlers = {
  async dispute_opened(tx, payload: { factsScopeId: string; disputeId: string }) {
    const paused = (await tx.query(
      "UPDATE vocal_pack SET status = 'PAUSED' WHERE facts_scope_id = $1 AND status = 'ACTIVE' RETURNING pack_id", [payload.factsScopeId],
    )).rows;
    for (const p of paused) {
      await tx.query(
        "INSERT INTO audit_log (occurred_at, actor_user_id, action_name, entity_type, entity_id, after_json) VALUES (now(), 'system:outbox', 'PACK_PAUSED', 'vocal_pack', $1, $2)",
        [p.pack_id, JSON.stringify({ disputeId: payload.disputeId })],
      );
    }
  },
};
```

- [ ] **Step 4: 통과 확인**

Run: `cd rights-core && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: fail 0, `TSC_OK`.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/registry/disputes.ts rights-core/src/platform/outbox.ts rights-core/src/engine-bridge/activation.ts \
  rights-core/src/policy/service.ts rights-core/src/issuance/service.ts rights-core/test/registry/disputes.test.ts
git commit -m "feat(rights-core): 분쟁 개시·종결, Outbox 팩 자동 일시정지, 정책 가벼운 재고정

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 최소 HTTP API

**Files:**
- Create: `rights-core/src/http/server.ts`, `rights-core/src/http/seal-routes.ts`, `rights-core/src/http/main.ts`, `rights-core/src/registry/routes.ts`, `rights-core/src/policy/routes.ts`, `rights-core/src/issuance/routes.ts`
- Test: `rights-core/test/http/api.test.ts`

**Interfaces:**
- Consumes: Task 1~6 서비스 전부.
- Produces: `buildServer(deps: { db: Db; ctx: BridgeCtx; clock: Clock }): FastifyInstance`. 모든 쓰기 요청은 헤더 `x-actor: <user_id>`가 필요하다(없으면 401 `UNKNOWN_ACTOR`). 응답 오류 본문은 `{ code, message, diagnostics }`.

| 메서드·경로 | 서비스 | 필요 역할 | 성공 |
|---|---|---|---|
| `POST /parties` `/works` `/scopes` `/recordings` `/slots` `/stems` `/voices` | `register*`·`createScope` | RIGHTS_EDITOR | 201 `{}` |
| `POST /claims`, `POST /mandates` | `recordClaim`·`recordMandate` | RIGHTS_EDITOR | 201 `Recorded` |
| `POST /disputes`, `POST /disputes/:id/close` | `openDispute`·`closeDispute` | RIGHTS_EDITOR | 201·200 |
| `POST /packs`, `PUT /packs/:id/claimants`, `POST /packs/:id/activate` | `createPack`·`setPackClaimants`·`activatePack` | RIGHTS_EDITOR·RIGHTS_EDITOR·ACTIVATOR | 201·200·200 |
| `POST /policies/:policyId/compile` `{packId, sourceText}` | `compilePolicy` | EDITOR | 201 |
| `POST /policies/:policyId/versions/:version/approve` `/activate` | `approvePolicy`·`activatePolicy` | WORK_APPROVER·ACTIVATOR | 200 |
| `POST /policies/:policyId/rebind` | `rebindPolicy` | ACTIVATOR | 200 |
| `POST /issues` `IssueInput` | `issue` | ISSUER | 201 `IssueSeal` |
| `GET /seals/:digest` | `loadSealed` | (신원 불필요) | 200 문서 원문 |
| `GET /issues/:snapshotId/audit` | `rederiveIssue` | (신원 불필요) | 200 `{ ok, expected, recomputed }` |

레지스트리 등록 경로에는 권한 검사가 서비스에 없으므로 route에서 `requireRole(actor, "RIGHTS_EDITOR")`를 호출한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/http/api.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { DECLARED, POLICY_TEXT, T0, seedUsers, tempBridge } from "../fixtures.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { buildServer } from "../../src/http/server.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
await db.tx((tx) => seedUsers(tx, fixedClock(T0, 0)));
const app = buildServer({ db, ctx, clock });
after(async () => { await app.close(); await drop(); cleanup(); });

const call = (method: "GET" | "POST" | "PUT", url: string, actor?: string, payload?: unknown) =>
  app.inject({ method, url, ...(actor && { headers: { "x-actor": actor } }), ...(payload !== undefined && { payload }) });
const post = (url: string, actor: string, payload: unknown) => call("POST", url, actor, payload);

test("registration requires an actor with RIGHTS_EDITOR", async () => {
  assert.equal((await call("POST", "/parties", undefined, { partyId: "p", partyType: "LABEL", displayName: "p" })).statusCode, 401);
  const r = await post("/parties", "usr_editor", { partyId: "p", partyType: "LABEL", displayName: "p" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code, "ROLE_REQUIRED");
});

test("end-to-end: register a song, compile/approve/activate a policy, activate the pack, issue, audit", async () => {
  const R = "usr_rights";
  const ok = async (p: Promise<{ statusCode: number; body: string }>, status = 201) => {
    const r = await p;
    assert.equal(r.statusCode, status, r.body);
    return JSON.parse(r.body || "{}");
  };
  for (const [partyId, partyType] of [["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"], ["pty_cmo", "CMO"], ["pty_member_a", "MEMBER"], ["pty_member_b", "MEMBER"]]) {
    await ok(post("/parties", R, { partyId, partyType, displayName: partyId }));
  }
  await ok(post("/works", R, { workId: "wrk_nova", title: "Nova" }));
  await ok(post("/scopes", R, { factsScopeId: "fsc_nova", workId: "wrk_nova" }));
  await ok(post("/recordings", R, { recordingId: "rcd_nova", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Main" }));
  await ok(post("/slots", R, { slotId: "slt_1", recordingId: "rcd_nova", startMs: 0, endMs: 30000, sortOrder: 1 }));
  await ok(post("/slots", R, { slotId: "slt_2", recordingId: "rcd_nova", startMs: 30000, endMs: 90000, sortOrder: 2 }));
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await ok(post("/stems", R, { stemId: `stm_${m}${s}`, slotId: `slt_${s}`, recordingId: "rcd_nova", performerPartyId: `pty_member_${m}`, rightsBearing: true }));
  }
  for (const m of ["a", "b"]) await ok(post("/voices", R, { voiceId: `vo_${m}`, factsScopeId: "fsc_nova", kind: "HUMAN" }));
  const base = { factsScopeId: "fsc_nova", status: "VERIFIED", validFrom: T0 };
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await ok(post("/claims", R, { ...base, claimId: `c_perf_${m}${s}`, sourceId: `stm_${m}${s}`, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" }));
  }
  for (const m of ["a", "b"]) await ok(post("/claims", R, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 }));
  await ok(post("/claims", R, { ...base, claimId: "c_master", sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 }));
  await ok(post("/claims", R, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" }));
  await ok(post("/claims", R, { ...base, claimId: "c_music", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" }));
  await ok(post("/mandates", R, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 }));
  await ok(post("/mandates", R, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 }));
  await ok(post("/packs", R, { packId: "pak_nova", packCode: "NOVA", title: "Nova", factsScopeId: "fsc_nova" }));
  await ok(call("PUT", "/packs/pak_nova/claimants", R, DECLARED), 200);

  const bad = await post("/policies/pol_nova/compile", "usr_editor", { packId: "pak_nova", sourceText: "allocation {" });
  assert.equal(bad.statusCode, 422);
  assert.ok(bad.json().diagnostics.some((d: any) => d.code === "PARSE_SYNTAX"));
  const compiled = await ok(post("/policies/pol_nova/compile", "usr_editor", { packId: "pak_nova", sourceText: POLICY_TEXT }));
  await ok(post(`/policies/pol_nova/versions/${compiled.version}/approve`, "usr_approver", {}), 200);
  await ok(post(`/policies/pol_nova/versions/${compiled.version}/activate`, "usr_activator", {}), 200);
  await ok(post("/packs/pak_nova/activate", "usr_activator", {}), 200);
  const seal = await ok(post("/issues", "usr_issuer", {
    packId: "pak_nova", vcId: "vc_api", assignments: [{ slotId: "slt_1", stemId: "stm_a1" }, { slotId: "slt_2", stemId: "stm_b2" }],
    members: { pty_member_a: 5000, pty_member_b: 5000 },
  }));
  const doc = await ok(call("GET", `/seals/${encodeURIComponent(seal.projectionDigest)}`), 200);
  assert.equal(doc.format, "mdrl-projection/1");
  const audit = await ok(call("GET", "/issues/snp_vc_api/audit"), 200);
  assert.equal(audit.ok, true);
  const dup = await post("/issues", "usr_issuer", {
    packId: "pak_nova", vcId: "vc_api", assignments: [{ slotId: "slt_1", stemId: "stm_a1" }], members: { pty_member_a: 10000 },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal((await call("GET", `/seals/${encodeURIComponent(`mdrl:sha256:${"0".repeat(64)}`)}`)).statusCode, 404);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/http/api.test.ts`
Expected: FAIL (`Cannot find module '../../src/http/server.ts'`).

- [ ] **Step 3: 구현**

`rights-core/src/http/server.ts`:
```ts
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { loadActor, type Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { registryRoutes } from "../registry/routes.ts";
import { policyRoutes } from "../policy/routes.ts";
import { issuanceRoutes } from "../issuance/routes.ts";
import { sealRoutes } from "./seal-routes.ts";

export type Deps = { db: Db; ctx: BridgeCtx; clock: Clock };

/** 요청 하나 = 트랜잭션 하나. x-actor 헤더로 신원을 읽는다(개발용 — 통합 설계 9.1). */
export async function withActor<T>(deps: Deps, req: FastifyRequest, fn: (tx: Tx, actor: Actor) => Promise<T>): Promise<T> {
  const userId = req.headers["x-actor"];
  if (typeof userId !== "string" || userId === "") throw new DomainError("UNKNOWN_ACTOR", 401, "x-actor header is required");
  return deps.db.tx(async (tx) => fn(tx, await loadActor(tx, userId)));
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ code: err.code, message: err.message, diagnostics: err.diagnostics });
    }
    if (err?.code === "23505") return reply.status(409).send({ code: "CONFLICT", message: err.detail ?? err.message, diagnostics: [] });
    if (err?.code === "RC001") return reply.status(409).send({ code: "APPEND_ONLY", message: err.message, diagnostics: [] });
    if (err?.code === "23503" || err?.code === "23514") return reply.status(422).send({ code: "INVALID_REFERENCE", message: err.detail ?? err.message, diagnostics: [] });
    if (err?.validation) return reply.status(400).send({ code: "BAD_REQUEST", message: err.message, diagnostics: [] });
    return reply.status(500).send({ code: "INTERNAL", message: "internal error", diagnostics: [] });
  });
  registryRoutes(app, deps);
  policyRoutes(app, deps);
  issuanceRoutes(app, deps);
  sealRoutes(app, deps);
  return app;
}
```

`rights-core/src/registry/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { requireRole } from "../platform/actor.ts";
import { withActor, type Deps } from "../http/server.ts";
import * as reg from "./service.ts";
import { closeDispute, openDispute } from "./disputes.ts";

export function registryRoutes(app: FastifyInstance, deps: Deps): void {
  const created = <B>(path: string, fn: (tx: any, body: B) => Promise<unknown>) =>
    app.post(path, async (req, reply) => {
      const out = await withActor(deps, req, async (tx, actor) => {
        requireRole(actor, "RIGHTS_EDITOR");
        return fn(tx, req.body as B);
      });
      return reply.status(201).send(out ?? {});
    });
  created<any>("/parties", (tx, b) => reg.registerParty(tx, deps.clock, b));
  created<any>("/works", (tx, b) => reg.registerWork(tx, deps.clock, b));
  created<any>("/scopes", (tx, b) => reg.createScope(tx, deps.clock, b));
  created<any>("/recordings", (tx, b) => reg.registerRecording(tx, deps.clock, b));
  created<any>("/slots", (tx, b) => reg.registerSlot(tx, b));
  created<any>("/stems", (tx, b) => reg.registerStem(tx, deps.clock, b));
  created<any>("/voices", (tx, b) => reg.registerVoice(tx, deps.clock, b));
  created<reg.ClaimDraft>("/claims", (tx, b) => reg.recordClaim(tx, deps.clock, b));
  created<reg.MandateDraft>("/mandates", (tx, b) => reg.recordMandate(tx, deps.clock, b));
  created<any>("/disputes", (tx, b) => openDispute(tx, deps.clock, b));
  app.post<{ Params: { id: string }; Body: { resolution?: { shareBps?: number; targetId?: string } } }>("/disputes/:id/close", async (req) =>
    withActor(deps, req, async (tx, actor) => {
      requireRole(actor, "RIGHTS_EDITOR");
      await closeDispute(tx, deps.clock, { disputeId: req.params.id, ...(req.body?.resolution && { resolution: req.body.resolution }) });
      return {};
    }));
}
```

`rights-core/src/policy/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import * as policy from "./service.ts";

export function policyRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Params: { policyId: string }; Body: { packId: string; sourceText: string } }>("/policies/:policyId/compile", async (req, reply) => {
    const out = await withActor(deps, req, (tx, actor) =>
      policy.compilePolicy(deps.ctx, tx, deps.clock, actor, { policyId: req.params.policyId, packId: req.body.packId, sourceText: req.body.sourceText }));
    return reply.status(201).send(out);
  });
  const ref = (p: { policyId: string; version: string }) => ({ policyId: p.policyId, version: Number(p.version) });
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/approve", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.approvePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string; version: string } }>("/policies/:policyId/versions/:version/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await policy.activatePolicy(deps.ctx, tx, deps.clock, actor, ref(req.params)); return {}; }));
  app.post<{ Params: { policyId: string } }>("/policies/:policyId/rebind", async (req) =>
    withActor(deps, req, (tx, actor) => policy.rebindPolicy(deps.ctx, tx, deps.clock, actor, req.params.policyId)));
}
```

`rights-core/src/issuance/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import type { Declared } from "../engine-bridge/activation.ts";
import * as issuance from "./service.ts";

export function issuanceRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: { packId: string; packCode: string; title: string; factsScopeId: string } }>("/packs", async (req, reply) => {
    await withActor(deps, req, (tx, actor) => issuance.createPack(tx, deps.clock, actor, req.body));
    return reply.status(201).send({});
  });
  app.put<{ Params: { id: string }; Body: Declared[] }>("/packs/:id/claimants", async (req) =>
    withActor(deps, req, async (tx, actor) => { await issuance.setPackClaimants(tx, actor, req.params.id, req.body); return {}; }));
  app.post<{ Params: { id: string } }>("/packs/:id/activate", async (req) =>
    withActor(deps, req, async (tx, actor) => { await issuance.activatePack(deps.ctx, tx, deps.clock, actor, req.params.id); return {}; }));
  app.post<{ Body: issuance.IssueInput }>("/issues", async (req, reply) => {
    const seal = await withActor(deps, req, (tx, actor) => issuance.issue(deps.ctx, tx, deps.clock, actor, req.body));
    return reply.status(201).send(seal);
  });
}
```

`rights-core/src/http/seal-routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { loadSealed } from "../engine-bridge/seal-store.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import type { Deps } from "./server.ts";

/** 봉인 조회와 발행 봉인 재도출. 조회 전용이라 신원을 요구하지 않는다(PoC). */
export function sealRoutes(app: FastifyInstance, deps: Deps): void {
  app.get<{ Params: { digest: string } }>("/seals/:digest", async (req) => deps.db.tx((tx) => loadSealed(deps.ctx, tx, req.params.digest)));
  app.get<{ Params: { snapshotId: string } }>("/issues/:snapshotId/audit", async (req) => deps.db.tx((tx) => rederiveIssue(deps.ctx, tx, req.params.snapshotId)));
}
```

`rights-core/src/http/main.ts`:
```ts
import { systemClock } from "../platform/clock.ts";
import { createDb } from "../platform/db.ts";
import { startOutboxPoller } from "../platform/outbox.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { OUTBOX_HANDLERS } from "../issuance/service.ts";
import { buildServer } from "./server.ts";

const url = process.env.DATABASE_URL ?? "postgres://rc_app:rc_app@localhost:54329/rights_core";
const db = createDb(url);
const ctx = createBridgeCtx(createFsBlobStore(process.env.BLOB_DIR ?? ".blobs"));
const app = buildServer({ db, ctx, clock: systemClock });
const stop = startOutboxPoller(db, OUTBOX_HANDLERS, systemClock, 1000);
const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "127.0.0.1" });
console.log(`rights-core listening on http://127.0.0.1:${port}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { stop(); await app.close(); await db.close(); process.exit(0); });
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd rights-core && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: fail 0, `TSC_OK`.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/http/server.ts rights-core/src/http/seal-routes.ts rights-core/src/http/main.ts \
  rights-core/src/registry/routes.ts rights-core/src/policy/routes.ts rights-core/src/issuance/routes.ts rights-core/test/http/api.test.ts
git commit -m "feat(rights-core): 최소 HTTP API(등록·정책·팩·발행·봉인 조회·재도출)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 시나리오 러너(합성 곡 1개·1만 조합)와 결과 기록

**Files:**
- Create: `rights-core/src/scenario/{prng,synthetic-song,run,main}.ts`
- Test: `rights-core/test/scenario/scenario.test.ts`
- Modify: `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` (9.5 결과 절 추가)

**Interfaces:**
- Consumes: 전부. 시나리오는 HTTP가 아니라 서비스 함수를 직접 호출한다(발행 지연을 서비스 수준에서 잰다).
- Produces:
```ts
export function mulberry32(seed: number): () => number;   // prng.ts, [0,1)
export const SONG: { scope: string; pack: string; members: string[]; slots: { id: string; startMs: number; endMs: number }[]; declared: {role:string;party:string}[]; policyText: string };
export async function seedSyntheticSong(tx, clock, users): Promise<void>;  // synthetic-song.ts
export type ScenarioReport = { issued: number; p50Ms: number; p95Ms: number; maxMs: number; totalMs: number;
  distinctProjections: number; distinctVectorSets: number; auditMismatches: number; factsRederiveOk: boolean; disputeFlowOk: boolean };
export async function runScenario(deps: { db: Db; ctx: BridgeCtx }, opts: { n: number; seed: number }): Promise<ScenarioReport>;  // run.ts
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/scenario/scenario.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { tempBridge } from "../fixtures.ts";
import { mulberry32 } from "../../src/scenario/prng.ts";
import { runScenario } from "../../src/scenario/run.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });

test("mulberry32 is deterministic", () => {
  const a = mulberry32(42), b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("reduced scenario (200 combinations): all seals re-derive, dispute flow passes", async () => {
  const r = await runScenario({ db, ctx }, { n: 200, seed: 7 });
  assert.equal(r.issued, 200);
  assert.equal(r.auditMismatches, 0);
  assert.equal(r.factsRederiveOk, true);
  assert.equal(r.disputeFlowOk, true);
  // 투영 IR에는 as_of(발행 시각)가 들어가므로 발행마다 digest가 다르다. 같은 조합은 벡터·경로만 같다.
  assert.equal(r.distinctProjections, r.issued);
  assert.ok(r.distinctVectorSets >= 2 && r.distinctVectorSets <= 81, String(r.distinctVectorSets));
  assert.ok(r.p95Ms > 0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/scenario/scenario.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현**

`rights-core/src/scenario/prng.ts`:
```ts
/** 시드 고정 의사난수(재현 가능한 시나리오용). [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`rights-core/src/scenario/synthetic-song.ts`:
```ts
import type { Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import * as reg from "../registry/service.ts";
import * as issuance from "../issuance/service.ts";

const T0 = "2026-01-01T00:00:00.000Z";

/**
 * 합성 곡(통합 설계 9.1): nova-debut-01을 확장한 곡 1개. 멤버 3명(a·b·c)이 슬롯 4개를 각자 녹음(스템 12개), MR 1개.
 * 작사·작곡 60/40(작가 b는 CMO 위임), 멤버 a는 기획사 위임, 레이블 마스터 100%.
 */
export const SONG = {
  scope: "fsc_nova_summer",
  pack: "pak_nova_summer",
  members: ["a", "b", "c"],
  slots: [
    { id: "slt_1", startMs: 0, endMs: 30000 },
    { id: "slt_2", startMs: 30000, endMs: 75000 },
    { id: "slt_3", startMs: 75000, endMs: 150000 },
    { id: "slt_4", startMs: 150000, endMs: 180000 },
  ],
  declared: [
    { role: "AGENCY", party: "pty_agency" }, { role: "CMO", party: "pty_cmo" }, { role: "MASTER_OWNER", party: "pty_label" },
    { role: "PERFORMER_FEATURED", party: "pty_member_a" }, { role: "PERFORMER_FEATURED", party: "pty_member_b" },
    { role: "PERFORMER_FEATURED", party: "pty_member_c" },
    { role: "WORK_AUTHOR", party: "pty_author_b" }, { role: "WORK_AUTHOR", party: "pty_author_c" },
  ],
  policyText: `allocation "pol_nova_summer" version 1 {
  uses facts "fsc_nova_summer"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: pak_nova_summer; events: [PRIMARY]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) : 40%;
      work = graph(WORK_AUTHOR) via mandate : 10%;
      agency = contract(pty_agency) : 10% as AGENCY;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
`,
};

export async function seedSyntheticSong(tx: Tx, clock: Clock, rights: Actor): Promise<void> {
  const parties: [string, reg.PartyType][] = [
    ["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"], ["pty_cmo", "CMO"],
    ...SONG.members.map((m): [string, reg.PartyType] => [`pty_member_${m}`, "MEMBER"]),
  ];
  for (const [id, t] of parties) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: id });
  await reg.registerWork(tx, clock, { workId: "wrk_nova_summer", title: "Nova Summer" });
  await reg.createScope(tx, clock, { factsScopeId: SONG.scope, workId: "wrk_nova_summer" });
  await reg.registerRecording(tx, clock, { recordingId: "rcd_nova_summer", workId: "wrk_nova_summer", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  let sort = 1;
  for (const s of SONG.slots) await reg.registerSlot(tx, { slotId: s.id, recordingId: "rcd_nova_summer", startMs: s.startMs, endMs: s.endMs, sortOrder: sort++ });
  await reg.registerSlot(tx, { slotId: "slt_mr", recordingId: "rcd_nova_summer", startMs: 0, endMs: 180000, sortOrder: sort });
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: "rcd_nova_summer", rightsBearing: false });
  const base = { factsScopeId: SONG.scope, status: "VERIFIED" as const, validFrom: T0 };
  for (const m of SONG.members) {
    await reg.registerVoice(tx, clock, { voiceId: `vo_${m}`, factsScopeId: SONG.scope, kind: "HUMAN" });
    for (const s of SONG.slots) {
      const stemId = `stm_${m}_${s.id}`;
      await reg.registerStem(tx, clock, { stemId, slotId: s.id, recordingId: "rcd_nova_summer", performerPartyId: `pty_member_${m}`, rightsBearing: true });
      await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${m}_${s.id}`, sourceId: stemId, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" });
    }
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: "rcd_nova_summer", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_music", sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 });
  await issuance.createPack(tx, clock, rights, { packId: SONG.pack, packCode: "NOVA-SUMMER", title: "Nova Summer", factsScopeId: SONG.scope });
  await issuance.setPackClaimants(tx, rights, SONG.pack, SONG.declared);
}
```

`rights-core/src/scenario/run.ts`:
```ts
import { performance } from "node:perf_hooks";
import { createUser, loadActor, type Actor } from "../platform/actor.ts";
import { fixedClock } from "../platform/clock.ts";
import type { Db } from "../platform/db.ts";
import { DomainError } from "../platform/errors.ts";
import { processOutbox } from "../platform/outbox.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { sealFacts } from "../engine-bridge/facts.ts";
import { rederiveIssue } from "../engine-bridge/issue.ts";
import * as policy from "../policy/service.ts";
import * as issuance from "../issuance/service.ts";
import { closeDispute, openDispute } from "../registry/disputes.ts";
import { mulberry32 } from "./prng.ts";
import { SONG, seedSyntheticSong } from "./synthetic-song.ts";

export type ScenarioReport = {
  issued: number; p50Ms: number; p95Ms: number; maxMs: number; totalMs: number;
  /** 서로 다른 투영 digest 수(as_of가 발행마다 달라 issued와 같아야 한다). */
  distinctProjections: number;
  /** 서로 다른 (vectors, paths) 조합 수 = 실질적으로 다른 조합 수(멤버 3명·슬롯 4개면 최대 81). */
  distinctVectorSets: number;
  auditMismatches: number; factsRederiveOk: boolean; disputeFlowOk: boolean;
};

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function users(db: Db): Promise<Record<"rights" | "editor" | "approver" | "activator" | "issuer", Actor>> {
  const c = fixedClock("2026-01-01T00:00:00.000Z", 0);
  const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"]] as const;
  return db.tx(async (tx) => {
    const out: Record<string, Actor> = {};
    for (const [name, role] of spec) {
      await createUser(tx, c, { userId: `usr_${name}`, displayName: name, roles: [role] });
      out[name] = await loadActor(tx, `usr_${name}`);
    }
    return out as never;
  });
}

/** 한 조합: 슬롯마다 멤버 한 명을 고르고, 멤버 비율 = 맡은 슬롯 수 × 2500 bps. */
function combination(rand: () => number, i: number) {
  const picks = SONG.slots.map(() => SONG.members[Math.floor(rand() * SONG.members.length)]!);
  const members: Record<string, number> = {};
  for (const m of picks) members[`pty_member_${m}`] = (members[`pty_member_${m}`] ?? 0) + 2500;
  return {
    packId: SONG.pack,
    vcId: `vc_${String(i).padStart(6, "0")}`,
    assignments: [...SONG.slots.map((s, k) => ({ slotId: s.id, stemId: `stm_${picks[k]}_${s.id}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
    members,
  };
}

/**
 * 통합 설계 9.4 완료 기준을 한 번에 돌린다:
 * 합성 곡 등록 → 정책 컴파일·승인·활성화 → 팩 활성화 → n 조합 발행(지연 측정) → 전수 재도출 → facts 재봉인 대조 → 분쟁·재고정 흐름.
 */
export async function runScenario(deps: { db: Db; ctx: BridgeCtx }, opts: { n: number; seed: number }): Promise<ScenarioReport> {
  const { db, ctx } = deps;
  const u = await users(db);
  await db.tx((tx) => seedSyntheticSong(tx, fixedClock("2026-01-01T00:00:00.000Z", 0), u.rights));
  const clock = fixedClock("2026-02-01T00:00:00.000Z", 1);
  const compiled = await db.tx((tx) => policy.compilePolicy(ctx, tx, clock, u.editor, { policyId: "pol_nova_summer", packId: SONG.pack, sourceText: SONG.policyText }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, clock, u.approver, compiled));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, clock, u.activator, compiled));
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, u.activator, SONG.pack));

  const rand = mulberry32(opts.seed);
  const times: number[] = [];
  const started = performance.now();
  for (let i = 0; i < opts.n; i++) {
    const input = combination(rand, i);
    const t0 = performance.now();
    await db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer, input));
    times.push(performance.now() - t0);
  }
  const totalMs = performance.now() - started;
  times.sort((a, b) => a - b);

  const fresh = createBridgeCtx(ctx.blobs);
  let auditMismatches = 0;
  const snaps = (await db.pool.query("SELECT snapshot_id FROM issue_seal ORDER BY snapshot_id")).rows.map((r) => r.snapshot_id as string);
  for (const s of snaps) {
    const r = await db.tx((tx) => rederiveIssue(fresh, tx, s));
    if (!r.ok) auditMismatches++;
  }
  const distinctProjections = (await db.pool.query("SELECT count(DISTINCT projection_digest)::int AS n FROM issue_seal")).rows[0].n as number;
  const distinctVectorSets = (await db.pool.query(
    "SELECT count(DISTINCT (d.content->'vectors', d.content->'paths'))::int AS n FROM issue_seal s JOIN sealed_document d ON d.digest = s.projection_digest",
  )).rows[0].n as number;
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, SONG.pack));
  const resealed = await db.tx((tx) => sealFacts(fresh, tx, SONG.scope, active!.factsKnownAt));
  const factsRederiveOk = resealed.digest === active!.factsDigest;

  const disputeFlowOk = await disputeFlow(db, ctx, clock, u);
  return {
    issued: snaps.length, p50Ms: pct(times, 50), p95Ms: pct(times, 95), maxMs: times[times.length - 1]!, totalMs,
    distinctProjections, distinctVectorSets, auditMismatches, factsRederiveOk, disputeFlowOk,
  };
}

/** 분쟁 → 자동 일시정지·발행 거부 → 종결 → 가벼운 재고정 → 재활성화 → 발행(통합 설계 9.4). */
async function disputeFlow(db: Db, ctx: BridgeCtx, clock: ReturnType<typeof fixedClock>, u: Record<string, Actor>): Promise<boolean> {
  const expectCode = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
      return false;
    } catch (e) {
      return e instanceof DomainError && e.code === code;
    }
  };
  const input = { packId: SONG.pack, vcId: "vc_dispute", assignments: SONG.slots.map((s) => ({ slotId: s.id, stemId: `stm_b_${s.id}` })), members: { pty_member_b: 10000 } };
  await db.tx((tx) => openDispute(tx, clock, { disputeId: "dsp_scenario", targetType: "RIGHT_CLAIM", targetId: "c_own_b", reason: "scenario" }));
  await processOutbox(db, issuance.OUTBOX_HANDLERS, clock);
  const paused = (await db.pool.query("SELECT status FROM vocal_pack WHERE pack_id = $1", [SONG.pack])).rows[0].status === "PAUSED";
  const refused = await expectCode(db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer!, input)), "PACK_NOT_ACTIVE");
  await db.tx((tx) => closeDispute(tx, clock, { disputeId: "dsp_scenario" }));
  await db.tx((tx) => policy.rebindPolicy(ctx, tx, clock, u.activator!, "pol_nova_summer"));
  await db.tx((tx) => issuance.activatePack(ctx, tx, clock, u.activator!, SONG.pack));
  const seal = await db.tx((tx) => issuance.issue(ctx, tx, clock, u.issuer!, input));
  const active = await db.tx((tx) => policy.activePolicyForPack(tx, SONG.pack));
  return paused && refused && seal.factsDigest === active!.factsDigest;
}
```

`rights-core/src/scenario/main.ts`:
```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createDb } from "../platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../platform/dbadmin.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { runScenario } from "./run.ts";

const { values } = parseArgs({ options: { n: { type: "string", default: "10000" }, seed: { type: "string", default: "20260929" } } });
const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const blobRoot = mkdtempSync(join(tmpdir(), "rc-scenario-"));
try {
  const report = await runScenario({ db, ctx: createBridgeCtx(createFsBlobStore(blobRoot)) }, { n: Number(values.n), seed: Number(values.seed) });
  console.log(JSON.stringify({ ...report, p50Ms: +report.p50Ms.toFixed(2), p95Ms: +report.p95Ms.toFixed(2), maxMs: +report.maxMs.toFixed(2), totalMs: Math.round(report.totalMs) }, null, 2));
  const pass = report.auditMismatches === 0 && report.factsRederiveOk && report.disputeFlowOk;
  console.log(pass ? "SCENARIO PASS" : "SCENARIO FAIL");
  process.exitCode = pass ? 0 : 1;
} finally {
  await db.close();
  await fresh.drop();
  rmSync(blobRoot, { recursive: true, force: true });
}
```

(`toFixed`는 리포트 출력 서식에만 쓰는 부동소수이며 라이브러리 계산 경로가 아니다. 지연 측정값 자체가 밀리초 부동소수다.)

- [ ] **Step 4: 통과 확인**

Run: `cd rights-core && node --test test/scenario/scenario.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: scenario 2 PASS, 전체 fail 0, `TSC_OK`.

- [ ] **Step 5: 1만 조합 실행**

Run: `cd rights-core && npm run scenario 2>&1 | tail -15`
Expected: JSON 리포트와 마지막 줄 `SCENARIO PASS`. `issued` 10000(분쟁 흐름의 발행 1건은 감사 뒤에 일어나므로 세지 않는다), `distinctProjections` 10000, `distinctVectorSets` 81 이하, `auditMismatches` 0, `factsRederiveOk` true, `disputeFlowOk` true. p95가 100ms를 넘으면 리포트 값과 함께 원인(쿼리 수, blob 쓰기, 투영 계산)을 기록한다 — 테스트를 느슨하게 만들지 않는다.

- [ ] **Step 6: 결과 기록**

`02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` 끝에 다음 절을 추가한다(값은 Step 5의 실제 리포트로 채운다. 표의 모든 칸을 실제 값으로 쓴다):

```markdown
### 9.5 I-1 PoC 결과 (YYYY-MM-DD)

| 항목 | 결과 |
|---|---|
| 적합성 facts/001-basic 행 등록 → 봉인 digest 일치 | 통과 |
| 등록 순서 무관(시드 3개) | 통과 |
| 1만 조합 발행 | <issued>건, 총 <totalMs>ms |
| 발행 지연 p50 / p95 / max | <p50> / <p95> / <max> ms (목표 p95 ≤ 100ms: 충족/미충족) |
| 서로 다른 투영 digest / 서로 다른 벡터·경로 조합 | <distinctProjections>개 / <distinctVectorSets>개 |
| 발행 봉인 전수 재도출 불일치 | <auditMismatches>건 |
| facts 재봉인 대조 | 통과/실패 |
| 분쟁 → 일시정지 → 종결 → 재고정 → 재발행 | 통과/실패 |
| 실행 환경 | <macOS·Node·PostgreSQL 버전> |
```

- [ ] **Step 7: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/scenario/prng.ts rights-core/src/scenario/synthetic-song.ts rights-core/src/scenario/run.ts rights-core/src/scenario/main.ts \
  rights-core/test/scenario/scenario.test.ts "../02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md"
git commit -m "feat(rights-core): 합성 곡 1만 조합 시나리오 러너와 PoC 결과 기록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
