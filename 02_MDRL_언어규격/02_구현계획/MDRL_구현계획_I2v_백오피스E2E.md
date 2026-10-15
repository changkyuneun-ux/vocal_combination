# I-2v 백오피스 E2E 검증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rights-core(I-1·I-2a·I-2b) 전체 흐름(권리 등록 → 정책 → 팩·발행 → 매출 → 정산 → 원장 → 지급 → 명세)을 사람이 브라우저 백오피스만으로 처음부터 끝까지 조작해 검증할 수 있게 하고, 같은 흐름을 Playwright E2E로 자동 검증한다.

**Architecture:** rights-core에 (1) 모듈별 조회 API(각 모듈 `routes.ts` + 모듈 안 조회 쿼리, 공통 커서 페이지), (2) `RC_DEV=1`일 때만 붙는 개발 전용 모듈 `src/dev/`(가상 시계·개발 사용자·PSP 시뮬레이터·합성 곡 불러오기·검증 DB 초기화)를 더한다. 새 워크스페이스 `backoffice`(React + Vite + TypeScript, TanStack Query, react-router)가 Vite 프록시 `/api` → `127.0.0.1:8080`으로 rights-core를 부르고 모든 요청에 `x-actor`를 붙인다.

**Tech Stack:** 기존 rights-core(Node ≥ 24, TypeScript erasable syntax, Fastify 5, pg 8, pg-boss 12, PostgreSQL 17 Docker). backoffice: React 19, react-router 7, @tanstack/react-query 5, Vite 7, TypeScript 5.9, Vitest 3, @playwright/test 1.5x.

**상위 스펙(정본):** `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` **12절(결정 1~8, 완료 기준 12.3)**. 기존 동작은 9~11절. 모든 태스크의 요구사항은 12.2의 해당 결정 번호를 따른다.

## Global Constraints

- 작업 디렉터리 `/Users/changkyuneun/Vocal Combination/03_구현문서_코드` (git 루트 `/Users/changkyuneun/Vocal Combination`). 무관한 커밋 안 된 변경이 많다. `git add`는 태스크 파일만, `git stash`·`git reset`·`git checkout -- <path>` 금지. 임시 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- rights-core: TypeScript erasable syntax만, 상대 import는 `.ts`, 타입 전용은 `import type`. `mdrl` import는 `src/engine-bridge/`에만. 기존 의존 방향(revenue ↛ settlement, ledger ↛ settlement·payout, payout ↛ settlement)을 지킨다. **새 규칙**: `src/dev/` 밖에서 `src/dev/`를 import할 수 있는 파일은 `src/http/server.ts`(타입·`devRoutes` 등록)와 `src/http/assemble.ts`뿐이다(아키텍처 테스트 추가).
- 서비스는 `Clock`을 받고 현재 시각을 직접 읽지 않는다. 시각은 밀리초 UTC ISO.
- 금액은 `BIGINT`/`bigint`, API 응답에서는 **10진 문자열**(예: `"1000000"`). 백오피스는 금액을 `BigInt`로만 계산하고 표시는 천 단위 구분 문자열.
- 조회 API는 상태를 바꾸지 않는다(SELECT만, 감사 로그도 쓰지 않는다). 응답 키는 camelCase, 시각은 ISO 문자열, NULL은 `null`.
- 목록 API 공통: `?limit=`(1~200, 기본 50, 어긋나면 400) + `?after=`(불투명 커서), 응답 `{ items: T[], next: string | null }`. 정렬은 엔드포인트마다 명시한 키, 커서는 마지막 행의 정렬 키.
- 개발 기능은 `RC_DEV=1`에서만 등록한다(아니면 `/dev/*` 404). 개발 DB 이름은 정확히 `rights_core_dev`.
- 오류 → HTTP는 기존 `server.ts` 규칙. 새 오류 코드: `CLOCK_REGRESSED`(409), `CLOCK_AHEAD_OF_REAL`(409), `DEV_ONLY`(시작 거부 메시지), `BAD_CURSOR`(400).
- backoffice: 상태 관리 라이브러리·UI 라이브러리 없음(CSS 변수). `localStorage`에는 선택한 사용자 id(`rc.actor`)만 저장하고 접근은 try/catch로 감싼다. 백엔드 오류는 `{code, message, diagnostics}`를 그대로 보여 준다.
- 테스트: `docker compose up -d`. rights-core `npm test`(파일 경로 지정 가능, 디렉터리 형태는 실패) · `npx tsc -p tsconfig.json`. backoffice `npm test -w backoffice`(Vitest) · `npm run typecheck -w backoffice` · `npm run e2e -w backoffice`(Playwright). 기존 rights-core 232개·mdrl 278개·`npm run scenario -- --settle 30000`·`npm run smoke -w mdrl`이 계속 통과해야 한다.

## File Structure

```
04_구현_소스코드/
  package.json                         (Modify: workspaces에 "backoffice", 스크립트 "dev")
  rights-core/
    package.json                       (Modify: "dev:db", "dev" 스크립트)
    migrations-dev/dev_0001_clock.sql  (dev_clock — 개발 DB에만)
    src/platform/paging.ts             (커서 페이지 공통)
    src/platform/actor.ts              (Modify: requireAnyRole)
    src/platform/routes.ts             (GET /me, /users, /audit)
    src/dev/env.ts                     (개발 환경 검사)
    src/dev/clock.ts                   (가상 시계)
    src/dev/users.ts                   (개발 사용자)
    src/dev/psp.ts                     (PSP 시뮬레이터 규칙·요청 기록)
    src/dev/reset.ts                   (검증 DB 초기화)
    src/dev/routes.ts                  (/dev/* 라우트)
    src/dev/setup-db.ts                (npm run dev:db)
    src/dev/main.ts                    (npm run dev — 개발 서버 진입점)
    src/registry/queries.ts, src/policy/queries.ts, src/issuance/queries.ts, src/revenue/queries.ts,
    src/settlement/queries.ts, src/ledger/queries.ts, src/payout/queries.ts   (조회 쿼리)
    src/*/routes.ts                    (Modify: GET 라우트 추가)
    src/http/server.ts                 (Modify: Deps.dev, platformRoutes·devRoutes 등록)
    test/dev/*.test.ts, test/http/read-*.test.ts, test/platform/paging.test.ts
    test/engine-bridge/architecture.test.ts (Modify: dev 규칙)
  backoffice/
    package.json, tsconfig.json, vite.config.ts, index.html, playwright.config.ts
    src/main.tsx, src/app/{App,Layout,Header,routes}.tsx, src/app/actor.ts
    src/api/{client,types,hooks}.ts
    src/components/{DataTable,Pager,Form,ErrorPanel,StatusBadge,Money,Digest,Instant,Section}.tsx
    src/format.ts, src/format.test.ts
    src/pages/{dashboard,registry,policy,issuance,revenue,settlement,ledger,payout,statements,dev}/*.tsx
    src/styles.css
    e2e/{fixtures,golden-path,rejections,contract}.spec.ts
.claude/launch.json                    (Create/Modify: rights-core-dev, backoffice)
02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md (Task 12: 12.4 결과)
```

---

### Task 1: 개발 환경·가상 시계·개발 DB·개발 서버

**Files:**
- Create: `rights-core/migrations-dev/dev_0001_clock.sql`, `rights-core/src/dev/env.ts`, `rights-core/src/dev/clock.ts`, `rights-core/src/dev/users.ts`, `rights-core/src/dev/routes.ts`, `rights-core/src/dev/setup-db.ts`, `rights-core/src/dev/main.ts`, `rights-core/test/dev/clock.test.ts`, `rights-core/test/dev/env.test.ts`, `rights-core/test/dev/helpers.ts`
- Modify: `rights-core/src/http/server.ts`(`Deps.dev`, dev 라우트 등록), `rights-core/package.json`, `rights-core/test/engine-bridge/architecture.test.ts`

**Interfaces (Produces):**
```ts
// dev/env.ts
export const DEV_DB_NAME = "rights_core_dev";
/** RC_DEV=1이면 DATABASE_URL의 DB 이름이 rights_core_dev이고 RC_PSP가 비었거나 "fake"여야 한다. 아니면 throw Error("DEV_ONLY: ..."). RC_DEV가 "1"이 아니면 false. */
export function devModeFromEnv(env: Readonly<Record<string, string | undefined>>): boolean;
// dev/clock.ts
export const DEV_CLOCK_START = "2026-01-01T00:00:00.000Z";
export type DevClock = Clock & {
  state(): { now: string; realNow: string; headroomMs: number };
  advance(tx: Tx, ms: number): Promise<string>;   // 새 가상 시각
  set(tx: Tx, at: string): Promise<string>;
  reload(tx: Tx): Promise<void>;                  // dev_clock 행을 다시 읽는다(초기화 뒤)
};
/** realNow는 테스트용 주입(기본 () => Date.now()). */
export async function loadDevClock(db: Db, realNow?: () => number): Promise<DevClock>;
// dev/users.ts
export const DEV_USERS: readonly { userId: string; displayName: string; roles: Role[] }[];
export async function ensureDevUsers(tx: Tx, clock: Clock): Promise<void>;   // 없으면 만들고 시스템 신원도 보장(멱등, advisory lock)
// dev/routes.ts
export type DevDeps = { clock: DevClock; psp: DevPsp; adminUrl: string; blobDir: string };   // DevPsp는 Task 2
export function devRoutes(app: FastifyInstance, deps: Deps & { dev: DevDeps }): void;
// http/server.ts
export type Deps = { ...기존; dev?: DevDeps };   // dev가 있으면 buildServer가 devRoutes를 등록
```

**Requirements (12.2-5·6·7):**
- `dev_0001_clock.sql`:
```sql
-- 개발 DB 전용(운영 npm run migrate는 적용하지 않는다 — 통합 설계 12.2-6).
CREATE TABLE dev_clock (
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  base_at     TIMESTAMPTZ NOT NULL CHECK (date_trunc('milliseconds', base_at) = base_at),
  set_real_at TIMESTAMPTZ NOT NULL
);
INSERT INTO dev_clock (base_at, set_real_at) VALUES ('2026-01-01T00:00:00.000Z', now());
GRANT SELECT, UPDATE ON dev_clock TO rc_app;
```
- 가상 시각 = `base_at + (realNow − set_real_at)`(밀리초 절사, ISO). `now()`는 동기 함수이므로 상태를 메모리에 두고, `advance`·`set`은 같은 트랜잭션에서 `dev_clock`을 `FOR UPDATE`로 잠그고 갱신한 뒤 메모리를 바꾼다(커밋 실패 시 메모리를 바꾸지 않도록 `db.tx` 반환 뒤 반영).
- `set(at)`: `at` < 현재 가상 시각이면 409 `CLOCK_REGRESSED`, `at` > realNow이면 409 `CLOCK_AHEAD_OF_REAL`, 형식이 밀리초 UTC ISO가 아니면 422 `INVALID_INSTANT`. `advance(ms)`: `ms`는 양의 정수(아니면 400 `BAD_REQUEST`), 결과는 `set(now + ms)`와 같다.
- `devModeFromEnv`: `RC_DEV`가 `"1"`이 아니면 `false`. `"1"`이면 `new URL(DATABASE_URL).pathname === "/rights_core_dev"`이고 `RC_PSP`가 비었거나 `"fake"`, 그리고 `RC_ADMIN_URL`이 있어야 `true`, 아니면 `Error("DEV_ONLY: …")`(어긋난 항목을 메시지에).
- `DEV_USERS`(12.2-2): `usr_editor`(RIGHTS_EDITOR, EDITOR), `usr_approver`(WORK_APPROVER), `usr_activator`(ACTIVATOR), `usr_issuer`(ISSUER), `usr_ops`(SPACE_OPS), `usr_settle`(SPACE_SETTLE), `usr_settle2`(SPACE_SETTLE). 표시 이름은 한국어 역할명(예: `"편집자"`, `"승인자"`, `"활성화 담당"`, `"발행 담당"`, `"정산 운영"`, `"정산 담당"`, `"정산 담당 2"`). `ensureDevUsers`는 `pg_advisory_xact_lock(hashtext('rc.dev_users'))` 후 없는 사용자만 `createUser`, 마지막에 `ensureSystemIdentities`.
- 라우트(`devRoutes`, `x-actor` 불필요 — 개발 도구): `GET /dev/clock` → `{now, realNow, headroomMs}`, `POST /dev/clock/advance {ms}`, `POST /dev/clock/set {at}` → `{now}`.
- `setup-db.ts`(`npm run dev:db`): `RC_ADMIN_URL`(기본 `postgres://rc:rc@localhost:54329/rights_core`)의 서버에 `rights_core_dev`가 없으면 `CREATE DATABASE`, 그 DB에 `runMigrations(adminUrlForDev)`(운영 스크립트 재사용) 뒤 `migrate(client, MIGRATIONS_DEV_DIR)`. 두 번 실행해도 안전. 출력: 적용한 마이그레이션 목록.
- `dev/main.ts`(`npm run dev`): 환경 기본값 `RC_DEV=1`, `DATABASE_URL=postgres://rc_app:rc_app@localhost:54329/rights_core_dev`, `RC_ADMIN_URL=postgres://rc:rc@localhost:54329/rights_core_dev`, `RC_PSP=fake`, `RC_PSP_SECRET=dev-secret`(이미 있으면 그 값). `devModeFromEnv` 검사 → `loadDevClock` → `ensureDevUsers` → 기존 `http/main.ts`와 같은 조립(작업 핸들러·outbox 폴러·서버)을 `clock: devClock`, `provider: devPsp.provider`(Task 2 전까지는 `fakeProvider()`), `dev: {...}`로 한다. 조립 코드 중복을 피하려고 `http/main.ts`의 조립 부분을 `src/http/assemble.ts`의 `startServer(opts: { url, clock, provider, pspSecret?, dev?, port })`로 빼고 두 진입점이 부른다(`http/main.ts`의 동작은 그대로).
- `package.json`: `"dev:db": "node src/dev/setup-db.ts"`, `"dev": "node src/dev/main.ts"`.
- 아키텍처 테스트: `src/` 아래에서 `src/dev/`와 `src/http/assemble.ts`·`src/http/server.ts`를 뺀 파일이 `/dev/`를 import하면 실패.
- `test/dev/helpers.ts`: `freshDevDb()` = `freshDb()` + `adminUrl`로 `migrate(c, MIGRATIONS_DEV_DIR)` 적용. 이후 dev 테스트가 쓴다.

**Tests:**
```ts
// test/dev/clock.test.ts (발췌 — 모든 케이스를 이 형태로)
const real = { t: Date.parse("2026-09-30T00:00:00.000Z") };
const { db, drop } = await freshDevDb();
const clock = await loadDevClock(db, () => real.t);
after(drop);
test("starts at DEV_CLOCK_START and flows with real time", async () => {
  // dev_clock.set_real_at은 마이그레이션 때의 now()이므로 먼저 set으로 기준을 고정한다
  await db.tx((tx) => clock.set(tx, "2026-01-01T00:00:00.000Z"));
  real.t += 1500;
  assert.equal(clock.now(), "2026-01-01T00:00:01.500Z");
});
test("advance moves forward and persists", async () => {
  const at = await db.tx((tx) => clock.advance(tx, 86_400_000));
  const again = await loadDevClock(db, () => real.t);
  assert.equal(again.now(), at);
});
test("set backwards is CLOCK_REGRESSED", async () => {
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-01-01T00:00:00.000Z")), { code: "CLOCK_REGRESSED" });
});
test("cannot pass real time", async () => {
  await assert.rejects(db.tx((tx) => clock.set(tx, "2026-10-01T00:00:00.000Z")), { code: "CLOCK_AHEAD_OF_REAL" });
});
```
- `env.test.ts`: `RC_DEV` 없음 → false; `RC_DEV=1` + DB `rights_core` → throw `/DEV_ONLY/`; `RC_PSP=stripe` → throw; 정상 → true.
- HTTP: `buildServer({... dev})`로 `/dev/clock` 200, `dev` 없이 `/dev/clock` 404; `/dev/clock/advance {ms: -1}` 400.
- `ensureDevUsers` 두 번 호출 → 사용자 7명 + 시스템 3명, 중복 없음.

- [ ] **Step 1:** 위 테스트를 작성하고 실패를 확인한다(`node --test test/dev/clock.test.ts test/dev/env.test.ts`).
- [ ] **Step 2:** 마이그레이션·`env.ts`·`clock.ts`·`users.ts`·`routes.ts`·`server.ts` 변경을 구현해 통과시킨다.
- [ ] **Step 3:** `assemble.ts`로 조립을 빼고 `http/main.ts`·`dev/main.ts`·`setup-db.ts`·스크립트를 만든다. 수동 확인: `npm run dev:db -w rights-core` 두 번(두 번째 적용 0) → `npm run dev -w rights-core` → `curl -s localhost:8080/dev/clock`이 `2026-01-01T…`. 서버를 끈다.
- [ ] **Step 4:** 아키텍처 테스트 추가, `npm test`(전체) · `npx tsc -p tsconfig.json` 통과.
- [ ] **Step 5:** 커밋 `feat(rights-core): 개발 모드 — 가상 시계, 개발 사용자, 개발 DB·서버`.

---

### Task 2: 개발 도구 — PSP 시뮬레이터·합성 곡 불러오기·검증 DB 초기화

**Files:**
- Create: `rights-core/src/dev/psp.ts`, `rights-core/src/dev/reset.ts`, `rights-core/test/dev/psp.test.ts`, `rights-core/test/dev/reset-seed.test.ts`
- Modify: `rights-core/src/dev/routes.ts`, `rights-core/src/dev/main.ts`

**Interfaces:**
- Consumes: `fakeProvider({ outcome })`, `FakeOutcome`(`payout/fake-provider.ts`), `recordWebhook`(payout 서비스 — webhook 경로가 쓰는 함수), `seedSyntheticSong`, `SONG`(`scenario/synthetic-song.ts`), `ensureDevUsers`, `DevClock.reload`.
- Produces:
```ts
// dev/psp.ts
export type DevOutcome = "PAID" | "FAILED" | "UNKNOWN";
export type DevPsp = {
  provider: PayoutProvider;                                   // 서버에 주입
  setOutcome(instructionId: string, o: DevOutcome): void;     // 그 지시의 첫 submit 전에만 의미 있음
  setPartyOutcome(partyId: string, o: DevOutcome): void;      // 그 권리자의 이후 지시들(지시별 지정이 우선)
  outcomes(): { byInstruction: Record<string, DevOutcome>; byParty: Record<string, DevOutcome> };
  requests(): { at: string; op: "submit" | "status"; instructionId: string; key: string; result: string }[];
  webhookFor(instructionId: string): { providerEventId: string; providerRef: string; status: "PAID" | "FAILED" };  // 아직 전송 안 했으면 throw DomainError("NOT_SUBMITTED", 409)
  reset(): void;
};
export function createDevPsp(clock: Clock): DevPsp;
// dev/routes.ts — 작업 일시정지(거부 경로 ACCOUNT_CHANGED 재현용)
export type DevJobs = { pause(name: JobName): Promise<void>; resume(name: JobName): Promise<void>; paused(): JobName[] };
// DevDeps에 jobs: DevJobs 추가. dev/main.ts가 BossJobs와 핸들러 표로 만든다(pause = 그 큐만 offWork, resume = 같은 핸들러로 다시 work).
// dev/reset.ts
export async function resetDevDatabase(adminUrl: string): Promise<{ truncated: string[] }>;
```

**Requirements (12.2-5):**
- `createDevPsp`: `fakeProvider({ outcome: (i) => map(byInstruction[i.instructionId] ?? byParty[i.partyId] ?? "PAID") })`, `UNKNOWN` → `UNKNOWN_THEN_PAID`. submit·status 호출을 감싸 `requests`에 기록(결과 status 문자열). `webhookFor`는 내부 fake의 `webhook("payout:" + instructionId)`.
- `pg-boss` 작업 일시정지: `BossJobs`에 `offWork(name)`가 없으면 `src/platform/jobs.ts`의 `startBossJobs`가 돌려주는 객체에 `pause(name)`·`resume(name)`을 추가한다(pg-boss `offWork(name)`·그 큐만 `work` 재등록). 운영 경로는 이 함수를 부르지 않는다.
- 라우트:
  - `GET /dev/psp/requests` → `{ items }`(최근 순), `GET /dev/psp/outcomes` → `{ byInstruction, byParty }`, `PUT /dev/psp/outcomes/:instructionId {outcome}`, `PUT /dev/psp/outcomes/party/:partyId {outcome}`(그 밖 값 400).
  - `POST /dev/jobs/pause {name}`·`POST /dev/jobs/resume {name}`(`JOB_NAMES`에 없는 이름 400), `GET /dev/jobs` → `{ paused }`. 초기화(`/dev/reset`)는 모든 일시정지를 푼다.
  - `POST /dev/psp/webhook {instructionId, repeat?}`(`repeat` 1~5, 기본 1): `webhookFor`로 본문을 만들고 **실제 `/psp/webhook` 라우트를** `app.inject`로 `x-psp-secret: deps.pspSecret`을 붙여 `repeat`번 보낸다. 응답 `{ responses: [{statusCode, body}] }`.
  - `POST /dev/seed/synthetic-song`: `usr_editor`로 `seedSyntheticSong` 실행(이미 `pty_label`이 있으면 409 `ALREADY_SEEDED`). 응답 `{ packId: SONG.pack, factsScopeId: SONG.scope, policyId: "pol_nova_summer", policyText: SONG.policyText }`. 정책 컴파일·승인·활성화와 팩 활성화는 하지 않는다. 시드 시각은 가상 시계(초기 2026-01-01, `validFrom` T0와 같거나 늦음).
  - `POST /dev/reset`: `resetDevDatabase(adminUrl)` → `DevClock`을 `DEV_CLOCK_START`로 되돌림(이 경로만 역행 허용 — `dev_clock`을 관리자 연결로 다시 쓴 뒤 `reload`) → `devPsp.reset()` → `ensureDevUsers`. 응답 `{ ok: true, clock }`.
- `resetDevDatabase`: 관리자 연결에서 DB 이름이 `rights_core_dev`인지 다시 확인(아니면 throw). `public` 스키마의 모든 테이블 중 `schema_migrations`를 뺀 것을 `TRUNCATE … RESTART IDENTITY CASCADE`(TRUNCATE는 행 트리거를 부르지 않으므로 추가 전용 트리거를 우회한다 — 개발 DB만), `DELETE FROM pgboss.job`, `dev_clock`을 `(DEV_CLOCK_START, now())`로 다시 넣고, `payout_policy` 기본 행처럼 마이그레이션이 넣은 시드 행을 마이그레이션 파일과 같은 SQL로 다시 넣는다(구현 전에 `migrations/*.sql`에서 `INSERT INTO`를 모두 찾아 목록화하고 `reset.ts`에 같은 값으로 둔다 — 테스트가 초기화 전후 시드 행이 같은지 비교). 봉인 blob 디렉터리는 내용 주소라 지우지 않는다.

**Tests:**
- PSP: 지시 3개를 만든 상태(Task 1의 HTTP 세계 + `settlement-fixtures`로 확정·프로필·지급 실행)에서 outcome `FAILED`·`UNKNOWN`·기본을 지정 → `submit-payout` drain → 지시 상태 `FAILED`·`SUBMITTED`(재조회 대기)·`SUBMITTED`; `/dev/psp/webhook {repeat: 2}` → 첫 응답 200 처리, 두 번째 200 중복 무시(inbox 행 1개); 전송 전 지시의 webhook → 409 `NOT_SUBMITTED`. 권리자별 지정: 지급 실행 **전에** `PUT /dev/psp/outcomes/party/:partyId FAILED` → 그 권리자 지시 `FAILED`, 지시별 지정이 권리자 지정보다 우선.
- 작업 일시정지(`test/dev/jobs-pause.test.ts`, 실제 pg-boss — `test/platform/jobs.test.ts`의 실제 워커 준비를 참고): `submit-payout` pause 중 보낸 작업이 2초 동안 처리되지 않고 resume 뒤 처리, 다른 큐는 계속 처리.
- 초기화·시드: 시드 → 409 재시드 → 초기화 → `party` 0행·`payout_policy` 시드 행 동일·사용자 10명·시계 `DEV_CLOCK_START` → 다시 시드 201. `resetDevDatabase`에 DB 이름이 다른 URL → throw.
- 이 테스트는 `rights_core_dev`가 아니라 테스트 DB에서 돈다: `resetDevDatabase(adminUrl, { allowName })` 대신 **이름 검사 함수를 분리**(`assertDevDbName(name, allowed = DEV_DB_NAME)`)하고 테스트는 `resetTables(adminUrl)`(이름 검사 없는 내부 함수)를 직접 부른다. 라우트는 반드시 `resetDevDatabase`(검사 포함)를 쓴다.

- [ ] **Step 1:** 테스트 작성 → 실패 확인.
- [ ] **Step 2:** `psp.ts`·`reset.ts`·라우트 구현, `dev/main.ts`가 `createDevPsp(devClock)`를 provider로 주입.
- [ ] **Step 3:** 수동: `npm run dev -w rights-core` → `curl -X POST localhost:8080/dev/seed/synthetic-song` 201 → `curl -X POST localhost:8080/dev/reset` → 다시 시드 201.
- [ ] **Step 4:** `npm test` · `tsc` 통과.
- [ ] **Step 5:** 커밋 `feat(rights-core): 개발 도구 — PSP 시뮬레이터, 작업 일시정지, 합성 곡 불러오기, 검증 DB 초기화`.

---

### Task 3: 조회 API 공통·플랫폼·권리·정책·팩/발행

**Files:**
- Create: `rights-core/src/platform/paging.ts`, `rights-core/src/platform/routes.ts`, `rights-core/src/registry/queries.ts`, `rights-core/src/policy/queries.ts`, `rights-core/src/issuance/queries.ts`, `rights-core/test/platform/paging.test.ts`, `rights-core/test/http/read-rights.test.ts`
- Modify: `rights-core/src/platform/actor.ts`, `rights-core/src/registry/routes.ts`, `rights-core/src/policy/routes.ts`, `rights-core/src/issuance/routes.ts`, `rights-core/src/http/server.ts`

**Interfaces (Produces):**
```ts
// platform/paging.ts
export type Page = { limit: number; after: unknown[] | undefined };
export function parsePage(q: Record<string, unknown>): Page;           // limit 1~200 기본 50, after = base64url(JSON 배열); 어긋나면 400 BAD_REQUEST / BAD_CURSOR
export function pageOf<R>(rows: R[], page: Page, key: (r: R) => unknown[]): { items: R[]; next: string | null };
// 쿼리는 LIMIT page.limit + 1로 읽고 pageOf가 잘라 next를 만든다.
export function encodeCursor(key: unknown[]): string;
// platform/actor.ts
export function requireAnyRole(actor: Actor, roles: readonly Role[]): void;   // 하나도 없으면 403 ROLE_REQUIRED
```

**Requirements (12.2-4):** 역할: 이 태스크의 조회는 **로그인한 누구나**(`withActor`만, 역할 검사 없음).

| 엔드포인트 | 정렬(커서 키) | 항목 필드 |
|---|---|---|
| `GET /me` | — | `{userId, displayName, roles}` |
| `GET /users` | `user_id` | `{userId, displayName, roles}` (시스템 신원 포함) |
| `GET /audit?entityType=&entityId=&actor=` | `audit_id DESC` | `{auditId, occurredAt, actor, action, entityType, entityId, after}` (역할: SPACE_OPS·SPACE_SETTLE·RIGHTS_EDITOR 중 하나) |
| `GET /parties?type=` | `party_id` | `party` 전 컬럼 |
| `GET /works` | `work_id` | `work` 전 컬럼 |
| `GET /scopes/:id` | — | `facts_scope` 전 컬럼(`sealedThrough` 포함) + `latestFactsSeal: {digest, knownAt} \| null` |
| `GET /scopes/:id/facts` | — | `{recordings, slots, stems, voices, claims, mandates, disputes}` 각 배열(해당 범위의 행 전 컬럼, 각 정렬은 id) |
| `GET /disputes?status=&scope=` | `opened_at DESC, dispute_id` | `dispute` 전 컬럼 |
| `GET /policies?pack=` | `policy_id` | `{policyId, packId, latestVersion, activeVersion \| null}` |
| `GET /policies/:id/versions` | `version DESC` | `policy_version`에서 `source_text`를 뺀 컬럼 + 승인 여부·승인자(`attestation`에서) |
| `GET /policies/:id/versions/:v` | — | `policy_version` 전 컬럼 + `approvals: [{userId, role, at}]` |
| `GET /packs` | `pack_id` | `vocal_pack` 전 컬럼 |
| `GET /packs/:id` | — | `vocal_pack` + `claimants`(pack_claimant 행) + `activePolicy: {policyId, version} \| null` |
| `GET /issues?pack=&vc=` | `created_at DESC, snapshot_id` | `rights_snapshot` 전 컬럼 + `issue_seal` 다이제스트들 + `quarantined: boolean` (격리는 settlement의 테이블이지만 이 조회는 issuance 쿼리에서 `quarantine`을 SQL로만 읽는다 — import 의존 없음) |

- 없는 id → 404 `NOT_FOUND`. `NOT_FOUND`는 기존에 쓰는 코드인지 `src/` 검색으로 확인하고 같은 형태(`DomainError("NOT_FOUND", 404, …)`)로 쓴다.
- 각 쿼리 함수는 `(tx: Tx, filters, page) => Promise<{items, next}>`이고 그 모듈의 `queries.ts`에 둔다. 행 → camelCase 변환은 각 쿼리에서 명시적으로(자동 변환 유틸 금지 — 응답 계약을 코드에서 읽을 수 있게).
- 실제 컬럼·테이블 이름은 마이그레이션에서 확인한다(예: `attestation`의 승인 표현). 표에 없는 컬럼을 지어내지 않는다.

**Tests:** `settlementWorld()`(곡·정책·팩 활성)에서 `buildServer` + `app.inject`로 각 엔드포인트의 200·필드·필터. `paging.test.ts`: `limit=0`·`201`·`abc` → 400, 깨진 커서 → 400 `BAD_CURSOR`, 7행을 `limit=3`으로 끝까지 넘기면 3·3·1이고 마지막 `next = null`, 중복·누락 없음. `x-actor` 없음 → 401. `/audit`을 `usr_issuer`로 → 403.

- [ ] **Step 1~5:** 테스트 → 실패 → 구현 → 전체 `npm test`·`tsc` → 커밋 `feat(rights-core): 조회 API — 페이지 공통, 플랫폼·권리·정책·팩/발행`.

---

### Task 4: 조회 API — 매출·정산·원장·지급

**Files:**
- Create: `rights-core/src/revenue/queries.ts`, `rights-core/src/settlement/queries.ts`, `rights-core/src/ledger/queries.ts`, `rights-core/src/payout/queries.ts`, `rights-core/test/http/read-money.test.ts`
- Modify: `rights-core/src/revenue/routes.ts`, `rights-core/src/settlement/routes.ts`, `rights-core/src/ledger/routes.ts`, `rights-core/src/payout/routes.ts`

**Interfaces:** Consumes `parsePage`·`pageOf`·`requireAnyRole`(Task 3).

**Requirements (12.2-4):** 역할: 매출·정산 조회는 `SPACE_OPS` 또는 `SPACE_SETTLE`, 원장·지급 조회는 `SPACE_SETTLE`(기존 원장 라우트와 같음). 매출 조회는 시스템 신원(`SYSTEM`)도 허용(수집 담당이 자기 기록을 본다).

| 엔드포인트 | 정렬 | 항목 필드 |
|---|---|---|
| `GET /revenue-events?type=&vc=` (revenue 라우트·쿼리) | `recorded_at DESC, event_id` | `revenue_event` 전 컬럼 + `supersededBy: string \| null`(`revenue_supersede`) |
| `GET /revenue-events/:id/settlement` (settlement 라우트·쿼리 — revenue는 settlement를 모르므로 정산 상태는 따로 준다) | — | `{runs: [{runId, batchId, status}], reversals: [{reversalId, createdAt}], refunds: [{eventId, netAmountKrw}]}` (refunds = 이 이벤트를 `related_event_id`로 가리키는 환불) |
| `GET /batches?status=` | `created_at DESC, batch_id` | `settlement_batch` 전 컬럼 + `runCounts: {PENDING, CALCULATED, VERIFIED, FAILED, VOIDED, CONFIRMED}` |
| `GET /batches/:id/runs?status=` | `run_id` | `settlement_run` 전 컬럼 + `eventCount` |
| `GET /quarantine?open=true` | `quarantine_id DESC` | `quarantine` 전 컬럼 |
| `GET /holds?status=&reason=` | `holding_id DESC` | `unallocated_holding` 전 컬럼 + `release: {releaseId, releasedBy, releasedAt} \| null` |
| `GET /reversals` | `created_at DESC, reversal_id` | `reversal_run` 전 컬럼 |
| `GET /ledger/accounts` | `account_id` | `ledger_account` 전 컬럼 + `balance`(문자열, 전기 합) |
| `GET /ledger/entries?kind=&account=&party=` | `entry_id DESC` | `journal_entry` 전 컬럼 + `total`(차변 합) |
| `GET /ledger/entries/:id` | — | `journal_entry` + `postings: [{postingId, accountId, amountKrw, eventId, runId}]` |
| `GET /payout-policy` | — | `payout_policy` 행 |
| `GET /parties/:id/payout-profile` | — | `party_payout_profile` 전 컬럼 + `coolingUntil: string \| null`(`account_changed_at + account_cooling_hours`) 또는 404 |
| `GET /payout-runs` | `created_at DESC, payout_run_id` | `payout_run` 전 컬럼 + `statusCounts` |
| `GET /payout-runs/:id/instructions?status=` | `instruction_id` | `payout_instruction` 전 컬럼 |
| `GET /payouts/:id` | — | `payout_instruction` + `webhooks`(`psp_webhook_inbox`에서 `provider_ref` 일치) + `audit`(`entity_id = instruction_id`인 감사 행) |

- 금액 컬럼은 모두 문자열. `diagnostics`·`allocation`·`payload` 같은 JSONB는 그대로.
- `ledger/queries.ts`는 settlement·payout을 import하지 않는다. `payout/queries.ts`는 settlement를 import하지 않는다(기존 아키텍처 테스트가 검사).

**Tests:** `settlementWorld()`에서 매출 2건(하나 `FLAGGED`) → 배치 → drain → 확정 → `post-batch` → 보류 해제 → 프로필 → 지급 실행 → submit drain(이 흐름은 `test/http/ledger-api.test.ts`의 앞부분과 같다 — 그 파일의 준비 코드를 참고해 같은 순서로 작성) 뒤 각 엔드포인트의 200·필드·필터·페이지. 역할 거부: `/ledger/accounts`를 `usr_ops`로 403, `/batches`를 `usr_issuer`로 403. 계정 잔액 합 = 0.

- [ ] **Step 1~5:** 테스트 → 실패 → 구현 → `npm test`·`tsc` → 커밋 `feat(rights-core): 조회 API — 매출·정산·원장·지급`.

---

### Task 5: 백오피스 골격 — 패키지·API 클라이언트·레이아웃·헤더

**Files:**
- Create: `backoffice/package.json`, `backoffice/tsconfig.json`, `backoffice/vite.config.ts`, `backoffice/index.html`, `backoffice/src/main.tsx`, `backoffice/src/styles.css`, `backoffice/src/app/{App,Layout,Header,routes}.tsx`, `backoffice/src/app/actor.ts`, `backoffice/src/api/{client,types,hooks}.ts`, `backoffice/src/components/{DataTable,Pager,Form,ErrorPanel,StatusBadge,Money,Digest,Instant,Section}.tsx`, `backoffice/src/format.ts`, `backoffice/src/format.test.ts`, `backoffice/src/pages/dashboard/Dashboard.tsx`(빈 자리), `.claude/launch.json`
- Modify: `04_구현_소스코드/package.json`

**Interfaces (Produces):**
```ts
// api/client.ts
export class ApiError extends Error { status: number; code: string; diagnostics: unknown[] }
export type Paged<T> = { items: T[]; next: string | null };
export function api<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T>;   // /api 접두, x-actor = currentActor(), 비2xx는 ApiError
export function devApi<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T>; // /api/dev/…, x-actor 없음
// app/actor.ts
export function currentActor(): string;          // localStorage "rc.actor", 기본 "usr_editor"
export function setActor(id: string): void;       // 저장 후 queryClient.invalidateQueries()
// api/hooks.ts
export function useList<T>(key: string, path: string, params?: Record<string, string | undefined>): { pages: T[]; next: string | null; loadMore(): void; ... };  // useInfiniteQuery
export function useGet<T>(key: unknown[], path: string, opts?: { refetchInterval?: number | false }): UseQueryResult<T, ApiError>;
export function useAction<I, O>(fn: (i: I) => Promise<O>, invalidate: string[]): UseMutationResult<O, ApiError, I>;
// format.ts
export function formatKrw(s: string): string;      // "1234567" → "1,234,567원", 음수 "−1,234원"
export function shortDigest(d: string): string;    // "mdrl:sha256:abcdef012345…" → "abcdef012345"
export function formatInstant(iso: string): string; // "2026-03-01 10:00:00.000Z" (UTC 그대로, 로캘 변환 안 함)
export function sumKrw(xs: string[]): string;       // BigInt 합
```

**Requirements (12.2-1·2·3·7):**
- `package.json`: `name: "backoffice"`, `type: module`, 스크립트 `dev`(vite, 포트 5173 고정 `--strictPort`), `build`, `typecheck`(`tsc -b --noEmit` 또는 `tsc -p tsconfig.json --noEmit`), `test`(vitest run), `e2e`(playwright test). 의존: react, react-dom, react-router, @tanstack/react-query. dev: vite, @vitejs/plugin-react, typescript, vitest, @playwright/test, @types/react, @types/react-dom. 설치는 루트에서 `npm install`(워크스페이스).
- `vite.config.ts`: `server.proxy['/api'] = { target: 'http://127.0.0.1:8080', rewrite: p => p.replace(/^\/api/, '') }`.
- 루트 `package.json`: workspaces에 `"backoffice"` 추가, `"dev": "npm run dev -w rights-core & npm run dev -w backoffice & wait"`.
- 헤더(12.2-3): 왼쪽 앱 이름 "MDRL 검증 백오피스", 가운데 **가상 시계**(`GET /dev/clock` 5초마다, 표시 `2026-01-01 00:00 UTC`, 버튼 `+1시간`·`+1일`·`+3일`·`+30일`, `지정…`(datetime 입력) — 실패 시 오류 코드 토스트), 오른쪽 **사용자 전환** `<select>`(`GET /users`, 표시 `표시 이름 (역할, 역할)`; 시스템 신원 포함) + **점검 배지**(`GET /settlement/invariants`를 `usr_settle`로 10초마다 — 현재 사용자와 무관하게 점검은 정산 담당 신원으로 읽는다: `api`에 `actorOverride` 옵션). 배지: 모든 항목 정상 → 초록 "점검 정상", 아니면 빨강 "점검 위반 N" → 클릭 시 위반 항목 목록 패널.
- 레이아웃: 왼쪽 메뉴(12.2-3의 0~9 그룹, 그룹 제목 + 화면 링크), 본문. 라우트 경로: `/`, `/registry/parties`, `/registry/assets`(곡/녹음/슬롯/스템/보이스), `/registry/claims`, `/registry/mandates`, `/registry/disputes`, `/policy`, `/policy/:policyId`, `/packs`, `/packs/:packId`, `/issues`, `/issues/:snapshotId`, `/revenue`, `/settlement/batches`, `/settlement/batches/:batchId`, `/settlement/runs/:runId`, `/settlement/quarantine`, `/settlement/holds`, `/ledger`, `/ledger/entries/:entryId`, `/payout/profiles`, `/payout/runs`, `/payout/runs/:payoutRunId`, `/payout/instructions/:instructionId`, `/statements`, `/dev/psp`, `/dev/data`. 이 태스크에서는 대시보드 외 화면을 "준비 중" 자리 컴포넌트로 둔다(Task 6~10이 채운다).
- 공통 컴포넌트:
  - `DataTable<T>({columns: {key, label, render?}[], rows, empty})`, `Pager({next, loadMore})`.
  - `Form({fields, onSubmit, submitLabel})` — 필드 종류 text·number·select·textarea·datetime, 필수 표시.
  - `ErrorPanel({error})` — `ApiError`면 `code` 굵게 + `message` + `diagnostics` JSON 접기, 다른 오류면 메시지.
  - `StatusBadge({status})` — 상태 → 색 매핑(성공류 초록, 진행류 파랑, 보류·이월 주황, 실패·무효 빨강).
  - `Money({krw})`, `Digest({value})`(앞 12자 + 복사 버튼), `Instant({iso})`, `Section({title, actions, children})`.
- 스타일: `styles.css`에 CSS 변수(`--bg`, `--fg`, `--muted`, `--line`, `--accent`, `--ok`, `--warn`, `--bad`, `--info`)와 v2.7 시안 비슷한 밀도(표 행 높이 32px, 13px 본문). 다크 모드는 `prefers-color-scheme`로 변수만 바꾼다.
- `.claude/launch.json`(git 루트 `/Users/changkyuneun/Vocal Combination/.claude/launch.json`, 있으면 항목 추가):
```json
{ "version": "0.0.1", "configurations": [
  { "name": "rights-core-dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev", "--prefix", "04_구현_소스코드/rights-core"], "port": 8080 },
  { "name": "backoffice", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev", "--prefix", "04_구현_소스코드/backoffice"], "port": 5173 }
] }
```

**Tests:** `format.test.ts`(Vitest): `formatKrw("0") = "0원"`, `formatKrw("-1234") = "−1,234원"`, `formatKrw("12345678901234567890")`(BigInt 정밀도), `shortDigest`, `sumKrw(["1","-3","10"]) = "8"`. `client`의 `ApiError` 파싱(가짜 `fetch` 주입으로 409 `{code:"RETRY"}` → `ApiError.code === "RETRY"`).

- [ ] **Step 1:** 패키지·설정 생성, `npm install`(루트).
- [ ] **Step 2:** `format.test.ts`·client 테스트 작성 → 실패 확인(`npm test -w backoffice`).
- [ ] **Step 3:** `format.ts`·`client.ts` 구현 → 통과. 나머지 골격(레이아웃·헤더·컴포넌트·라우트) 작성.
- [ ] **Step 4:** `npm run typecheck -w backoffice` 통과. 수동: rights-core dev 서버 + `npm run dev -w backoffice` → 브라우저에서 헤더의 시계 +1일 동작, 사용자 목록 10명, 점검 배지 초록(빈 DB). (컨트롤러가 브라우저로 확인한다 — 구현자는 `curl -s localhost:5173/api/dev/clock`로 프록시를 확인.)
- [ ] **Step 5:** 커밋 `feat(backoffice): 백오피스 골격 — API 클라이언트, 레이아웃, 사용자 전환·가상 시계·점검 배지`.

---

### Task 6: 화면 — 권리 등록·정책

**Files:**
- Create: `backoffice/src/pages/registry/{Parties,Assets,Claims,Mandates,Disputes}.tsx`, `backoffice/src/pages/policy/{Policies,PolicyDetail}.tsx`, `backoffice/src/api/registry.ts`, `backoffice/src/api/policy.ts`
- Modify: `backoffice/src/app/routes.tsx`, `backoffice/src/api/types.ts`

**Requirements (12.2-3 그룹 1·2):** 모든 실행 버튼은 현재 사용자로 호출하고, 실패하면 `ErrorPanel`을 그 폼 아래에 둔다. 성공하면 관련 목록을 다시 읽는다.
- 권리자: 목록(`GET /parties`, 유형 필터) + 등록 폼(`POST /parties`: partyId, partyType select — 값은 `registry/service.ts`의 `PartyType`에서 복사, displayName, isni, ipiNo).
- 곡/자산(`/registry/assets`): 곡 목록·등록(`POST /works`), facts 범위 선택(`GET /works` → 범위 id 입력 또는 범위 생성 `POST /scopes`), 선택한 범위의 `GET /scopes/:id`(봉인 상태: `sealedThrough`, 최근 facts 봉인 digest)와 `GET /scopes/:id/facts`의 녹음·슬롯·스템·보이스 표 + 각 등록 폼(`POST /recordings`·`/slots`·`/stems`·`/voices` — 요청 필드는 `registry/service.ts`의 각 함수 입력 타입 그대로).
- 권리·위임: 범위 선택 + 표 + 등록 폼(`POST /claims`·`/mandates` — 필수 필드는 `registry/routes.ts`의 required 목록, 선택 필드(performerRole, roleDetail 등)는 service 타입에서).
- 분쟁: 목록(`GET /disputes`) + 개시(`POST /disputes`) + 종결(`POST /disputes/:id/close`, 선택 resolution).
- 정책 목록: `GET /policies` + "새 정책" 버튼 → 편집기.
- 정책 상세/편집기(`/policy/:policyId`): 왼쪽 MDRL 텍스트 `<textarea>`(고정폭, 줄 번호 없음), 팩 id 입력, "합성 곡 정책 불러오기" 버튼(읽기 전용 `GET /dev/seed/synthetic-song`의 `policyText`·`packId`로 채운다 — 편집기는 시드하지 않는다. 팩이 아직 없으면 "개발 도구 > 개발 데이터에서 합성 곡을 먼저 불러오세요" 안내), "컴파일"(`POST /policies/:id/compile`, 실패 시 `diagnostics`를 표로 — 각 항목의 code·message·위치), 오른쪽 버전 목록(`GET /policies/:id/versions`) — 버전별 상태 배지·digest·승인자·"승인"(`…/approve`)·"활성화"(`…/activate`) 버튼, 정책 상단 "재고정"(`POST /policies/:id/rebind`). 승인·활성화를 같은 사용자로 누르면 백엔드 거부 코드가 그대로 보인다(12.2-8 거부 경로 2).

**Tests:** 이 태스크는 Vitest 단위 테스트를 강제하지 않는다(화면 검증은 Task 11 Playwright). 대신: `npm run typecheck -w backoffice` 통과 + 수동 확인 목록(구현자는 `curl`로 각 API가 화면이 보내는 본문으로 201을 주는지 확인하고, 컨트롤러가 브라우저로 화면을 확인한다): 합성 곡 시드 → 권리자 8명 표시 → 정책 불러오기 → 컴파일 → `usr_approver` 승인 → `usr_approver`로 활성화 시도 시 `ROLE_REQUIRED` → `usr_activator` 활성화.

- [ ] **Step 1~5:** API 래퍼·타입 → 화면 → typecheck → curl 확인 → 커밋 `feat(backoffice): 권리 등록·정책 화면`.

---

### Task 7: 화면 — 팩·발행·매출

**Files:**
- Create: `backoffice/src/pages/issuance/{Packs,PackDetail,Issues,IssueDetail,IssueForm}.tsx`, `backoffice/src/pages/revenue/Revenue.tsx`, `backoffice/src/api/issuance.ts`, `backoffice/src/api/revenue.ts`
- Modify: `backoffice/src/app/routes.tsx`, `backoffice/src/api/types.ts`

**Requirements (12.2-3 그룹 3·4):**
- 팩 목록(`GET /packs`)·생성(`POST /packs`). 팩 상세: 권리자 선언 표 + 편집(`PUT /packs/:id/claimants` — 역할 select 값은 `issuance/service.ts`의 `Declared` 타입에서), 활성 정책, "팩 활성화"(`POST /packs/:id/activate`).
- 발행 폼(`IssueForm`, 팩 상세 안): 팩의 범위에서 `GET /scopes/:id/facts`로 슬롯·스템을 읽어, **슬롯마다 스템 select**(그 슬롯의 스템, 권리 대상이 아닌 MR 슬롯도 포함). 멤버 비율 표: 선택된 스템의 `performer_party_id`별 슬롯 수에 비례한 bps(합 10000, 나머지는 party_id 오름차순 첫 멤버에) 자동 채움 + 수정 가능, 합이 10000이 아니면 발행 버튼 비활성. vcId 입력(기본 `vc_` + 선택 스템 id 요약). "발행"(`POST /issues`) — 422 `ISSUE_NOT_SETTLEABLE`이면 진단을 표로(거부 경로 1).
- 발행 목록(`GET /issues?pack=`): vcId, 정책 버전, digest들, 격리 배지. 발행 상세(`/issues/:snapshotId`): `GET /issues/:id/audit`의 봉인 묶음(facts·정책·조합 지분·멤버 digest, 각 `GET /seals/:digest` 링크), 분배 결과 표(조합 지분의 권리자별 몫), **재도출 대조** 결과(감사 응답에 재도출 일치 여부가 있으면 표시 — 응답 형태는 `issuance/routes.ts`·`http/seal-routes.ts`에서 확인).
- 매출(`/revenue`): 현재 사용자를 자동으로 `sys_ingest`로 바꾸지 **않는다**; 화면 상단에 "매출 입력은 수집 담당(sys_ingest)으로" 안내와 "sys_ingest로 전환" 버튼. 입력 폼 3종 탭:
  - 구매: eventId(기본 `ev_` + 시각), vcId(발행 목록에서 select), amountKrw, occurredAt(기본 가상 시계 현재), integrity(CLEAR·FLAGGED).
  - 환불: 원 이벤트 select(구매 목록), amountKrw(기본 원 순액 = 전액), occurredAt.
  - 정정: 원 이벤트 select, 새 sourceRevision(기본 최신 + 1), amountKrw.
  - 요청 본문은 `revenue/service.ts`의 `RevenueInput` 그대로(`sourceSystem: "app"`, `sourceEventId` 기본 = eventId).
  - 목록(`GET /revenue-events`, 유형·vc 필터): 행 펼침 시 `GET /revenue-events/:id/settlement`(run·역분개).

**Tests:** typecheck + curl 확인(Task 6과 같은 방식): 팩 활성화 → 2멤버 조합 발행 201 → 한 멤버가 4슬롯 모두 부른 조합 422 `ISSUE_NOT_SETTLEABLE` → 구매 2건(하나 FLAGGED)·환불 1건 201.

- [ ] **Step 1~5:** → 커밋 `feat(backoffice): 팩·발행·매출 화면`.

---

### Task 8: 화면 — 정산·원장

**Files:**
- Create: `backoffice/src/pages/settlement/{Batches,BatchDetail,RunDetail,Quarantine,Holds}.tsx`, `backoffice/src/pages/ledger/{Ledger,EntryDetail}.tsx`, `backoffice/src/api/settlement.ts`, `backoffice/src/api/ledger.ts`
- Modify: `backoffice/src/app/routes.tsx`, `backoffice/src/api/types.ts`

**Requirements (12.2-3 그룹 5·6):**
- 배치 목록(`GET /batches`) + 생성 폼(`POST /batches`: batchId, periodStart, periodEnd — 기본값은 가상 시계 기준 **지난달** 1일~이번 달 1일; `SPACE_OPS` 필요 안내).
- 배치 상세: 상태·manifest digest, run 상태별 건수 막대, run 표(`GET /batches/:id/runs`, 상태 필터) — `PENDING`·`CALCULATED`가 하나라도 있으면 **3초마다 갱신**(12.2-3 비동기 상태), "확정"(`POST /batches/:id/confirm`, 모든 run이 끝 상태일 때만 활성 — 아니면 비활성 + 이유), 확정 뒤 원장 반영 진행 표시(`GET /ledger/entries?kind=SETTLEMENT`의 개수와 확정 run 수 비교).
- run 상세(`GET /runs/:id`): 상태·digest·진단, 이벤트별 풀·라인·보류(응답 형태 그대로 표), "무효화"(`POST /runs/:id/void {reason}` — 사유 입력 1~500자), "재대기"(`POST /runs/:id/requeue`).
- 격리(`GET /quarantine`): 열린 격리 표 + "해제"(`POST /quarantine/:snapshotId/release`).
- 보류(`GET /holds`, 사유·상태 필터): 행마다 "해제 제안 보기"(`GET /holds/:id/suggestion` → 권리자별 배분 표) → 배분 편집 표(합 = 보류액일 때만 "해제" 활성) → `POST /holds/:id/release {allocation}`.
- 원장(`/ledger`): 상단 시산표(`GET /ledger/trial-balance` — 계정 종류별 묶음, 합계 0 확인 표시), 계정 표(`GET /ledger/accounts`, 잔액), 분개 목록(`GET /ledger/entries`, 종류·계정·권리자 필터). 분개 상세: 전기 표 + 합 = 0 표시.

**Tests:** typecheck + curl 확인: 가상 시계 다음 달 → 배치 생성 → run 모두 `VERIFIED` → `usr_settle` 확정 → 분개 수 = 확정 run 수 → FLAGGED 보류 제안대로 해제 → 시산표 합 0.

- [ ] **Step 1~5:** → 커밋 `feat(backoffice): 정산·원장 화면`.

---

### Task 9: 화면 — 지급·명세·개발 도구·대시보드

**Files:**
- Create: `backoffice/src/pages/payout/{Profiles,PayoutRuns,PayoutRunDetail,InstructionDetail}.tsx`, `backoffice/src/pages/statements/Statements.tsx`, `backoffice/src/pages/dev/{Psp,Data}.tsx`, `backoffice/src/api/payout.ts`, `backoffice/src/api/dev.ts`
- Modify: `backoffice/src/pages/dashboard/Dashboard.tsx`, `backoffice/src/app/routes.tsx`, `backoffice/src/api/types.ts`

**Requirements (12.2-3 그룹 0·7·8·9):**
- 지급 프로필(`/payout/profiles`): 미지급금 계정이 있는 권리자 목록(`GET /ledger/accounts`에서 `PARTY_PAYABLE`) × `GET /parties/:id/payout-profile`(없으면 "프로필 없음"). 편집 폼(`PUT /parties/:id/payout-profile` — 필드는 `payout/service.ts`의 `setPayoutProfile` 입력 그대로: taxType select, payoutAccountRef, kycVerified, firstPayableAt). **냉각 표시**: `coolingUntil`이 가상 시계보다 뒤면 주황 "냉각 중 ~ {coolingUntil}", 마지막 계좌 변경자 표시(직무 분리 안내: "이 사용자는 이 권리자의 지급을 실행할 수 없습니다").
- 지급 실행(`/payout/runs`): 목록(`GET /payout-runs`, 상태별 건수) + 실행 폼(`POST /payout-runs {payoutRunId, asOf}` — asOf 기본 = 가상 시계 현재). 실행 상세: 지시 표(`GET /payout-runs/:id/instructions`) — 상태·보류 사유(`hold_reason`)·총액·원천세·실지급, `PENDING`·`SUBMITTED`가 있으면 3초마다 갱신. 지시 상세(`GET /payouts/:id`): 표식들(전송 시도·불명·계좌 토큰), webhook 이력, 감사, "재전송"(`POST /payouts/:id/resubmit`), 개발 도구 바로가기("이 지시의 PSP 결과 지정").
- 명세(`/statements`): 권리자 select + 기간(from·to, 기본 2026-01-01 ~ 가상 시계 현재) → `GET /parties/:id/statements` 응답의 모든 항목을 항등식 순서로 표(기초 → 정산 → 역분개 → 해제 → 조정 → 지급 총액(실지급·원천세) → 실패 복원(원천세·실지급) → 기말). **대조 표시**: (1) 항등식 계산값 = 기말, (2) 기말 = `GET /ledger/accounts`의 그 권리자 `PARTY_PAYABLE` 잔액의 부호 반전(부채) — 둘 다 초록/빨강.
- 개발 도구 PSP(`/dev/psp`): 열린 지시(`GET /payout-runs` → 최근 실행의 `PENDING`·`SUBMITTED` 지시) 표 — 행마다 결과 select(PAID·FAILED·UNKNOWN, `PUT /dev/psp/outcomes/:id`), "webhook 보내기"(repeat 1·2 선택, `POST /dev/psp/webhook`) → 응답들 표시. 아래 PSP 요청 기록(`GET /dev/psp/requests`).
- 개발 도구 데이터(`/dev/data`): "합성 곡 불러오기"(`POST /dev/seed/synthetic-song`, 응답을 캐시 `["dev","seed"]`에 둔다), "검증 DB 초기화"(확인 대화상자 → `POST /dev/reset` → 모든 쿼리 무효화, 사용자를 `usr_editor`로).
- 대시보드(`/`): 단계별 건수 카드(권리자·활성 팩·발행·매출·배치/확정 run·분개·지급 지시 PAID), 최근 감사 20건(`GET /audit`, 정산 담당 신원으로 읽기), 점검 결과 요약, **권장 검증 순서 체크리스트** 11단계(12.2-8 순서) — 각 단계의 완료 여부를 데이터로 판정(예: 1 = 권리자 ≥ 1, 2 = 활성 정책 존재, 3 = 활성 팩, 4 = 발행 ≥ 1, 5 = 구매 ≥ 1 그리고 환불 ≥ 1, 6 = 확정 배치 ≥ 1, 7 = 역분개 ≥ 1, 8 = 해제된 보류 ≥ 1, 9 = 프로필 ≥ 1, 10 = PAID 지시 ≥ 1, 11 = 점검 정상), 각 단계에 해당 화면 링크.

**Tests:** typecheck + curl 확인: 프로필(`usr_settle2`가 등록) → 시계 +3일 → `usr_settle` 지급 실행 → PSP 결과 지정·webhook → 지시 `PAID` → 명세 대조 초록.

- [ ] **Step 1~5:** → 커밋 `feat(backoffice): 지급·명세·개발 도구·대시보드 화면`.

---

### Task 10: 화면 접근성·선택자 정리와 계약 테스트

**Files:**
- Create: `backoffice/e2e/contract.spec.ts`, `backoffice/playwright.config.ts`, `backoffice/e2e/fixtures.ts`
- Modify: Task 5~9 화면(선택자·라벨만)

**Requirements (12.2-8 계약 테스트):**
- Playwright 설정: `webServer` 두 개 — rights-core(`npm run dev --prefix ../rights-core`, url `http://127.0.0.1:8080/dev/clock`, `reuseExistingServer: true`)와 Vite(`npm run dev`, url `http://127.0.0.1:5173`). `workers: 1`, `fullyParallel: false`(개발 DB 하나를 공유). 사전 조건: `npm run dev:db -w rights-core`를 한 번 실행했어야 한다(설정 주석과 README 대신 `e2e/fixtures.ts`의 `beforeAll`이 `/dev/clock`이 404면 명확한 오류로 실패).
- `fixtures.ts`: `resetAll(request)` = `POST /api/dev/reset`, `as(page, userId)` = 헤더 사용자 select 변경, `advance(page, label)` = 시계 버튼, `api(request, actor, method, path, body)` = 직접 API 호출(검증 보조).
- 화면 선택자 규칙: Playwright는 **역할·라벨로** 찾는다(`getByRole('button', { name: '컴파일' })`, `getByLabel('팩 id')`). Task 5~9 화면의 폼 필드에 `<label>`이 연결되어 있지 않거나 버튼 이름이 중복이면 고친다(같은 화면에 같은 이름 버튼이 여러 개면 행 안에서 찾도록 행에 `aria-label`). 표는 `<table>`과 `<th scope="col">`.
- `contract.spec.ts`: `resetAll` → 합성 곡 시드 → API로 정책·팩 활성·발행 1·구매 1·배치·확정·지급 실행까지 만든 뒤(`api` 보조, 백엔드 비동기 처리는 대상 상태가 될 때까지 500ms 간격 최대 30초 재조회) **각 목록·상세 조회 응답**이 `backoffice/src/api/types.ts`의 타입과 맞는지 런타임 검사한다: 타입마다 필수 키 목록(`const PARTY_KEYS = ['partyId','partyType','displayName',…] as const satisfies readonly (keyof Party)[]`)을 `types.ts` 옆 `api/keys.ts`에 두고, 응답의 첫 항목이 그 키를 모두 갖는지, 금액 키 값이 `/^-?\d+$/` 문자열인지 확인한다. 대상: Task 3·4 표의 모든 엔드포인트.

**Tests:** `npm run e2e -w backoffice -- e2e/contract.spec.ts` 통과(실행 전 rights-core dev 서버가 꺼져 있어도 webServer가 띄운다).

- [ ] **Step 1~5:** 설정·fixtures → 계약 테스트 → 실패 항목을 타입 또는 백엔드에서 고침(어느 쪽이 12.2-4와 어긋나는지 판단해 고치고 커밋 메시지에 기록) → 통과 → 커밋 `test(backoffice): Playwright 설정, 화면 선택자 정리, API 계약 테스트`.

---

### Task 11: Playwright E2E — 정상 경로 11단계와 거부 경로 5개

**Files:**
- Create: `backoffice/e2e/golden-path.spec.ts`, `backoffice/e2e/rejections.spec.ts`
- Modify: 화면(테스트가 드러낸 결함만)

**Requirements (12.2-8, 12.3):** 모든 조작은 **화면으로** 한다(`api` 보조는 검증 단언과 대기에만). 각 테스트는 `resetAll`로 시작한다.

`golden-path.spec.ts` — 하나의 `test.step` 묶음:
1. `/dev/data` "합성 곡 불러오기" → `/registry/parties`에 8명.
2. `usr_editor`로 `/policy/pol_nova_summer`, "합성 곡 정책 불러오기" → 팩 id `pak_nova_summer` → "컴파일" → 버전 1 `DRAFT`(또는 컴파일 직후 상태 — `policy/service.ts` 확인); `usr_approver` "승인"; `usr_activator` "활성화" → 활성.
3. `usr_activator`로 팩 상세 "팩 활성화" → 상태 활성.
4. `usr_issuer`로 발행 폼에서 슬롯 4개를 멤버 a·b·c가 섞이게 선택해 조합 3개 발행 → 발행 목록 3행, 첫 발행 상세의 digest 표시.
5. 시계 `지정…`으로 `2026-02-10T00:00:00.000Z` → `sys_ingest`로 구매 4건(조합별, 하나 `FLAGGED`, 금액 10,000·20,000·30,000·50,000) + 배치 전 환불 1건(부분).
6. 시계 `2026-03-02T00:00:00.000Z` → `usr_ops` 배치 생성(2026-02-01 ~ 2026-03-01) → run이 모두 `VERIFIED`가 될 때까지 화면 자동 갱신을 기다림(`expect.poll` 최대 60초) → `usr_settle` "확정" → 원장 분개 수 = 확정 run 수.
7. `sys_ingest`로 확정된 구매 하나에 확정 후 환불(전액) → `/settlement/batches/...`가 아니라 `/ledger`에서 `REVERSAL` 분개 1건, 매출 행 펼침에 역분개 표시.
8. `usr_settle`로 `/settlement/holds`에서 `FRAUD_REVIEW` 보류 "해제 제안 보기" → 제안대로 "해제" → 상태 해제, 시산표 합 0.
9. `usr_settle2`로 미지급금 권리자 전원 프로필 등록(개인 `DOMESTIC_INDIVIDUAL`, 계좌 토큰 `acct_<party>`, KYC 확인, 첫 지급 가능 시각은 서버가 등록 시각으로 정함) → 냉각 표시 확인 → 시계 `+30일` → 냉각 표시 사라짐. (`first_payable_at`은 서버가 프로필 첫 등록 시각으로 정한다 — 입력 필드가 아니다. 초기 보류 30일과 냉각 72시간이 모두 지나도록 +30일.)
10. `/dev/psp`에서 **지급 실행 전에** 권리자 `pty_label`의 결과를 `FAILED`로 지정(권리자별) → `usr_settle`로 지급 실행(asOf = 현재) → 지시 표가 자동 갱신되어 `pty_label`은 `FAILED`, 최소 지급액 이상인 나머지는 `SUBMITTED`, 미만은 `CARRIED` → `/dev/psp`에서 `SUBMITTED` 지시마다 "webhook 보내기"(repeat 1) → 그 지시들 `PAID`. 단언: `PAID` ≥ 1, `FAILED` = 1, `CARRIED` ≥ 1(금액 구성이 이를 만족하지 않으면 5단계 금액을 조정 — 최소 지급액 10,000원을 넘는 권리자와 못 넘는 권리자가 둘 다 생기게), `FAILED` 지시의 금액이 그 권리자 미지급금 잔액으로 복원(원장 화면).
11. `/statements`에서 `PAID`를 받은 권리자 하나와 `CARRIED` 하나를 골라 대조 표시 둘 다 초록, 헤더 점검 배지 "점검 정상", 대시보드 체크리스트 11단계 모두 완료.

`rejections.spec.ts` — 테스트 5개(각자 `resetAll` + 필요한 준비는 **화면 대신 `api` 보조로 빠르게** 만든 뒤 거부 동작만 화면으로):
1. **정산 불가 조합**: 정책·팩 활성 후 발행 폼에서 멤버 a가 4슬롯 모두 → "발행" → 오류 패널에 `ISSUE_NOT_SETTLEABLE`, 발행 목록 변화 없음.
2. **같은 사용자 승인·활성화**: 컴파일 후 `usr_approver`로 승인 → 같은 사용자로 "활성화" → `ROLE_REQUIRED`(또는 직무 분리 코드 — `policy/service.ts`가 내는 코드를 확인해 단언), 정책 활성 아님. 추가로 승인자와 활성화자가 둘 다 역할을 가진 경우의 직무 분리 코드가 서비스에 있으면 그것도 단언(없으면 이 항목은 역할 거부만).
3. **냉각 중 `HELD`**: 확정·원장까지 만든 뒤 `usr_settle2`가 프로필 등록 → 시계를 움직이지 않고 `usr_settle` 지급 실행 → 그 권리자 지시 `HELD` + 사유 `ACCOUNT_COOLING` 화면 표시.
4. **계좌 변경 뒤 `ACCOUNT_CHANGED`**: 냉각 지난 프로필 준비 → `api` 보조로 `POST /dev/jobs/pause {name: "submit-payout"}`(Task 2) → 화면에서 `usr_settle` 지급 실행(지시 `PENDING`) → 화면에서 `usr_settle2`가 그 권리자 계좌 토큰 변경 → `POST /dev/jobs/resume` → 지시 `FAILED` + `ACCOUNT_CHANGED` 화면 표시, `/dev/psp` 요청 기록에 그 지시의 submit 없음. `afterEach`에서 resume(실패해도 다음 테스트가 막히지 않게 — 초기화도 일시정지를 푼다).
5. **중복 webhook 무시**: 지급 실행 → `/dev/psp`에서 webhook `repeat 2` → 응답 두 개 모두 200, 지시 상세 webhook 이력 1건, 분개 `PAYOUT_SETTLED` 1건.

**Tests:** `npm run e2e -w backoffice` 전체 통과(계약 + 정상 + 거부 5). 3번 연속 실행해 모두 통과(불안정 테스트 없음).

- [ ] **Step 1:** `fixtures.ts`에 정상·거부 테스트가 쓰는 준비 보조(`prepareSettled(request)` = API로 시드·정책·팩·발행·매출·배치·확정까지)를 추가한다.
- [ ] **Step 2:** `golden-path.spec.ts` 작성 → 실행 → 화면 결함 수정 → 통과.
- [ ] **Step 3:** `rejections.spec.ts` 작성 → 실행 → 수정 → 통과.
- [ ] **Step 4:** 전체 E2E 3회 연속 통과, `npm run typecheck -w backoffice`, `npm test -w backoffice`.
- [ ] **Step 5:** 커밋 `test(backoffice): E2E — 정상 경로 11단계와 거부 경로 5개`.

---

### Task 12: 수동 검증과 결과 기록

**Files:** Modify `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md`(12.4 추가)

**Requirements (12.3):**
- 컨트롤러(사람 역할)가 브라우저 창(`.claude/launch.json`의 두 서버)으로 `/dev/reset` 후 권장 검증 순서 11단계를 화면만으로 진행하고, 단계마다 화면 캡처를 남긴다(캡처 파일은 저장소에 넣지 않고 결과 표에 단계별 관찰값을 적는다).
- 전체 회귀: rights-core `npm test`·`tsc`·`npm run scenario -- --settle 30000`, mdrl `npm test`·`npm run smoke`, backoffice `npm test`·`typecheck`·`e2e`.
- 12.4 표(10.4·11.4 형식): 테스트 수(rights-core·mdrl·backoffice 단위·E2E), 수동 진행 단계별 관찰값(발행 수, run 수, 분개 수, 지시 상태별 수, 명세 대조, 점검), 발견해 고친 결함 목록, 실행 환경, 남은 것(12.1 제외 항목 + 진행 중 발견한 후속 과제).
- 구현 중 12.2와 달라진 점이 있으면 12.2를 고치고 12.4에 그 사실을 적는다.

- [ ] **Step 1~3:** 수동 진행 → 회귀 → 문서 기록.
- [ ] **Step 4:** 커밋 `docs(design): 백오피스 E2E 검증 결과(12.4)`.
