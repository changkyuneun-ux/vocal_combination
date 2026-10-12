# I-2a 정산 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** rights-core에 수익 수집, 정산 배치·run(평가·봉인·독립 재계산 검증·확정), 환불 역분개를 붙여 "매출 → 확정 정산 라인 → 환불 역분개"를 실제 PostgreSQL에서 끝까지 처리한다.

**Architecture:** 새 모듈 `revenue`·`settlement`와 `engine-bridge/settle.ts`·`engine-bridge/reverse.ts`(mdrl `evaluate`·`verifyAllocationResult`·`reverse` 호출은 여기만). 비동기 처리는 pg-boss 작업(`settle-run`·`verify-run`·`refund-recorded`·`reverse-event`)이고, 작업은 상태 변경과 같은 트랜잭션에서 보낸다. 작업 처리기는 `(deps, data) => Promise<void>` 순수 서비스 함수로, 자기 트랜잭션에서 대상 행을 잠그고 상태를 확인한 뒤 이미 처리됐으면 아무것도 하지 않는다(재시도 안전). 테스트는 처리기를 직접 호출하는 기록용 `Jobs`로 결정적으로 돌리고, 실제 pg-boss는 별도 통합 테스트와 시나리오에서 쓴다.

**Tech Stack:** 기존 rights-core(Node ≥ 24, TypeScript 직접 실행, Fastify 5, pg 8, PostgreSQL 17 Docker) + **pg-boss 12**(런타임 의존성 1개 추가).

**상위 스펙:** `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` **10절(I-2a 결정, 정본)**, 5.4~5.7, 9.3; `데이터모델_v2.8.md` 3.7; 코어 규격 12.50·12.53~12.55.

## Global Constraints

- 작업 디렉터리 `/Users/changkyuneun/Vocal Combination/03_구현문서_코드` (git 루트 `/Users/changkyuneun/Vocal Combination`). 무관한 커밋 안 된 변경이 많다. `git add`는 태스크 파일만, `git stash`·`git reset`·`git checkout -- <path>` 금지. 임시 파일은 남기지 않는다.
- 커밋 메시지: 제목, 빈 줄, 마지막 줄에 정확히 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- TypeScript erasable syntax만(`enum`·`namespace`·parameter property 금지), 상대 import는 `.ts`, 타입 전용은 `import type`.
- `mdrl` import는 `rights-core/src/engine-bridge/` 아래에만(아키텍처 테스트). `revenue`는 `settlement`를 import하지 않는다(의존 방향: settlement → revenue, settlement → issuance, settlement → engine-bridge).
- 서비스는 현재 시각을 직접 읽지 않고 `Clock`을 받는다. 시각은 밀리초 UTC ISO 문자열, DB `TIMESTAMPTZ` 컬럼에는 밀리초 절사 `CHECK`.
- id는 `mdrl_id` 도메인(`^[A-Za-z0-9._-]+$`). 콜론 금지 — 시스템 신원은 `sys_ingest`·`sys_settler`·`sys_verifier`.
- 금액은 `BIGINT`/`bigint`, IR 값은 문자열. 부동소수 금지(시나리오 지연 측정 제외).
- 추가 전용: 새 테이블은 트리거(`rc_reject_mutation`)와 `rc_app` 권한(SELECT·INSERT + 명시한 컬럼 UPDATE)으로 보호. 행을 지우지 않는다(무효화된 run의 라인도 남고, run 상태로 구분).
- 오류 → HTTP는 기존 규칙(`DomainError.status`, 23505 → 409 `CONFLICT`, RC001 → 409 `APPEND_ONLY`, 22P02/23502 → 400).
- 테스트: `docker compose up -d`(PostgreSQL). `node --test "test/**/*.test.ts"`(= `npm test`) 또는 파일 경로 — 디렉터리 형태는 이 Node에서 실패한다. 타입 검사 `npx tsc -p tsconfig.json`.
- 기존 테스트(62개)와 시나리오(`npm run scenario`)가 계속 통과해야 한다.

## File Structure

```
rights-core/
  package.json                          (Modify: pg-boss 의존성)
  migrations/0010_revenue.sql           (역할·봉인 종류 확장, revenue_event)
  migrations/0011_settlement.sql        (settlement_batch, settlement_run, settlement_run_event, pool_line, allocation_line, unallocated_holding, settlement_batch_skip)
  migrations/0012_reversal.sql          (reversal_run)
  src/platform/actor.ts                 (Modify: Role 확장)
  src/platform/jobs.ts                  (Create: Jobs 인터페이스, pg-boss 구현, 기록용 구현)
  src/platform/dbadmin.ts               (Modify: 템플릿 DB에 pg-boss 스키마 설치)
  src/engine-bridge/seal-store.ts       (Modify: SealKind 확장)
  src/engine-bridge/settle.ts           (Create: evaluateRun, verifyRun)
  src/engine-bridge/reverse.ts          (Create: reverseEvent)
  src/revenue/service.ts, routes.ts     (Create)
  src/settlement/service.ts             (Create: createBatch, confirmBatch, 조회)
  src/settlement/handlers.ts            (Create: settleRun, verifyRunJob, refundRecorded, reverseEventJob, JOB_HANDLERS)
  src/settlement/routes.ts              (Create)
  src/http/server.ts, main.ts           (Modify: 라우트·워커 연결)
  src/scenario/settlement.ts            (Create: 정산 시나리오), src/scenario/main.ts (Modify)
  test/settlement-fixtures.ts           (Create)
  test/revenue/revenue.test.ts, test/platform/jobs.test.ts, test/engine-bridge/settle.test.ts,
  test/settlement/batch.test.ts, test/settlement/refund.test.ts, test/http/settlement-api.test.ts, test/scenario/settlement.test.ts
02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md (Modify, Task 7: 10.4 결과)
```

---

### Task 1: 역할·봉인 종류 확장과 수익 수집

**Files:**
- Create: `rights-core/migrations/0010_revenue.sql`, `rights-core/src/revenue/service.ts`, `rights-core/test/revenue/revenue.test.ts`
- Modify: `rights-core/src/platform/actor.ts`, `rights-core/src/engine-bridge/seal-store.ts`

**Interfaces:**
- Consumes: `Tx`, `Clock`, `DomainError`, `conflict`, `invalid`, `notFound`, `audit`, `requireRole`, `Actor`.
- Produces:
```ts
// platform/actor.ts
export type Role = "RIGHTS_EDITOR" | "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "ISSUER" | "SPACE_OPS" | "SPACE_SETTLE" | "SYSTEM";
// engine-bridge/seal-store.ts
export type SealKind = "facts" | "allocation" | "projection" | "members" | "events" | "allocation_result" | "reversal_result" | "manifest";
// revenue/service.ts
export type RevenueType = "PURCHASE" | "RESALE" | "REFUND";
export type RevenueInput = { eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision?: number;
  eventType: RevenueType; vcId?: string; relatedEventId?: string; amountKrw: string; currency: "KRW";
  integrity?: "CLEAR" | "FLAGGED"; occurredAt: string };
export type RevenueRow = RevenueInput & { sourceRevision: number; integrity: "CLEAR" | "FLAGGED"; recordedAt: string };
export async function ingestRevenue(tx: Tx, clock: Clock, actor: Actor, input: RevenueInput): Promise<{ eventId: string; created: boolean }>;
export async function revenueRow(tx: Tx, eventId: string): Promise<RevenueRow>;           // 없으면 404
export async function refundedTotal(tx: Tx, originalEventId: string): Promise<bigint>;   // 기록된 환불 합
export type RefundHook = (tx: Tx, refundEventId: string) => Promise<void>;
```
`ingestRevenue`의 마지막 인자로 선택적 `onRefund?: RefundHook`를 받는다(환불이 새로 기록된 트랜잭션 안에서 한 번 호출 — Task 5가 `refund-recorded` 작업 전송을 여기에 꽂는다. revenue는 settlement를 모른다).

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/revenue/revenue.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { createUser, loadActor } from "../../src/platform/actor.ts";
import { ingestRevenue, refundedTotal, revenueRow, type RevenueInput } from "../../src/revenue/service.ts";

const { db, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-03-01T00:00:00.000Z", 1);
const ingest = await db.tx(async (tx) => {
  await createUser(tx, clock, { userId: "sys_ingest", displayName: "ingest", roles: ["SYSTEM"] });
  await createUser(tx, clock, { userId: "usr_other", displayName: "other", roles: ["EDITOR"] });
  return loadActor(tx, "sys_ingest");
});
const purchase = (over: Partial<RevenueInput> = {}): RevenueInput => ({
  eventId: "ev_p1", sourceSystem: "app", sourceEventId: "pay_1", eventType: "PURCHASE", vcId: "vc_1",
  amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-01T10:00:00.000Z", ...over,
});

test("ingest is idempotent on the source key and rejects a changed payload", async () => {
  const hooks: string[] = [];
  const first = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase(), async (_tx, id) => { hooks.push(id); }));
  assert.deepEqual(first, { eventId: "ev_p1", created: true });
  const again = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase()));
  assert.deepEqual(again, { eventId: "ev_p1", created: false });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ amountKrw: "9999" }))), { code: "IDEMPOTENCY_MISMATCH", status: 409 });
  const rev2 = await db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_p1r2", sourceRevision: 2, amountKrw: "9999" })));
  assert.equal(rev2.created, true);
  const row = await db.tx((tx) => revenueRow(tx, "ev_p1"));
  assert.equal(row.integrity, "CLEAR");
  assert.equal(row.sourceRevision, 1);
  assert.deepEqual(hooks, [], "the refund hook is not called for purchases");
});

test("only SYSTEM actors ingest; amounts, currency, instants and types are validated", async () => {
  const other = await db.tx((tx) => loadActor(tx, "usr_other"));
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, other, purchase({ eventId: "ev_x", sourceEventId: "x" }))), { code: "ROLE_REQUIRED" });
  for (const bad of [{ amountKrw: "0" }, { amountKrw: "-1" }, { amountKrw: "1.5" }, { currency: "USD" as never },
    { occurredAt: "2026-03-01T10:00:00Z" }, { eventType: "REFUND" as const }, { vcId: undefined }]) {
    await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, purchase({ eventId: "ev_bad", sourceEventId: "bad", ...bad }))), { code: "INVALID_REVENUE", status: 422 });
  }
});

test("refunds reference a purchase, are capped by the original amount and call the hook once", async () => {
  const hooks: string[] = [];
  const hook = async (_tx: unknown, id: string) => { hooks.push(id); };
  const refund = (id: string, amountKrw: string) => ({
    eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND" as const, relatedEventId: "ev_p1",
    amountKrw, currency: "KRW" as const, occurredAt: "2026-03-02T00:00:00.000Z",
  });
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r1", "3000"), hook));
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r1", "3000"), hook));
  await db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r2", "7000"), hook));
  assert.deepEqual(hooks, ["ev_r1", "ev_r2"]);
  assert.equal(await db.tx((tx) => refundedTotal(tx, "ev_p1")), 10000n);
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, refund("ev_r3", "1"), hook)), { code: "REFUND_EXCEEDS_ORIGINAL", status: 422 });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...refund("ev_r4", "1"), relatedEventId: "ev_r1" }, hook)), { code: "INVALID_REVENUE" });
  await assert.rejects(db.tx((tx) => ingestRevenue(tx, clock, ingest, { ...refund("ev_r5", "1"), relatedEventId: "ev_nope" }, hook)), { code: "NOT_FOUND" });
});

test("revenue rows are immutable", async () => {
  await assert.rejects(db.pool.query("UPDATE revenue_event SET net_amount_krw = 1"), /append-only|permission denied/);
  await assert.rejects(db.pool.query("DELETE FROM revenue_event"), /append-only|permission denied/);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/revenue/revenue.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 마이그레이션**

`rights-core/migrations/0010_revenue.sql`:
```sql
-- 역할·봉인 종류 확장(통합 설계 10.2-10). 제약 이름이 다르면 \d로 확인해 맞춘다.
ALTER TABLE portal_role DROP CONSTRAINT portal_role_role_check;
ALTER TABLE portal_role ADD CONSTRAINT portal_role_role_check
  CHECK (role IN ('RIGHTS_EDITOR','EDITOR','WORK_APPROVER','ACTIVATOR','ISSUER','SPACE_OPS','SPACE_SETTLE','SYSTEM'));
ALTER TABLE sealed_document DROP CONSTRAINT sealed_document_kind_check;
ALTER TABLE sealed_document ADD CONSTRAINT sealed_document_kind_check
  CHECK (kind IN ('facts','allocation','projection','members','events','allocation_result','reversal_result','public_facts','manifest'));

-- 수익 이벤트(v2.8 3.7 revenue_event의 I-2a 부분 집합). 환불도 양수이며 방향은 event_type이 나타낸다.
CREATE TABLE revenue_event (
  event_id         mdrl_id PRIMARY KEY,
  source_system    TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,
  source_revision  INT NOT NULL DEFAULT 1 CHECK (source_revision >= 1),
  event_type       TEXT NOT NULL CHECK (event_type IN ('PURCHASE','RESALE','REFUND')),
  vc_id            mdrl_id NULL,
  related_event_id mdrl_id NULL REFERENCES revenue_event,
  net_amount_krw   BIGINT NOT NULL CHECK (net_amount_krw > 0),
  currency         CHAR(3) NOT NULL CHECK (currency = 'KRW'),
  integrity_status TEXT NOT NULL DEFAULT 'CLEAR' CHECK (integrity_status IN ('CLEAR','FLAGGED')),
  occurred_at      TIMESTAMPTZ NOT NULL CHECK (occurred_at = date_trunc('milliseconds', occurred_at)),
  recorded_at      TIMESTAMPTZ NOT NULL CHECK (recorded_at = date_trunc('milliseconds', recorded_at)),
  UNIQUE (source_system, source_event_id, source_revision),
  CHECK ((event_type = 'REFUND') = (related_event_id IS NOT NULL)),
  CHECK (event_type = 'REFUND' OR vc_id IS NOT NULL)
);
CREATE INDEX revenue_event_related ON revenue_event (related_event_id) WHERE related_event_id IS NOT NULL;
CREATE INDEX revenue_event_period ON revenue_event (occurred_at) WHERE event_type <> 'REFUND';
CREATE TRIGGER revenue_event_immutable BEFORE UPDATE OR DELETE ON revenue_event FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
GRANT SELECT, INSERT ON revenue_event TO rc_app;
```

- [ ] **Step 4: 구현**

`rights-core/src/platform/actor.ts`의 `Role`을 Interfaces의 정의로 바꾼다. `rights-core/src/engine-bridge/seal-store.ts`의 `SealKind`를 Interfaces의 정의로 바꾼다.

`rights-core/src/revenue/service.ts`:
```ts
import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import { iso, type Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";

export type RevenueType = "PURCHASE" | "RESALE" | "REFUND";
export type RevenueInput = {
  eventId: string; sourceSystem: string; sourceEventId: string; sourceRevision?: number; eventType: RevenueType;
  vcId?: string; relatedEventId?: string; amountKrw: string; currency: "KRW"; integrity?: "CLEAR" | "FLAGGED"; occurredAt: string;
};
export type RevenueRow = RevenueInput & { sourceRevision: number; integrity: "CLEAR" | "FLAGGED"; recordedAt: string };
export type RefundHook = (tx: Tx, refundEventId: string) => Promise<void>;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AMOUNT = /^[1-9]\d*$/;
const bad = (m: string) => invalid("INVALID_REVENUE", m);

function validate(i: RevenueInput): void {
  if (!["PURCHASE", "RESALE", "REFUND"].includes(i.eventType)) throw bad(`eventType ${String(i.eventType)}`);
  if (typeof i.amountKrw !== "string" || !AMOUNT.test(i.amountKrw)) throw bad("amountKrw must be a positive integer string");
  if (i.currency !== "KRW") throw bad("only KRW is supported");
  if (typeof i.occurredAt !== "string" || !INSTANT.test(i.occurredAt) || new Date(i.occurredAt).toISOString() !== i.occurredAt) throw bad("occurredAt must be ms UTC ISO");
  if (i.integrity !== undefined && i.integrity !== "CLEAR" && i.integrity !== "FLAGGED") throw bad("integrity");
  if (i.eventType === "REFUND") {
    if (i.relatedEventId === undefined) throw bad("refund requires relatedEventId");
    if (i.vcId !== undefined) throw bad("refund must not carry vcId (it follows the original)");
  } else {
    if (i.vcId === undefined) throw bad(`${i.eventType} requires vcId`);
    if (i.relatedEventId !== undefined) throw bad(`${i.eventType} must not carry relatedEventId`);
  }
}

function toRow(r: any): RevenueRow {
  return {
    eventId: r.event_id, sourceSystem: r.source_system, sourceEventId: r.source_event_id, sourceRevision: r.source_revision,
    eventType: r.event_type, amountKrw: String(r.net_amount_krw), currency: r.currency, integrity: r.integrity_status,
    occurredAt: iso(r.occurred_at)!, recordedAt: iso(r.recorded_at)!,
    ...(r.vc_id !== null && { vcId: r.vc_id }), ...(r.related_event_id !== null && { relatedEventId: r.related_event_id }),
  };
}

export async function revenueRow(tx: Tx, eventId: string): Promise<RevenueRow> {
  const r = (await tx.query("SELECT * FROM revenue_event WHERE event_id = $1", [eventId])).rows[0];
  if (r === undefined) throw notFound("revenue event", eventId);
  return toRow(r);
}

export async function refundedTotal(tx: Tx, originalEventId: string): Promise<bigint> {
  const r = await tx.query("SELECT COALESCE(SUM(net_amount_krw), 0)::text AS s FROM revenue_event WHERE related_event_id = $1", [originalEventId]);
  return BigInt(r.rows[0].s);
}

const samePayload = (a: RevenueRow, b: RevenueInput) =>
  a.eventId === b.eventId && a.eventType === b.eventType && a.amountKrw === b.amountKrw && a.currency === b.currency &&
  a.occurredAt === b.occurredAt && a.integrity === (b.integrity ?? "CLEAR") && a.vcId === b.vcId && a.relatedEventId === b.relatedEventId;

/**
 * 멱등 수집(통합 설계 10.2-2): 같은 source 키·같은 내용이면 기존 id, 다른 내용이면 409.
 * 환불은 원 이벤트별 advisory lock으로 직렬화하고 누적 ≤ 원 금액을 강제한 뒤, 새로 기록된 경우에만 onRefund를 호출한다.
 */
export async function ingestRevenue(tx: Tx, clock: Clock, actor: Actor, input: RevenueInput, onRefund?: RefundHook): Promise<{ eventId: string; created: boolean }> {
  requireRole(actor, "SYSTEM");
  validate(input);
  const revision = input.sourceRevision ?? 1;
  const existing = (await tx.query(
    "SELECT * FROM revenue_event WHERE source_system = $1 AND source_event_id = $2 AND source_revision = $3",
    [input.sourceSystem, input.sourceEventId, revision],
  )).rows[0];
  if (existing !== undefined) {
    if (!samePayload(toRow(existing), input)) throw conflict("IDEMPOTENCY_MISMATCH", `source key ${input.sourceSystem}/${input.sourceEventId}/${revision} was recorded with different content`);
    return { eventId: existing.event_id, created: false };
  }
  if (input.eventType === "REFUND") {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('refund:' || $1, 0))", [input.relatedEventId]);
    const original = await revenueRow(tx, input.relatedEventId!);
    if (original.eventType === "REFUND") throw bad("a refund must reference a PURCHASE or RESALE");
    const total = (await refundedTotal(tx, original.eventId)) + BigInt(input.amountKrw);
    if (total > BigInt(original.amountKrw)) {
      throw new DomainError("REFUND_EXCEEDS_ORIGINAL", 422, `refunds ${total} exceed original ${original.amountKrw} of ${original.eventId}`);
    }
  }
  await tx.query(
    `INSERT INTO revenue_event (event_id, source_system, source_event_id, source_revision, event_type, vc_id, related_event_id,
       net_amount_krw, currency, integrity_status, occurred_at, recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [input.eventId, input.sourceSystem, input.sourceEventId, revision, input.eventType, input.vcId ?? null, input.relatedEventId ?? null,
      input.amountKrw, input.currency, input.integrity ?? "CLEAR", input.occurredAt, clock.now()],
  );
  await audit(tx, clock, { actor: actor.userId, action: "REVENUE_RECORDED", entityType: "revenue_event", entityId: input.eventId, after: { type: input.eventType, amount: input.amountKrw } });
  if (input.eventType === "REFUND" && onRefund !== undefined) await onRefund(tx, input.eventId);
  return { eventId: input.eventId, created: true };
}
```

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/revenue/revenue.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: revenue 4 PASS, 전체 fail 0, `TSC_OK`.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0010_revenue.sql rights-core/src/platform/actor.ts rights-core/src/engine-bridge/seal-store.ts rights-core/src/revenue/service.ts rights-core/test/revenue/revenue.test.ts
git commit -m "feat(rights-core): 수익 멱등 수집·환불 한도, 정산 역할·봉인 종류 확장

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 작업 큐(pg-boss)

**Files:**
- Create: `rights-core/src/platform/jobs.ts`, `rights-core/test/platform/jobs.test.ts`
- Modify: `rights-core/package.json`, `rights-core/src/platform/dbadmin.ts`, `package-lock.json`(workspace 루트)

**Interfaces:**
- Consumes: `Tx`, `Db`, `ADMIN_URL`, `createFreshDatabase`.
- Produces (`src/platform/jobs.ts`):
```ts
export type JobName = "settle-run" | "verify-run" | "refund-recorded" | "reverse-event";
export const JOB_NAMES: readonly JobName[];
export type Jobs = { send(tx: Tx, name: JobName, data: Record<string, string>): Promise<void> };
export type JobHandler = (data: Record<string, string>) => Promise<void>;
export async function installJobSchema(adminUrl: string): Promise<void>;           // 소유자 역할로 pgboss 스키마·큐 생성, rc_app 권한
export type BossJobs = Jobs & { work(handlers: Record<JobName, JobHandler>): Promise<void>; drainIdle(timeoutMs: number): Promise<void>; stop(): Promise<void> };
export async function startBossJobs(appUrl: string): Promise<BossJobs>;
/** 테스트용: 보낸 작업을 트랜잭션 커밋과 무관하게 기록한다. drain은 핸들러를 순서대로 호출하고 새로 쌓인 작업도 처리한다. */
export type RecordingJobs = Jobs & { sent: { name: JobName; data: Record<string, string> }[]; drain(handlers: Partial<Record<JobName, JobHandler>>): Promise<number> };
export function recordingJobs(): RecordingJobs;
```

- [ ] **Step 1: 의존성 설치**

`rights-core/package.json`의 `dependencies`에 `"pg-boss": "^12.35.0"`을 추가하고 워크스페이스 루트에서 `npm install`한다.

- [ ] **Step 2: 실패하는 테스트 작성**

`rights-core/test/platform/jobs.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { recordingJobs, startBossJobs, type JobName } from "../../src/platform/jobs.ts";

const { db, drop } = await freshDb();
after(drop);

test("recordingJobs records sends and drains handlers, including jobs sent by handlers", async () => {
  const jobs = recordingJobs();
  await db.tx((tx) => jobs.send(tx, "settle-run", { runId: "r1" }));
  const seen: string[] = [];
  const n = await jobs.drain({
    "settle-run": async (d) => { seen.push(`settle:${d.runId}`); await db.tx((tx) => jobs.send(tx, "verify-run", { runId: d.runId! })); },
    "verify-run": async (d) => { seen.push(`verify:${d.runId}`); },
  });
  assert.equal(n, 2);
  assert.deepEqual(seen, ["settle:r1", "verify:r1"]);
});

test("pg-boss jobs are sent inside the caller's transaction (rolled back sends never run)", async () => {
  const boss = await startBossJobs((db.pool as any).options.connectionString);
  try {
    const got: string[] = [];
    const handlers = Object.fromEntries((["settle-run", "verify-run", "refund-recorded", "reverse-event"] as JobName[])
      .map((n) => [n, async (d: Record<string, string>) => { got.push(`${n}:${d.id}`); }])) as never;
    await boss.work(handlers);
    await db.tx((tx) => boss.send(tx, "settle-run", { id: "kept" }));
    await assert.rejects(db.tx(async (tx) => { await boss.send(tx, "settle-run", { id: "rolled" }); throw new Error("boom"); }));
    await boss.drainIdle(10_000);
    assert.deepEqual(got, ["settle-run:kept"]);
  } finally {
    await boss.stop();
  }
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd rights-core && node --test test/platform/jobs.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 4: 구현**

설치된 `node_modules/pg-boss/dist/index.d.ts`·`types.d.ts`로 아래 API를 확인한다(12.x 기준: `new PgBoss(options)`, `start()`, `stop()`, `createQueue(name)`, `send(name, data, { db })` — `SendOptions`가 `ConnectionOptions { db?: IDatabase }`를 포함, `IDatabase = { executeSql(text, values) }`, `work(name, options, handler)`의 핸들러는 작업 **배열**을 받는다, 생성자 옵션 `migrate`·`createSchema`·`supervise`·`schedule`). 다르면 같은 의미로 맞추고 보고한다.

`rights-core/src/platform/jobs.ts`:
```ts
import { PgBoss } from "pg-boss";
import type { Tx } from "./db.ts";

export type JobName = "settle-run" | "verify-run" | "refund-recorded" | "reverse-event";
export const JOB_NAMES: readonly JobName[] = ["settle-run", "verify-run", "refund-recorded", "reverse-event"];
export type Jobs = { send(tx: Tx, name: JobName, data: Record<string, string>): Promise<void> };
export type JobHandler = (data: Record<string, string>) => Promise<void>;
export type BossJobs = Jobs & { work(handlers: Record<JobName, JobHandler>): Promise<void>; drainIdle(timeoutMs: number): Promise<void>; stop(): Promise<void> };
export type RecordingJobs = Jobs & { sent: { name: JobName; data: Record<string, string> }[]; drain(handlers: Partial<Record<JobName, JobHandler>>): Promise<number> };

const SCHEMA = "pgboss";
/** 같은 트랜잭션에서 작업을 넣기 위한 실행기(통합 설계 10.2-1). */
const txExecutor = (tx: Tx) => ({ executeSql: (text: string, values?: unknown[]) => tx.query(text, values as unknown[]) });

/** 템플릿 DB를 만들 때 소유자 역할로 pg-boss 스키마와 큐를 설치하고 rc_app에 권한을 준다. */
export async function installJobSchema(adminUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: adminUrl, schema: SCHEMA, supervise: false, schedule: false });
  boss.on("error", (e: unknown) => console.error("pg-boss(install)", e));
  await boss.start();
  try {
    for (const name of JOB_NAMES) await boss.createQueue(name);
  } finally {
    await boss.stop();
  }
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    await c.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO rc_app`);
    await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${SCHEMA} TO rc_app`);
  } finally {
    await c.end();
  }
}

export async function startBossJobs(appUrl: string): Promise<BossJobs> {
  const boss = new PgBoss({ connectionString: appUrl, schema: SCHEMA, migrate: false, createSchema: false, schedule: false });
  boss.on("error", (e: unknown) => console.error("pg-boss", e));
  await boss.start();
  let inFlight = 0;
  return {
    async send(tx, name, data) {
      await boss.send(name, data, { db: txExecutor(tx), retryLimit: 5, retryBackoff: true } as never);
    },
    async work(handlers) {
      for (const name of JOB_NAMES) {
        await boss.work(name, { pollingIntervalSeconds: 0.5 } as never, async (batch: { data: Record<string, string> }[]) => {
          for (const job of batch) {
            inFlight++;
            try {
              await handlers[name](job.data);
            } finally {
              inFlight--;
            }
          }
        });
      }
    },
    async drainIdle(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const queued = await Promise.all(JOB_NAMES.map((n) => boss.getQueueStats ? boss.getQueueStats(n) : Promise.resolve({ queuedCount: 0, activeCount: 0 })));
        const pending = queued.reduce((a: number, q: any) => a + (q.queuedCount ?? 0) + (q.activeCount ?? 0), 0) + inFlight;
        if (pending === 0) return;
        if (Date.now() > deadline) throw new Error(`jobs did not drain within ${timeoutMs}ms (${pending} pending)`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    stop: () => boss.stop({ graceful: true } as never),
  };
}

export function recordingJobs(): RecordingJobs {
  const sent: { name: JobName; data: Record<string, string> }[] = [];
  let cursor = 0;
  return {
    sent,
    async send(_tx, name, data) {
      sent.push({ name, data: { ...data } });
    },
    async drain(handlers) {
      let n = 0;
      while (cursor < sent.length) {
        const job = sent[cursor++]!;
        const h = handlers[job.name];
        if (h === undefined) continue;
        await h(job.data);
        n++;
      }
      return n;
    },
  };
}
```
(`drainIdle`은 큐 통계 API 이름이 설치된 버전과 다르면 그 버전의 대기·실행 작업 수 조회로 바꾼다. 테스트·시나리오에서만 쓴다.)

`rights-core/src/platform/dbadmin.ts`의 템플릿 빌드에서 `migrate(c)` 직후, 이름 변경(`ALTER DATABASE ... RENAME`) 전에 `await installJobSchema(withDb(adminUrl, building))`를 호출한다(연결을 닫은 뒤 호출하고, 설치가 끝나 연결이 모두 닫힌 뒤 이름을 바꾼다). 템플릿 이름 해시에 pg-boss 버전을 넣어(`require("pg-boss/package.json").version` 또는 `createRequire`) 버전이 바뀌면 템플릿을 새로 만든다.

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/platform/jobs.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: jobs 2 PASS, 전체 fail 0, `TSC_OK`. pg-boss가 `rc_app` 권한 부족으로 실패하면 필요한 권한을 `installJobSchema`에 추가하고 보고한다(스키마 소유권을 `rc_app`에 넘기지 않는다).

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add package-lock.json rights-core/package.json rights-core/src/platform/jobs.ts rights-core/src/platform/dbadmin.ts rights-core/test/platform/jobs.test.ts
git commit -m "feat(rights-core): pg-boss 작업 큐(트랜잭션 내 전송, 템플릿 스키마 설치, 테스트용 기록 큐)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 정산 스키마와 엔진 경계(`evaluateRun`·`verifyRun`)

**Files:**
- Create: `rights-core/migrations/0011_settlement.sql`, `rights-core/src/engine-bridge/settle.ts`, `rights-core/test/settlement-fixtures.ts`, `rights-core/test/engine-bridge/settle.test.ts`

**Interfaces:**
- Consumes: `loadSealed`, `sealDocument`, `loadFacts`, `Sealed`; mdrl `evaluate`, `verifyAllocationResult`, `AllocationResult` (`mdrl/allocation`).
- Produces (`src/engine-bridge/settle.ts`):
```ts
export type RunEvent = { eventId: string; type: "PRIMARY" | "RESALE"; amount: bigint; integrity: "CLEAR" | "FLAGGED" };
export type RunRows = {
  pool: { eventId: string; bucket: string; amount: bigint }[];
  lines: { eventId: string; party: string; role: string; bucket: string; lineSeq: number; amount: bigint }[];
  holdings: { eventId: string; bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW"; amount: bigint }[];
};
export type RunEvaluation =
  | { ok: true; eventsDigest: string; resultDigest: string; rows: RunRows }
  | { ok: false; diagnostics: Diagnostic[] };
export async function evaluateRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; events: RunEvent[] }): Promise<RunEvaluation>;
export async function verifyRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; eventsDigest: string; resultDigest: string }): Promise<Diagnostic[]>;
```
- Test fixture (`test/settlement-fixtures.ts`):
```ts
export type SettlementWorld = { db: Db; ctx: BridgeCtx; clock: Clock; users: Record<"rights"|"editor"|"approver"|"activator"|"issuer"|"ops"|"settle"|"ingest", Actor>; drop(): Promise<void> };
export async function settlementWorld(): Promise<SettlementWorld>;   // freshDb + seedSong + 정책 활성화 + 팩 활성화 + 사용자(ops SPACE_OPS, settle SPACE_SETTLE, ingest SYSTEM, sys_settler/sys_verifier SYSTEM)
export async function issueCombo(w: SettlementWorld, vcId: string, a?: "a" | "b", b?: "a" | "b"): Promise<IssueSeal>;
export async function purchase(w: SettlementWorld, eventId: string, vcId: string, amountKrw: string, occurredAt?: string, integrity?: "CLEAR" | "FLAGGED"): Promise<void>;
```

- [ ] **Step 1: 마이그레이션**

`rights-core/migrations/0011_settlement.sql`:
```sql
-- 정산 배치(통합 설계 10.2-3·4). 상태는 OPEN/CONFIRMED, 진행 상황은 run 상태에서 계산한다.
CREATE TABLE settlement_batch (
  batch_id              mdrl_id PRIMARY KEY,
  period_start          TIMESTAMPTZ NOT NULL CHECK (period_start = date_trunc('milliseconds', period_start)),
  period_end            TIMESTAMPTZ NOT NULL CHECK (period_end = date_trunc('milliseconds', period_end)),
  status                TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED')),
  executed_by           mdrl_id NOT NULL REFERENCES user_account,
  created_at            TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  confirmed_by          mdrl_id NULL REFERENCES user_account,
  confirmed_at          TIMESTAMPTZ NULL CHECK (confirmed_at = date_trunc('milliseconds', confirmed_at)),
  batch_manifest_digest TEXT NULL REFERENCES sealed_document,
  CHECK (period_end > period_start),
  CHECK (confirmed_by IS NULL OR confirmed_by <> executed_by),
  CHECK ((status = 'CONFIRMED') = (confirmed_by IS NOT NULL AND batch_manifest_digest IS NOT NULL))
);

CREATE TABLE settlement_run (
  run_id            mdrl_id PRIMARY KEY,
  batch_id          mdrl_id NOT NULL REFERENCES settlement_batch,
  snapshot_id       mdrl_id NOT NULL REFERENCES issue_seal,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CALCULATED','VERIFIED','CONFIRMED','FAILED','VOIDED')),
  events_digest     TEXT NULL REFERENCES sealed_document,
  result_digest     TEXT NULL REFERENCES sealed_document,
  diagnostics       JSONB NULL,
  executed_by       mdrl_id NOT NULL DEFAULT 'sys_settler' REFERENCES user_account,
  verified_by       mdrl_id NULL REFERENCES user_account,
  verified_at       TIMESTAMPTZ NULL CHECK (verified_at = date_trunc('milliseconds', verified_at)),
  created_at        TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (batch_id, snapshot_id),
  CHECK (verified_by IS NULL OR verified_by <> executed_by),
  CHECK (status NOT IN ('CALCULATED','VERIFIED','CONFIRMED') OR (events_digest IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK (status NOT IN ('VERIFIED','CONFIRMED') OR verified_by IS NOT NULL)
);
CREATE INDEX settlement_run_batch ON settlement_run (batch_id, status);

-- run에 고정된 이벤트 순액(원 금액 − 포함한 환불). active는 run이 FAILED·VOIDED가 되면 false.
CREATE TABLE settlement_run_event (
  run_id               mdrl_id NOT NULL REFERENCES settlement_run,
  event_id             mdrl_id NOT NULL REFERENCES revenue_event,
  net_amount_krw       BIGINT NOT NULL CHECK (net_amount_krw > 0),
  refunds_included_krw BIGINT NOT NULL CHECK (refunds_included_krw >= 0),
  active               BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (run_id, event_id)
);
CREATE UNIQUE INDEX run_event_once ON settlement_run_event (event_id) WHERE active;

-- 결과 라인(원 결과 line_seq = 1, 역분개 = sequence + 1). run_id는 항상 원 run.
CREATE TABLE pool_line (
  run_id      mdrl_id NOT NULL REFERENCES settlement_run,
  event_id    mdrl_id NOT NULL REFERENCES revenue_event,
  bucket      TEXT NOT NULL,
  line_seq    INT NOT NULL CHECK (line_seq >= 1),
  amount_krw  BIGINT NOT NULL,
  reversal_id mdrl_id NULL,
  PRIMARY KEY (run_id, event_id, bucket, line_seq),
  CHECK ((line_seq = 1) = (reversal_id IS NULL))
);
CREATE TABLE allocation_line (
  line_id             BIGSERIAL PRIMARY KEY,
  run_id              mdrl_id NOT NULL REFERENCES settlement_run,
  event_id            mdrl_id NOT NULL REFERENCES revenue_event,
  party_id            mdrl_id NOT NULL REFERENCES party,
  role                TEXT NOT NULL,
  bucket              TEXT NOT NULL,
  line_seq            INT NOT NULL CHECK (line_seq >= 1),
  line_kind           TEXT NOT NULL CHECK (line_kind IN ('SETTLE','REVERSAL')),
  amount_krw          BIGINT NOT NULL,
  reversal_of_line_id BIGINT NULL REFERENCES allocation_line,
  reversal_id         mdrl_id NULL,
  UNIQUE (run_id, event_id, party_id, role, bucket, line_seq),
  CHECK ((line_kind = 'SETTLE') = (line_seq = 1)),
  CHECK ((line_kind = 'REVERSAL') = (reversal_of_line_id IS NOT NULL AND reversal_id IS NOT NULL)),
  CHECK ((line_kind = 'SETTLE' AND amount_krw > 0) OR (line_kind = 'REVERSAL' AND amount_krw < 0))
);
CREATE TABLE unallocated_holding (
  holding_id  BIGSERIAL PRIMARY KEY,
  run_id      mdrl_id NOT NULL REFERENCES settlement_run,
  event_id    mdrl_id NOT NULL REFERENCES revenue_event,
  bucket      TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('RIGHTS_DISPUTE','FRAUD_REVIEW')),
  line_seq    INT NOT NULL CHECK (line_seq >= 1),
  amount_krw  BIGINT NOT NULL,
  reversal_id mdrl_id NULL,
  status      TEXT NOT NULL DEFAULT 'HELD' CHECK (status = 'HELD'),
  UNIQUE (run_id, event_id, bucket, reason, line_seq),
  CHECK ((line_seq = 1) = (reversal_id IS NULL))
);

CREATE TABLE settlement_batch_skip (
  batch_id mdrl_id NOT NULL REFERENCES settlement_batch,
  event_id mdrl_id NOT NULL REFERENCES revenue_event,
  reason   TEXT NOT NULL CHECK (reason IN ('NO_ISSUE_SEAL','FACTS_DISPUTE_OPEN','FULLY_REFUNDED')),
  PRIMARY KEY (batch_id, event_id)
);

CREATE TRIGGER pool_line_immutable BEFORE UPDATE OR DELETE ON pool_line FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER allocation_line_immutable BEFORE UPDATE OR DELETE ON allocation_line FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER unallocated_holding_immutable BEFORE UPDATE OR DELETE ON unallocated_holding FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
CREATE TRIGGER settlement_batch_skip_immutable BEFORE UPDATE OR DELETE ON settlement_batch_skip FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();

GRANT SELECT, INSERT ON settlement_batch, settlement_run, settlement_run_event, pool_line, allocation_line, unallocated_holding, settlement_batch_skip TO rc_app;
GRANT UPDATE (status, confirmed_by, confirmed_at, batch_manifest_digest) ON settlement_batch TO rc_app;
GRANT UPDATE (status, events_digest, result_digest, diagnostics, verified_by, verified_at) ON settlement_run TO rc_app;
GRANT UPDATE (active) ON settlement_run_event TO rc_app;
GRANT USAGE ON SEQUENCE allocation_line_line_id_seq, unallocated_holding_holding_id_seq TO rc_app;
```

- [ ] **Step 2: 테스트 픽스처와 실패하는 테스트 작성**

`rights-core/test/settlement-fixtures.ts`:
```ts
import type { Actor } from "../src/platform/actor.ts";
import { createUser, loadActor } from "../src/platform/actor.ts";
import { fixedClock, type Clock } from "../src/platform/clock.ts";
import type { Db } from "../src/platform/db.ts";
import type { BridgeCtx } from "../src/engine-bridge/context.ts";
import type { IssueSeal } from "../src/engine-bridge/issue.ts";
import * as policy from "../src/policy/service.ts";
import * as issuance from "../src/issuance/service.ts";
import { ingestRevenue } from "../src/revenue/service.ts";
import { freshDb } from "./helpers.ts";
import { DECLARED, PACK, POLICY_TEXT, SCOPE, T0, seedSong, seedUsers, tempBridge } from "./fixtures.ts";

export type SettlementWorld = {
  db: Db; ctx: BridgeCtx; clock: Clock;
  users: Record<"rights" | "editor" | "approver" | "activator" | "issuer" | "ops" | "settle" | "ingest", Actor>;
  drop(): Promise<void>;
};

/** 정산 가능한 세계: 곡·정책·팩이 활성이고, 정산 역할 사용자와 시스템 신원이 있다. 정책 events는 [PRIMARY]. */
export async function settlementWorld(): Promise<SettlementWorld> {
  const { db, drop } = await freshDb();
  const { ctx, cleanup } = tempBridge();
  const clock = fixedClock("2026-02-01T00:00:00.000Z", 1000);
  const base = fixedClock(T0, 0);
  const users = await db.tx(async (tx) => {
    await seedSong(tx, base);
    const u = await seedUsers(tx, base);
    for (const [id, role] of [["usr_ops", "SPACE_OPS"], ["usr_settle", "SPACE_SETTLE"], ["sys_ingest", "SYSTEM"], ["sys_settler", "SYSTEM"], ["sys_verifier", "SYSTEM"]] as const) {
      await createUser(tx, base, { userId: id, displayName: id, roles: [role] });
    }
    await issuance.createPack(tx, clock, u.rights, { packId: PACK, packCode: "NOVA", title: "Nova", factsScopeId: SCOPE });
    await issuance.setPackClaimants(tx, clock, u.rights, PACK, DECLARED);
    return { ...u, ops: await loadActor(tx, "usr_ops"), settle: await loadActor(tx, "usr_settle"), ingest: await loadActor(tx, "sys_ingest") };
  });
  await db.tx(async (tx) => {
    const r = await policy.compilePolicy(ctx, tx, clock, users.editor, { policyId: "pol_nova", packId: PACK, sourceText: POLICY_TEXT });
    await policy.approvePolicy(ctx, tx, clock, users.approver, r);
    await policy.activatePolicy(ctx, tx, clock, users.activator, r);
    await issuance.activatePack(ctx, tx, clock, users.activator, PACK);
  });
  return { db, ctx, clock, users, async drop() { await drop(); cleanup(); } };
}

export async function issueCombo(w: SettlementWorld, vcId: string, a: "a" | "b" = "a", b: "a" | "b" = "b"): Promise<IssueSeal> {
  return w.db.tx((tx) => issuance.issue(w.ctx, tx, w.clock, w.users.issuer, {
    packId: PACK, vcId,
    assignments: [{ slotId: "slt_1", stemId: `stm_${a}1` }, { slotId: "slt_2", stemId: `stm_${b}2` }, { slotId: "slt_mr", stemId: "stm_mr" }],
    members: a === b ? { [`pty_member_${a}`]: 10000 } : { [`pty_member_${a}`]: 5000, [`pty_member_${b}`]: 5000 },
  }));
}

export async function purchase(
  w: SettlementWorld, eventId: string, vcId: string, amountKrw: string, occurredAt = "2026-03-01T10:00:00.000Z", integrity: "CLEAR" | "FLAGGED" = "CLEAR",
): Promise<void> {
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId, sourceSystem: "app", sourceEventId: eventId, eventType: "PURCHASE", vcId, amountKrw, currency: "KRW", occurredAt, integrity,
  }));
}
```

`rights-core/test/engine-bridge/settle.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { evaluateRun, verifyRun } from "../../src/engine-bridge/settle.ts";
import { createBridgeCtx } from "../../src/engine-bridge/context.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const seal = await issueCombo(w, "vc_1");
const events = [
  { eventId: "ev_2", type: "PRIMARY" as const, amount: 1001n, integrity: "CLEAR" as const },
  { eventId: "ev_1", type: "PRIMARY" as const, amount: 10000n, integrity: "CLEAR" as const },
];

test("evaluateRun seals events (sorted) and the result; rows conserve every event amount", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t1", snapshotId: seal.snapshotId, events }));
  assert.ok(r.ok, JSON.stringify(r));
  const doc = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [r.eventsDigest])).rows[0].content;
  assert.deepEqual(doc.map((e: { id: string }) => e.id), ["ev_1", "ev_2"]);
  const result = (await w.db.pool.query("SELECT kind, format, content FROM sealed_document WHERE digest = $1", [r.resultDigest])).rows[0];
  assert.equal(result.kind, "allocation_result");
  assert.equal(result.format, "mdrl-allocation-result/1");
  for (const ev of events) {
    const pool = r.rows.pool.filter((p) => p.eventId === ev.eventId).reduce((a, p) => a + p.amount, 0n);
    assert.equal(pool, ev.amount, `pool lines of ${ev.eventId}`);
  }
  assert.ok(r.rows.lines.every((l) => l.lineSeq === 1 && l.amount > 0n));
  const again = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t1", snapshotId: seal.snapshotId, events: [...events].reverse() }));
  assert.ok(again.ok);
  assert.equal(again.resultDigest, r.resultDigest, "deterministic regardless of input order");
});

test("verifyRun recomputes from sealed inputs with a cold cache and detects a mismatch", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t2", snapshotId: seal.snapshotId, events }));
  assert.ok(r.ok);
  const cold = createBridgeCtx(w.ctx.blobs);
  assert.deepEqual(await w.db.tx((tx) => verifyRun(cold, tx, { runId: "run_t2", snapshotId: seal.snapshotId, eventsDigest: r.eventsDigest, resultDigest: r.resultDigest })), []);
  const other = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t3", snapshotId: seal.snapshotId, events: events.slice(0, 1) }));
  assert.ok(other.ok);
  const diags = await w.db.tx((tx) => verifyRun(cold, tx, { runId: "run_t2", snapshotId: seal.snapshotId, eventsDigest: r.eventsDigest, resultDigest: other.resultDigest }));
  assert.ok(diags.length > 0);
});

test("engine diagnostics are returned, not thrown (event type outside the policy scope)", async () => {
  const r = await w.db.tx((tx) => evaluateRun(w.ctx, tx, { runId: "run_t4", snapshotId: seal.snapshotId, events: [{ ...events[0]!, type: "RESALE" }] }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.diagnostics.some((d) => d.code === "ALLOC_SCOPE_MISMATCH"), JSON.stringify(r));
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd rights-core && node --test test/engine-bridge/settle.test.ts`
Expected: FAIL (`settle.ts` 없음).

- [ ] **Step 4: 구현**

`rights-core/src/engine-bridge/settle.ts`:
```ts
import { evaluate, verifyAllocationResult, type AllocationDocument, type AllocationResult, type RevenueEvent, type Snapshot } from "mdrl/allocation";
import type { ProjectionIr } from "mdrl/facts";
import type { Tx } from "../platform/db.ts";
import { notFound, type Diagnostic } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadFacts } from "./facts.ts";
import { loadSealed, sealDocument } from "./seal-store.ts";
import { iso } from "../platform/db.ts";

export type RunEvent = { eventId: string; type: "PRIMARY" | "RESALE"; amount: bigint; integrity: "CLEAR" | "FLAGGED" };
export type RunRows = {
  pool: { eventId: string; bucket: string; amount: bigint }[];
  lines: { eventId: string; party: string; role: string; bucket: string; lineSeq: number; amount: bigint }[];
  holdings: { eventId: string; bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW"; amount: bigint }[];
};
export type RunEvaluation = { ok: true; eventsDigest: string; resultDigest: string; rows: RunRows } | { ok: false; diagnostics: Diagnostic[] };

type SealInputs = { policy: AllocationDocument; facts: Awaited<ReturnType<typeof loadFacts>>; projection: ProjectionIr; snapshot: Snapshot; asOf: string; knownAt: string };

async function sealInputs(ctx: BridgeCtx, tx: Tx, snapshotId: string): Promise<SealInputs> {
  const s = (await tx.query("SELECT * FROM issue_seal WHERE snapshot_id = $1", [snapshotId])).rows[0];
  if (s === undefined) throw notFound("issue seal", snapshotId);
  return {
    policy: (await loadSealed(ctx, tx, s.policy_digest)) as AllocationDocument,
    facts: await loadFacts(ctx, tx, s.facts_digest),
    projection: (await loadSealed(ctx, tx, s.projection_digest)) as ProjectionIr,
    snapshot: (await loadSealed(ctx, tx, s.members_digest)) as Snapshot,
    asOf: iso(s.as_of)!, knownAt: iso(s.known_at)!,
  };
}

const toIr = (events: readonly RunEvent[], currency: string): RevenueEvent[] =>
  [...events].sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)).map((e) => ({
    id: e.eventId, type: e.type, amount: e.amount.toString(), currency, integrity: e.integrity,
  }));

function rowsOf(r: AllocationResult): RunRows {
  return {
    pool: r.pool_lines.map((p) => ({ eventId: p.event_id, bucket: p.bucket, amount: BigInt(p.amount) })),
    lines: r.lines.map((l) => ({ eventId: l.event_id, party: l.party, role: l.role, bucket: l.bucket, lineSeq: Number(l.line_seq), amount: BigInt(l.amount) })),
    holdings: r.holdings.map((h) => ({ eventId: h.event_id, bucket: h.bucket, reason: h.reason, amount: BigInt(h.amount) })),
  };
}

/** 발행 봉인의 입력과 고정된 순액 이벤트로 mdrl evaluate를 돌리고 events·결과를 봉인한다(통합 설계 10.2-5). */
export async function evaluateRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; events: RunEvent[] }): Promise<RunEvaluation> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  const events = toIr(input.events, s.policy.body.scope.currency);
  const r = evaluate({ policy: s.policy, facts: s.facts, projection: s.projection, snapshot: s.snapshot, events, runId: input.runId });
  if (!r.ok) return { ok: false, diagnostics: r.errors };
  const ev = await sealDocument(ctx, tx, { kind: "events", value: events, docId: input.runId });
  const res = await sealDocument(ctx, tx, { kind: "allocation_result", value: r.value, docId: input.runId, format: r.value.format });
  return { ok: true, eventsDigest: ev.digest, resultDigest: res.digest, rows: rowsOf(r.value) };
}

/** 봉인된 입력·스냅샷 사용량·발행 봉인 기준 시점으로 mdrl verifyAllocationResult를 돌린다(통합 설계 10.2-6). */
export async function verifyRun(ctx: BridgeCtx, tx: Tx, input: { runId: string; snapshotId: string; eventsDigest: string; resultDigest: string }): Promise<Diagnostic[]> {
  const s = await sealInputs(ctx, tx, input.snapshotId);
  const events = (await loadSealed(ctx, tx, input.eventsDigest)) as RevenueEvent[];
  const given = await loadSealed(ctx, tx, input.resultDigest);
  const usage: Record<string, string> = {};
  const rows = (await tx.query(
    "SELECT stem_id, SUM(duration_ms)::text AS ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 AND rights_bearing GROUP BY stem_id ORDER BY stem_id",
    [input.snapshotId],
  )).rows;
  for (const r of rows) usage[r.stem_id] = r.ms;
  return verifyAllocationResult({ policy: s.policy, facts: s.facts, snapshot: s.snapshot, events: [...events], runId: input.runId, usage, asOf: s.asOf, knownAt: s.knownAt }, given);
}
```
(`loadSealed`가 돌려주는 값은 깊게 동결되어 있다. mdrl은 입력을 바꾸지 않으므로 그대로 넘긴다 — `events`는 배열 복사본으로 넘긴다. `verifyAllocationResult`의 입력 타입이 다르면 mdrl `src/allocation/verify.ts`에 맞춘다.)

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/engine-bridge/settle.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: settle 3 PASS, 전체 fail 0(아키텍처 테스트 포함), `TSC_OK`.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0011_settlement.sql rights-core/src/engine-bridge/settle.ts rights-core/test/settlement-fixtures.ts rights-core/test/engine-bridge/settle.test.ts
git commit -m "feat(rights-core): 정산 스키마와 엔진 경계 evaluateRun·verifyRun

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 배치 생성·run 처리·검증·확정

**Files:**
- Create: `rights-core/src/settlement/service.ts`, `rights-core/src/settlement/handlers.ts`, `rights-core/test/settlement/batch.test.ts`
- Modify: `rights-core/src/engine-bridge/attest.ts` (`AttestRole` 확장)

**Interfaces:**
- Consumes: Task 1~3 전부, `openDisputeInScope`(issuance), `attest`, `audit`, `requireRole`, `sealDocument`.
- Produces:
```ts
// engine-bridge/attest.ts
export type AttestRole = "EDITOR" | "WORK_APPROVER" | "ACTIVATOR" | "SPACE_OPS" | "SPACE_SETTLE" | "PLATFORM";
// settlement/service.ts
export type SettleDeps = { db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs };
export async function createBatch(d: SettleDeps, actor: Actor, input: { batchId: string; periodStart: string; periodEnd: string }):
  Promise<{ batchId: string; runs: string[]; skipped: { eventId: string; reason: string }[] }>;              // SPACE_OPS
export async function confirmBatch(d: SettleDeps, actor: Actor, batchId: string): Promise<{ manifestDigest: string }>;  // SPACE_SETTLE
export type BatchView = { batchId: string; status: "OPEN" | "CONFIRMED"; runs: { runId: string; status: string; events: number }[];
  progress: "CALCULATING" | "VERIFYING" | "READY" | "CONFIRMED" | "EMPTY"; skipped: { eventId: string; reason: string }[] };
export async function batchView(tx: Tx, batchId: string): Promise<BatchView>;
export async function releaseRunEvents(tx: Tx, runId: string): Promise<void>;   // run의 이벤트 active=false
// settlement/handlers.ts
export async function settleRun(d: SettleDeps, data: { runId: string }): Promise<void>;
export async function verifyRunJob(d: SettleDeps, data: { runId: string }): Promise<void>;
export function jobHandlers(d: SettleDeps): Partial<Record<JobName, JobHandler>>;   // Task 5에서 환불 처리기 추가
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/settlement/batch.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { batchView, confirmBatch, createBatch, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, settleRun } from "../../src/settlement/handlers.ts";
import { openDispute, closeDispute } from "../../src/registry/disputes.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "b");
await purchase(w, "ev_1a", "vc_1", "10000");
await purchase(w, "ev_1b", "vc_1", "1001");
await purchase(w, "ev_2a", "vc_2", "5000");
await purchase(w, "ev_nos", "vc_missing", "700");
await purchase(w, "ev_late", "vc_1", "300", "2026-04-02T00:00:00.000Z");

test("createBatch groups events by issue seal, skips unissued ones and enqueues settle jobs", async () => {
  const b = await createBatch(d, w.users.ops, { batchId: "bat_1", ...P });
  assert.equal(b.runs.length, 2);
  assert.deepEqual(b.skipped, [{ eventId: "ev_nos", reason: "NO_ISSUE_SEAL" }]);
  assert.deepEqual(jobs.sent.map((j) => j.name), ["settle-run", "settle-run"]);
  const events = await w.db.pool.query("SELECT run_id, event_id, net_amount_krw::text AS net FROM settlement_run_event ORDER BY event_id");
  assert.deepEqual(events.rows.map((r) => [r.event_id, r.net]), [["ev_1a", "10000"], ["ev_1b", "1001"], ["ev_2a", "5000"]]);
  const dup = await createBatch(d, w.users.ops, { batchId: "bat_dup", ...P });
  assert.deepEqual(dup.runs, [], "events already in a live run are not re-batched");
});

test("settle and verify jobs run to VERIFIED with conserved lines and two distinct signers", async () => {
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_1"));
  assert.equal(v.progress, "READY");
  assert.ok(v.runs.every((r) => r.status === "VERIFIED"));
  const sums = await w.db.pool.query(
    `SELECT e.event_id, e.net_amount_krw::text AS net,
            (SELECT SUM(amount_krw) FROM pool_line p WHERE p.run_id = e.run_id AND p.event_id = e.event_id)::text AS pool
       FROM settlement_run_event e ORDER BY e.event_id`,
  );
  assert.ok(sums.rows.every((r) => r.net === r.pool), JSON.stringify(sums.rows));
  const signers = await w.db.pool.query(
    "SELECT DISTINCT a.signer_id, a.role FROM attestation a JOIN settlement_run r ON r.result_digest = a.digest ORDER BY 1",
  );
  assert.deepEqual(signers.rows.map((r) => [r.signer_id, r.role]), [["sys_settler", "SPACE_OPS"], ["sys_verifier", "PLATFORM"]]);
  await settleRun(d, { runId: v.runs[0]!.runId });
  const lines = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE run_id = $1", [v.runs[0]!.runId]);
  const again = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE run_id = $1", [v.runs[0]!.runId]);
  assert.equal(lines.rows[0].n, again.rows[0].n, "re-running a settled run writes nothing");
});

test("confirmBatch requires SPACE_SETTLE, a different person, and seals a signed manifest", async () => {
  await assert.rejects(confirmBatch(d, w.users.ops, "bat_1"), { code: "ROLE_REQUIRED" });
  const r = await confirmBatch(d, w.users.settle, "bat_1");
  const v = await w.db.tx((tx) => batchView(tx, "bat_1"));
  assert.equal(v.status, "CONFIRMED");
  assert.ok(v.runs.every((x) => x.status === "CONFIRMED"));
  const manifest = (await w.db.pool.query("SELECT content FROM sealed_document WHERE digest = $1", [r.manifestDigest])).rows[0].content;
  assert.equal(manifest.format, "rc-batch-manifest/1");
  assert.equal(manifest.results.length, 2);
  const s = await w.db.pool.query("SELECT signer_id, role FROM attestation WHERE digest = $1", [r.manifestDigest]);
  assert.deepEqual(s.rows.map((x) => [x.signer_id, x.role]), [["usr_settle", "SPACE_SETTLE"]]);
  await assert.rejects(confirmBatch(d, w.users.settle, "bat_1"), { code: "INVALID_STATE" });
});

test("an open dispute skips the scope's events; they are picked up after the dispute closes", async () => {
  await purchase(w, "ev_1c", "vc_1", "2000");
  await w.db.tx((tx) => openDispute(tx, w.clock, { disputeId: "dsp_b", targetType: "RIGHT_CLAIM", targetId: "c_master", reason: "t" }));
  const b2 = await createBatch(d, w.users.ops, { batchId: "bat_2", ...P });
  assert.deepEqual(b2.runs, []);
  assert.ok(b2.skipped.some((s) => s.eventId === "ev_1c" && s.reason === "FACTS_DISPUTE_OPEN"));
  await w.db.tx((tx) => closeDispute(tx, w.clock, { disputeId: "dsp_b" }));
  const b3 = await createBatch(d, w.users.ops, { batchId: "bat_3", ...P });
  assert.equal(b3.runs.length, 1);
});

test("an engine failure (event type outside the policy scope) marks the run FAILED and releases its events", async () => {
  await issueCombo(w, "vc_3");
  await w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
    eventId: "ev_3r", sourceSystem: "app", sourceEventId: "ev_3r", eventType: "RESALE", vcId: "vc_3", amountKrw: "4000", currency: "KRW", occurredAt: "2026-03-05T00:00:00.000Z",
  }));
  const b = await createBatch(d, w.users.ops, { batchId: "bat_4", ...P });
  assert.equal(b.runs.length, 1);
  await jobs.drain(jobHandlers(d));
  const run = (await w.db.pool.query("SELECT status, diagnostics FROM settlement_run WHERE run_id = $1", [b.runs[0]])).rows[0];
  assert.equal(run.status, "FAILED");
  assert.ok(JSON.stringify(run.diagnostics).includes("ALLOC_SCOPE_MISMATCH"));
  const active = await w.db.pool.query("SELECT active FROM settlement_run_event WHERE event_id = 'ev_3r'");
  assert.deepEqual(active.rows.map((r) => r.active), [false]);
  const v = await w.db.tx((tx) => batchView(tx, "bat_4"));
  assert.equal(v.progress, "EMPTY");
});
```
(`RESALE`은 픽스처 정책 `events: [PRIMARY]` 범위 밖이라 `ALLOC_SCOPE_MISMATCH`로 run이 `FAILED`가 된다.)

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/settlement/batch.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현**

`rights-core/src/engine-bridge/attest.ts`의 `AttestRole`을 Interfaces의 정의로 바꾼다.

`rights-core/src/settlement/service.ts`(mdrl은 import하지 않는다 — 매니페스트는 `sealDocument`로 봉인한다):
```ts
import { requireRole, type Actor } from "../platform/actor.ts";
import { audit } from "../platform/audit.ts";
import type { Clock } from "../platform/clock.ts";
import type { Db, Tx } from "../platform/db.ts";
import { conflict, DomainError, invalid, notFound } from "../platform/errors.ts";
import type { Jobs } from "../platform/jobs.ts";
import type { BridgeCtx } from "../engine-bridge/context.ts";
import { attest } from "../engine-bridge/attest.ts";
import { sealDocument } from "../engine-bridge/seal-store.ts";
import { openDisputeInScope } from "../issuance/service.ts";

export type SettleDeps = { db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs };
export type BatchView = {
  batchId: string; status: "OPEN" | "CONFIRMED"; runs: { runId: string; status: string; events: number }[];
  progress: "CALCULATING" | "VERIFYING" | "READY" | "CONFIRMED" | "EMPTY"; skipped: { eventId: string; reason: string }[];
};

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function releaseRunEvents(tx: Tx, runId: string): Promise<void> {
  await tx.query("UPDATE settlement_run_event SET active = false WHERE run_id = $1 AND active", [runId]);
}

/**
 * 배치 생성(통합 설계 10.2-3): 기간 안의 미배정 구매·재판매를 순액으로 발행 봉인별로 묶어 run을 만들고 settle-run을 보낸다.
 * 순액 0·발행 봉인 없음·열린 분쟁은 건너뛰고 사유를 남긴다(다음 배치의 후보로 남는다).
 */
export async function createBatch(d: SettleDeps, actor: Actor, input: { batchId: string; periodStart: string; periodEnd: string }) {
  requireRole(actor, "SPACE_OPS");
  for (const t of [input.periodStart, input.periodEnd]) {
    if (!INSTANT.test(t) || new Date(t).toISOString() !== t) throw invalid("INVALID_INSTANT", `${t} must be ms UTC ISO`);
  }
  return d.db.tx(async (tx) => {
    const now = d.clock.now();
    await tx.query("INSERT INTO settlement_batch (batch_id, period_start, period_end, executed_by, created_at) VALUES ($1,$2,$3,$4,$5)",
      [input.batchId, input.periodStart, input.periodEnd, actor.userId, now]);
    const candidates = (await tx.query(
      `SELECT e.event_id, e.event_type, e.integrity_status, e.net_amount_krw::text AS amount,
              COALESCE((SELECT SUM(r.net_amount_krw) FROM revenue_event r WHERE r.related_event_id = e.event_id), 0)::text AS refunded,
              s.snapshot_id, rs.pack_id, p.facts_scope_id
         FROM revenue_event e
         LEFT JOIN rights_snapshot rs ON rs.vc_id = e.vc_id
         LEFT JOIN issue_seal s ON s.snapshot_id = rs.snapshot_id
         LEFT JOIN vocal_pack p ON p.pack_id = rs.pack_id
        WHERE e.event_type IN ('PURCHASE','RESALE') AND e.occurred_at >= $1 AND e.occurred_at < $2
          AND NOT EXISTS (SELECT 1 FROM settlement_run_event x WHERE x.event_id = e.event_id AND x.active)
        ORDER BY e.event_id`,
      [input.periodStart, input.periodEnd],
    )).rows;
    const skipped: { eventId: string; reason: string }[] = [];
    const groups = new Map<string, { eventId: string; net: bigint; refunded: bigint }[]>();
    const disputed = new Map<string, boolean>();
    for (const c of candidates) {
      const net = BigInt(c.amount) - BigInt(c.refunded);
      let reason: string | undefined;
      if (net === 0n) reason = "FULLY_REFUNDED";
      else if (c.snapshot_id === null) reason = "NO_ISSUE_SEAL";
      else {
        if (!disputed.has(c.facts_scope_id)) disputed.set(c.facts_scope_id, await openDisputeInScope(tx, c.facts_scope_id));
        if (disputed.get(c.facts_scope_id)) reason = "FACTS_DISPUTE_OPEN";
      }
      if (reason !== undefined) {
        skipped.push({ eventId: c.event_id, reason });
        await tx.query("INSERT INTO settlement_batch_skip (batch_id, event_id, reason) VALUES ($1,$2,$3)", [input.batchId, c.event_id, reason]);
        continue;
      }
      const g = groups.get(c.snapshot_id) ?? [];
      g.push({ eventId: c.event_id, net, refunded: BigInt(c.refunded) });
      groups.set(c.snapshot_id, g);
    }
    const runs: string[] = [];
    for (const snapshotId of [...groups.keys()].sort()) {
      const runId = `run_${input.batchId}_${snapshotId}`;
      await tx.query("INSERT INTO settlement_run (run_id, batch_id, snapshot_id, created_at) VALUES ($1,$2,$3,$4)", [runId, input.batchId, snapshotId, now]);
      for (const e of groups.get(snapshotId)!) {
        await tx.query("INSERT INTO settlement_run_event (run_id, event_id, net_amount_krw, refunds_included_krw) VALUES ($1,$2,$3,$4)",
          [runId, e.eventId, e.net.toString(), e.refunded.toString()]);
      }
      await d.jobs.send(tx, "settle-run", { runId });
      runs.push(runId);
    }
    await audit(tx, d.clock, { actor: actor.userId, action: "BATCH_CREATED", entityType: "settlement_batch", entityId: input.batchId, after: { runs: runs.length, skipped: skipped.length } });
    return { batchId: input.batchId, runs, skipped };
  });
}

export async function batchView(tx: Tx, batchId: string): Promise<BatchView> {
  const b = (await tx.query("SELECT status FROM settlement_batch WHERE batch_id = $1", [batchId])).rows[0];
  if (b === undefined) throw notFound("batch", batchId);
  const runs = (await tx.query(
    `SELECT r.run_id, r.status, (SELECT count(*) FROM settlement_run_event e WHERE e.run_id = r.run_id)::int AS events
       FROM settlement_run r WHERE r.batch_id = $1 ORDER BY r.run_id`, [batchId],
  )).rows.map((r) => ({ runId: r.run_id as string, status: r.status as string, events: r.events as number }));
  const skipped = (await tx.query("SELECT event_id, reason FROM settlement_batch_skip WHERE batch_id = $1 ORDER BY event_id", [batchId]))
    .rows.map((r) => ({ eventId: r.event_id as string, reason: r.reason as string }));
  const live = runs.filter((r) => r.status !== "FAILED" && r.status !== "VOIDED");
  const progress: BatchView["progress"] = b.status === "CONFIRMED" ? "CONFIRMED"
    : live.length === 0 ? "EMPTY"
    : live.some((r) => r.status === "PENDING") ? "CALCULATING"
    : live.some((r) => r.status === "CALCULATED") ? "VERIFYING" : "READY";
  return { batchId, status: b.status, runs, progress, skipped };
}

/** 배치 확정(통합 설계 10.2-7): 살아 있는 run이 모두 VERIFIED일 때 SPACE_SETTLE(생성자와 다른 사람)이 매니페스트에 서명한다. */
export async function confirmBatch(d: SettleDeps, actor: Actor, batchId: string): Promise<{ manifestDigest: string }> {
  requireRole(actor, "SPACE_SETTLE");
  return d.db.tx(async (tx) => {
    const b = (await tx.query("SELECT status, executed_by FROM settlement_batch WHERE batch_id = $1 FOR UPDATE", [batchId])).rows[0];
    if (b === undefined) throw notFound("batch", batchId);
    if (b.status !== "OPEN") throw conflict("INVALID_STATE", `batch ${batchId} is ${b.status}`);
    if (b.executed_by === actor.userId) throw new DomainError("SOD_VIOLATION", 403, `${actor.userId} created batch ${batchId}`);
    const runs = (await tx.query(
      "SELECT run_id, status, result_digest FROM settlement_run WHERE batch_id = $1 AND status NOT IN ('FAILED','VOIDED') ORDER BY run_id FOR UPDATE", [batchId],
    )).rows;
    if (runs.length === 0) throw conflict("BATCH_EMPTY", `batch ${batchId} has no live runs`);
    const notReady = runs.filter((r) => r.status !== "VERIFIED");
    if (notReady.length > 0) throw conflict("BATCH_NOT_READY", `runs not verified: ${notReady.map((r) => `${r.run_id}:${r.status}`).join(",")}`);
    const manifest = { format: "rc-batch-manifest/1", batch_id: batchId, results: runs.map((r) => r.result_digest as string).sort() };
    const sealed = await sealDocument(d.ctx, tx, { kind: "manifest", value: manifest, docId: batchId, format: "rc-batch-manifest/1" });
    await attest(d.ctx, tx, d.clock, { userId: actor.userId, role: "SPACE_SETTLE", digest: sealed.digest });
    await tx.query("UPDATE settlement_run SET status = 'CONFIRMED' WHERE batch_id = $1 AND status = 'VERIFIED'", [batchId]);
    await tx.query("UPDATE settlement_batch SET status = 'CONFIRMED', confirmed_by = $2, confirmed_at = $3, batch_manifest_digest = $4 WHERE batch_id = $1",
      [batchId, actor.userId, d.clock.now(), sealed.digest]);
    await audit(tx, d.clock, { actor: actor.userId, action: "BATCH_CONFIRMED", entityType: "settlement_batch", entityId: batchId, after: { manifest: sealed.digest } });
    return { manifestDigest: sealed.digest };
  });
}
```

`rights-core/src/settlement/handlers.ts`:
```ts
import { audit } from "../platform/audit.ts";
import type { JobHandler, JobName } from "../platform/jobs.ts";
import { attest } from "../engine-bridge/attest.ts";
import { evaluateRun, verifyRun, type RunEvent } from "../engine-bridge/settle.ts";
import { releaseRunEvents, type SettleDeps } from "./service.ts";

const SETTLER = "sys_settler";
const VERIFIER = "sys_verifier";

/** settle-run(통합 설계 10.2-5): run을 잠그고 PENDING일 때만 평가·봉인·기록한다. 재시도 안전. */
export async function settleRun(d: SettleDeps, data: { runId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const run = (await tx.query("SELECT run_id, snapshot_id, status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [data.runId])).rows[0];
    if (run === undefined || run.status !== "PENDING") return;
    const rows = (await tx.query(
      `SELECT x.event_id, x.net_amount_krw::text AS net, e.event_type, e.integrity_status
         FROM settlement_run_event x JOIN revenue_event e ON e.event_id = x.event_id WHERE x.run_id = $1 AND x.active ORDER BY x.event_id`,
      [data.runId],
    )).rows;
    const events: RunEvent[] = rows.map((r) => ({
      eventId: r.event_id, type: r.event_type === "RESALE" ? "RESALE" : "PRIMARY", amount: BigInt(r.net), integrity: r.integrity_status,
    }));
    const r = await evaluateRun(d.ctx, tx, { runId: data.runId, snapshotId: run.snapshot_id, events });
    if (!r.ok) {
      await tx.query("UPDATE settlement_run SET status = 'FAILED', diagnostics = $2 WHERE run_id = $1", [data.runId, JSON.stringify(r.diagnostics)]);
      await releaseRunEvents(tx, data.runId);
      await audit(tx, d.clock, { actor: SETTLER, action: "RUN_FAILED", entityType: "settlement_run", entityId: data.runId, after: { codes: r.diagnostics.map((x) => x.code) } });
      return;
    }
    for (const p of r.rows.pool) {
      await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw) VALUES ($1,$2,$3,1,$4)", [data.runId, p.eventId, p.bucket, p.amount.toString()]);
    }
    for (const l of r.rows.lines) {
      await tx.query(
        "INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw) VALUES ($1,$2,$3,$4,$5,$6,'SETTLE',$7)",
        [data.runId, l.eventId, l.party, l.role, l.bucket, l.lineSeq, l.amount.toString()],
      );
    }
    for (const h of r.rows.holdings) {
      await tx.query("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw) VALUES ($1,$2,$3,$4,1,$5)",
        [data.runId, h.eventId, h.bucket, h.reason, h.amount.toString()]);
    }
    await tx.query("UPDATE settlement_run SET status = 'CALCULATED', events_digest = $2, result_digest = $3 WHERE run_id = $1", [data.runId, r.eventsDigest, r.resultDigest]);
    await attest(d.ctx, tx, d.clock, { userId: SETTLER, role: "SPACE_OPS", digest: r.resultDigest });
    await d.jobs.send(tx, "verify-run", { runId: data.runId });
  });
}

/** verify-run(통합 설계 10.2-6): CALCULATED run을 독립 재계산으로 검증한다. 불일치면 VOIDED·경보·이벤트 해제. */
export async function verifyRunJob(d: SettleDeps, data: { runId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const run = (await tx.query("SELECT * FROM settlement_run WHERE run_id = $1 FOR UPDATE", [data.runId])).rows[0];
    if (run === undefined || run.status !== "CALCULATED") return;
    const diags = await verifyRun(d.ctx, tx, { runId: data.runId, snapshotId: run.snapshot_id, eventsDigest: run.events_digest, resultDigest: run.result_digest });
    if (diags.length === 0) {
      await attest(d.ctx, tx, d.clock, { userId: VERIFIER, role: "PLATFORM", digest: run.result_digest });
      await tx.query("UPDATE settlement_run SET status = 'VERIFIED', verified_by = $2, verified_at = $3 WHERE run_id = $1", [data.runId, VERIFIER, d.clock.now()]);
      return;
    }
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1", [data.runId, JSON.stringify(diags)]);
    await releaseRunEvents(tx, data.runId);
    await audit(tx, d.clock, { actor: VERIFIER, action: "RUN_VERIFY_MISMATCH", entityType: "settlement_run", entityId: data.runId, after: { codes: diags.map((x) => x.code) } });
  });
}

export function jobHandlers(d: SettleDeps): Partial<Record<JobName, JobHandler>> {
  return {
    "settle-run": (data) => settleRun(d, { runId: data.runId! }),
    "verify-run": (data) => verifyRunJob(d, { runId: data.runId! }),
  };
}
```

- [ ] **Step 4: 검증 불일치 테스트 추가**

`test/settlement/batch.test.ts` 끝에 추가(검증 불일치 → `VOIDED`): 새 조합·구매로 배치를 만들고 `settle-run`만 처리한 뒤(`jobs.drain({ "settle-run": ... })`), 관리자 연결(`freshDb`의 `adminUrl`은 `settlementWorld`가 노출하지 않으므로 `SettlementWorld`에 `adminUrl`을 추가한다)로 그 run의 `result_digest`를 **다른 봉인 문서**(같은 스냅샷을 다른 이벤트로 `evaluateRun`해 만든 결과 digest)로 바꾼 다음 `verify-run`을 처리하고 `VOIDED`와 이벤트 해제를 단언한다. (`settlement_run`은 소유자 역할로는 UPDATE 가능하다.)

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/settlement/batch.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: batch 6 PASS(불일치 테스트 포함), 전체 fail 0, `TSC_OK`.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/engine-bridge/attest.ts rights-core/src/settlement/service.ts rights-core/src/settlement/handlers.ts rights-core/test/settlement/batch.test.ts rights-core/test/settlement-fixtures.ts
git commit -m "feat(rights-core): 정산 배치 생성·run 평가·독립 검증·배치 확정

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 환불 처리와 역분개

**Files:**
- Create: `rights-core/migrations/0012_reversal.sql`, `rights-core/src/engine-bridge/reverse.ts`, `rights-core/test/settlement/refund.test.ts`
- Modify: `rights-core/src/settlement/handlers.ts`, `rights-core/src/settlement/service.ts`(`refundHook`)

**Interfaces:**
- Consumes: Task 1~4, mdrl `reverse`, `ReversalResult` (`mdrl/allocation`), `revenueRow`, `refundedTotal`.
- Produces:
```ts
// engine-bridge/reverse.ts
export type ReversalRows = {
  sequence: number; resultDigest: string;
  pool: { bucket: string; amount: bigint }[];
  lines: { party: string; role: string; bucket: string; lineSeq: number; reversesLineSeq: number; amount: bigint }[];
  holdings: { bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW"; amount: bigint }[];
};
export async function reverseEvent(ctx: BridgeCtx, tx: Tx, input: { originalRunId: string; eventId: string; refundEventId: string; amount: bigint; reversalId: string }): Promise<ReversalRows>;
// settlement/service.ts
export function refundHook(jobs: Jobs): RefundHook;       // refund-recorded 작업을 같은 트랜잭션에서 보낸다
// settlement/handlers.ts
export async function refundRecorded(d: SettleDeps, data: { refundEventId: string }): Promise<void>;
export async function reverseEventJob(d: SettleDeps, data: { refundEventId: string }): Promise<void>;
// jobHandlers에 "refund-recorded", "reverse-event" 추가
```

- [ ] **Step 1: 마이그레이션**

`rights-core/migrations/0012_reversal.sql`:
```sql
-- 역분개 기록(통합 설계 10.2-9, 5.7 호출자 책임): 원 run·이벤트별 순번 유일, 환불 id 유일(멱등).
CREATE TABLE reversal_run (
  reversal_id     mdrl_id PRIMARY KEY,
  original_run_id mdrl_id NOT NULL REFERENCES settlement_run,
  event_id        mdrl_id NOT NULL REFERENCES revenue_event,
  sequence        INT NOT NULL CHECK (sequence >= 1),
  refund_event_id mdrl_id NOT NULL UNIQUE REFERENCES revenue_event,
  result_digest   TEXT NOT NULL REFERENCES sealed_document,
  created_at      TIMESTAMPTZ NOT NULL CHECK (created_at = date_trunc('milliseconds', created_at)),
  UNIQUE (original_run_id, event_id, sequence),
  CHECK (reversal_id <> original_run_id)
);
CREATE TRIGGER reversal_run_immutable BEFORE UPDATE OR DELETE ON reversal_run FOR EACH ROW EXECUTE FUNCTION rc_reject_mutation();
ALTER TABLE pool_line ADD CONSTRAINT pool_line_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
ALTER TABLE allocation_line ADD CONSTRAINT allocation_line_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
ALTER TABLE unallocated_holding ADD CONSTRAINT unallocated_holding_reversal_fk FOREIGN KEY (reversal_id) REFERENCES reversal_run;
GRANT SELECT, INSERT ON reversal_run TO rc_app;
```

- [ ] **Step 2: 실패하는 테스트 작성**

`rights-core/test/settlement/refund.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { ingestRevenue } from "../../src/revenue/service.ts";
import { batchView, confirmBatch, createBatch, refundHook, type SettleDeps } from "../../src/settlement/service.ts";
import { jobHandlers, reverseEventJob } from "../../src/settlement/handlers.ts";
import { issueCombo, purchase, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
after(() => w.drop());
const jobs = recordingJobs();
const d: SettleDeps = { db: w.db, ctx: w.ctx, clock: w.clock, jobs };
const P = { periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" };
const refund = (id: string, original: string, amount: string) => w.db.tx((tx) => ingestRevenue(tx, w.clock, w.users.ingest, {
  eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "REFUND", relatedEventId: original, amountKrw: amount, currency: "KRW", occurredAt: "2026-03-10T00:00:00.000Z",
}, refundHook(jobs)));
const net = async (eventId: string) => {
  const r = await w.db.pool.query(
    `SELECT COALESCE(SUM(p.amount_krw), 0)::text AS pool FROM pool_line p JOIN settlement_run r ON r.run_id = p.run_id
      WHERE p.event_id = $1 AND r.status = 'CONFIRMED'`, [eventId]);
  return BigInt(r.rows[0].pool);
};

await issueCombo(w, "vc_1");
await issueCombo(w, "vc_2", "b", "b");

test("refund before any batch: the next batch settles the net amount; a full refund is skipped", async () => {
  await purchase(w, "ev_a", "vc_1", "10000");
  await purchase(w, "ev_b", "vc_1", "2000");
  await refund("rf_a", "ev_a", "2500");
  await refund("rf_b", "ev_b", "2000");
  await jobs.drain(jobHandlers(d));
  const b = await createBatch(d, w.users.ops, { batchId: "bat_pre", ...P });
  assert.ok(b.skipped.some((s) => s.eventId === "ev_b" && s.reason === "FULLY_REFUNDED"));
  const e = await w.db.pool.query("SELECT net_amount_krw::text AS net, refunds_included_krw::text AS inc FROM settlement_run_event WHERE event_id = 'ev_a'");
  assert.deepEqual(e.rows[0], { net: "7500", inc: "2500" });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_pre");
  assert.equal(await net("ev_a"), 7500n);
});

test("refund before confirmation voids the run; the next batch re-evaluates the new net", async () => {
  await purchase(w, "ev_c", "vc_2", "8000");
  const b = await createBatch(d, w.users.ops, { batchId: "bat_mid", ...P });
  await jobs.drain(jobHandlers(d));
  await refund("rf_c", "ev_c", "3000");
  await jobs.drain(jobHandlers(d));
  const v = await w.db.tx((tx) => batchView(tx, "bat_mid"));
  assert.deepEqual(v.runs.map((r) => r.status), ["VOIDED"]);
  assert.equal(v.progress, "EMPTY");
  const b2 = await createBatch(d, w.users.ops, { batchId: "bat_mid2", ...P });
  assert.equal(b2.runs.length, 1);
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_mid2");
  assert.equal(await net("ev_c"), 5000n);
  assert.ok(b.runs.length === 1);
});

test("refunds after confirmation are reversed in sequence and net the event to exactly zero", async () => {
  await purchase(w, "ev_d", "vc_1", "10001");
  await createBatch(d, w.users.ops, { batchId: "bat_post", ...P });
  await jobs.drain(jobHandlers(d));
  await confirmBatch(d, w.users.settle, "bat_post");
  await refund("rf_d1", "ev_d", "3333");
  await refund("rf_d2", "ev_d", "1");
  await jobs.drain(jobHandlers(d));
  const seq = await w.db.pool.query("SELECT refund_event_id, sequence FROM reversal_run WHERE event_id = 'ev_d' ORDER BY sequence");
  assert.deepEqual(seq.rows.map((r) => [r.refund_event_id, r.sequence]), [["rf_d1", 1], ["rf_d2", 2]]);
  assert.equal(await net("ev_d"), 10001n - 3334n);
  await refund("rf_d3", "ev_d", "6667");
  await jobs.drain(jobHandlers(d));
  assert.equal(await net("ev_d"), 0n);
  const lines = await w.db.pool.query(
    `SELECT party_id, bucket, SUM(amount_krw)::text AS s FROM allocation_line WHERE event_id = 'ev_d' GROUP BY party_id, bucket`);
  assert.ok(lines.rows.every((r) => r.s === "0"), JSON.stringify(lines.rows));
  const rev = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line WHERE event_id = 'ev_d' AND line_kind = 'REVERSAL' AND reversal_of_line_id IS NULL");
  assert.equal(rev.rows[0].n, 0);
});

test("reverse-event is idempotent per refund id", async () => {
  const before = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line");
  await reverseEventJob(d, { refundEventId: "rf_d1" });
  const after2 = await w.db.pool.query("SELECT count(*)::int AS n FROM allocation_line");
  assert.equal(after2.rows[0].n, before.rows[0].n);
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd rights-core && node --test test/settlement/refund.test.ts`
Expected: FAIL (`refundHook` 등 없음).

- [ ] **Step 4: 구현**

`rights-core/src/engine-bridge/reverse.ts`:
```ts
import { reverse, type AllocationDocument, type AllocationResult, type ReversalResult } from "mdrl/allocation";
import type { Tx } from "../platform/db.ts";
import { DomainError, invalid, notFound } from "../platform/errors.ts";
import type { BridgeCtx } from "./context.ts";
import { loadSealed, sealDocument } from "./seal-store.ts";

export type ReversalRows = {
  sequence: number; resultDigest: string;
  pool: { bucket: string; amount: bigint }[];
  lines: { party: string; role: string; bucket: string; lineSeq: number; reversesLineSeq: number; amount: bigint }[];
  holdings: { bucket: string; reason: "RIGHTS_DISPUTE" | "FRAUD_REVIEW"; amount: bigint }[];
};

/** 원 run의 봉인 결과와 그 이벤트의 이전 역분개 봉인(순서대로)으로 mdrl reverse를 호출하고 결과를 봉인한다(통합 설계 10.2-9). */
export async function reverseEvent(
  ctx: BridgeCtx, tx: Tx, input: { originalRunId: string; eventId: string; refundEventId: string; amount: bigint; reversalId: string },
): Promise<ReversalRows> {
  const run = (await tx.query(
    "SELECT r.result_digest, s.policy_digest FROM settlement_run r JOIN issue_seal s ON s.snapshot_id = r.snapshot_id WHERE r.run_id = $1",
    [input.originalRunId],
  )).rows[0];
  if (run === undefined || run.result_digest === null) throw notFound("settled run", input.originalRunId);
  const original = (await loadSealed(ctx, tx, run.result_digest)) as AllocationResult;
  const policy = (await loadSealed(ctx, tx, run.policy_digest)) as AllocationDocument;
  const priorRows = (await tx.query(
    "SELECT result_digest FROM reversal_run WHERE original_run_id = $1 AND event_id = $2 ORDER BY sequence", [input.originalRunId, input.eventId],
  )).rows;
  const priors: ReversalResult[] = [];
  for (const p of priorRows) priors.push((await loadSealed(ctx, tx, p.result_digest)) as ReversalResult);
  const r = reverse({
    original, policy, eventId: input.eventId, priors, runId: input.reversalId,
    refund: { id: input.refundEventId, reason: "REFUND", amount: input.amount.toString() },
  });
  if (!r.ok) {
    if (r.errors.some((e) => e.code === "REV_EXCEEDS_REMAINING")) throw invalid("REFUND_EXCEEDS_SETTLED", "refund exceeds the settled amount", r.errors);
    throw new DomainError("REVERSAL_FAILED", 500, `reversal of ${input.eventId} failed`, r.errors);
  }
  const sealed = await sealDocument(ctx, tx, { kind: "reversal_result", value: r.value, docId: input.reversalId, format: r.value.format });
  return {
    sequence: Number(r.value.sequence), resultDigest: sealed.digest,
    pool: r.value.pool_lines.map((p) => ({ bucket: p.bucket, amount: BigInt(p.amount) })),
    lines: r.value.lines.map((l) => ({ party: l.party, role: l.role, bucket: l.bucket, lineSeq: Number(l.line_seq), reversesLineSeq: Number(l.reverses_line_seq), amount: BigInt(l.amount) })),
    holdings: r.value.holdings.map((h) => ({ bucket: h.bucket, reason: h.reason, amount: BigInt(h.amount) })),
  };
}
```

`rights-core/src/settlement/service.ts`에 추가(import에 `type RefundHook`를 `../revenue/service.ts`에서):
```ts
/** 환불이 기록된 트랜잭션에서 refund-recorded 작업을 보낸다(revenue는 settlement를 모른다). */
export function refundHook(jobs: Jobs): RefundHook {
  return (tx, refundEventId) => jobs.send(tx, "refund-recorded", { refundEventId });
}
```

`rights-core/src/settlement/handlers.ts`에 추가(import에 `revenueRow`, `refundedTotal`을 `../revenue/service.ts`에서, `reverseEvent`를 `../engine-bridge/reverse.ts`에서):
```ts
/**
 * refund-recorded(통합 설계 10.2-8): 원 이벤트가 살아 있는 run에 있으면 그 run을 잠근다.
 * 이미 이 환불까지 반영했으면 끝, 확정 전이면 VOIDED·이벤트 해제(다음 배치가 새 순액으로 평가), 확정이면 reverse-event.
 */
export async function refundRecorded(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const refund = await revenueRow(tx, data.refundEventId);
    const original = refund.relatedEventId!;
    const live = (await tx.query(
      "SELECT r.run_id, r.status, x.refunds_included_krw::text AS inc FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = $1 AND x.active",
      [original],
    )).rows[0];
    if (live === undefined) return;
    const run = (await tx.query("SELECT status FROM settlement_run WHERE run_id = $1 FOR UPDATE", [live.run_id])).rows[0];
    if (BigInt(live.inc) >= (await refundedTotal(tx, original))) return;
    if (run.status === "CONFIRMED") {
      await d.jobs.send(tx, "reverse-event", { refundEventId: data.refundEventId });
      return;
    }
    if (run.status === "FAILED" || run.status === "VOIDED") return;
    await tx.query("UPDATE settlement_run SET status = 'VOIDED', diagnostics = $2 WHERE run_id = $1", [live.run_id, JSON.stringify([{ code: "REFUND_BEFORE_CONFIRMATION", path: "$", message: data.refundEventId }])]);
    await releaseRunEvents(tx, live.run_id);
    await audit(tx, d.clock, { actor: SETTLER, action: "RUN_VOIDED_BY_REFUND", entityType: "settlement_run", entityId: live.run_id, after: { refund: data.refundEventId } });
  });
}

/** reverse-event(통합 설계 10.2-9): 환불 id로 멱등, 원 이벤트 행을 잠가 직렬화, 이전 역분개를 빠짐없이 넘긴다. */
export async function reverseEventJob(d: SettleDeps, data: { refundEventId: string }): Promise<void> {
  await d.db.tx(async (tx) => {
    const refund = await revenueRow(tx, data.refundEventId);
    const original = refund.relatedEventId!;
    const x = (await tx.query(
      "SELECT x.run_id FROM settlement_run_event x JOIN settlement_run r ON r.run_id = x.run_id WHERE x.event_id = $1 AND x.active AND r.status = 'CONFIRMED' FOR UPDATE OF x",
      [original],
    )).rows[0];
    if (x === undefined) return;
    const done = await tx.query("SELECT 1 FROM reversal_run WHERE refund_event_id = $1", [data.refundEventId]);
    if ((done.rowCount ?? 0) > 0) return;
    const reversalId = `rev_${data.refundEventId}`;
    const r = await reverseEvent(d.ctx, tx, { originalRunId: x.run_id, eventId: original, refundEventId: data.refundEventId, amount: BigInt(refund.amountKrw), reversalId });
    await tx.query(
      "INSERT INTO reversal_run (reversal_id, original_run_id, event_id, sequence, refund_event_id, result_digest, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [reversalId, x.run_id, original, r.sequence, data.refundEventId, r.resultDigest, d.clock.now()],
    );
    const seq = r.sequence + 1;
    for (const p of r.pool) {
      await tx.query("INSERT INTO pool_line (run_id, event_id, bucket, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [x.run_id, original, p.bucket, seq, p.amount.toString(), reversalId]);
    }
    for (const l of r.lines) {
      const orig = (await tx.query(
        "SELECT line_id FROM allocation_line WHERE run_id = $1 AND event_id = $2 AND party_id = $3 AND role = $4 AND bucket = $5 AND line_seq = $6",
        [x.run_id, original, l.party, l.role, l.bucket, l.reversesLineSeq],
      )).rows[0];
      await tx.query(
        `INSERT INTO allocation_line (run_id, event_id, party_id, role, bucket, line_seq, line_kind, amount_krw, reversal_of_line_id, reversal_id)
         VALUES ($1,$2,$3,$4,$5,$6,'REVERSAL',$7,$8,$9)`,
        [x.run_id, original, l.party, l.role, l.bucket, l.lineSeq, l.amount.toString(), orig.line_id, reversalId],
      );
    }
    for (const h of r.holdings) {
      await tx.query("INSERT INTO unallocated_holding (run_id, event_id, bucket, reason, line_seq, amount_krw, reversal_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [x.run_id, original, h.bucket, h.reason, seq, h.amount.toString(), reversalId]);
    }
    await audit(tx, d.clock, { actor: SETTLER, action: "EVENT_REVERSED", entityType: "reversal_run", entityId: reversalId, after: { sequence: r.sequence, amount: refund.amountKrw } });
  });
}
```
`jobHandlers`에 추가:
```ts
    "refund-recorded": (data) => refundRecorded(d, { refundEventId: data.refundEventId! }),
    "reverse-event": (data) => reverseEventJob(d, { refundEventId: data.refundEventId! }),
```
(`allocation_line`의 `line_seq`는 mdrl 역분개 라인의 `line_seq`(= sequence + 1)와 같다 — `seq`와 `l.lineSeq`가 다르면 계획이 틀린 것이니 보고한다.)

- [ ] **Step 5: 통과 확인**

Run: `cd rights-core && node --test test/settlement/refund.test.ts test/settlement/batch.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: refund 4 PASS, batch 통과, 전체 fail 0, `TSC_OK`.

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/migrations/0012_reversal.sql rights-core/src/engine-bridge/reverse.ts rights-core/src/settlement/service.ts rights-core/src/settlement/handlers.ts rights-core/test/settlement/refund.test.ts
git commit -m "feat(rights-core): 환불 처리(순액·run 무효화·확정 후 역분개)와 reverse-event 작업

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: HTTP API와 워커 연결

**Files:**
- Create: `rights-core/src/revenue/routes.ts`, `rights-core/src/settlement/routes.ts`, `rights-core/test/http/settlement-api.test.ts`
- Modify: `rights-core/src/http/server.ts`(`Deps`에 `jobs: Jobs` 추가, 라우트 등록), `rights-core/src/http/main.ts`(pg-boss 시작·워커 등록·종료), `rights-core/test/http/api.test.ts`(`buildServer` 호출에 `jobs: recordingJobs()` 추가)

**Interfaces:**
- Consumes: 모든 서비스, `withActor`, `Deps`.
- Produces: 라우트

| 메서드·경로 | 서비스 | 역할 | 성공 |
|---|---|---|---|
| `POST /revenue-events` | `ingestRevenue(..., refundHook(deps.jobs))` | SYSTEM | 201 `{eventId, created}`(재전송이면 200) |
| `POST /batches` `{batchId, periodStart, periodEnd}` | `createBatch` | SPACE_OPS | 201 |
| `GET /batches/:id` | `batchView` | (신원 불필요, PoC) | 200 |
| `POST /batches/:id/confirm` | `confirmBatch` | SPACE_SETTLE | 200 `{manifestDigest}` |
| `GET /runs/:id` | run 행 + 라인·보류 합계 | (신원 불필요) | 200 `{runId, status, eventsDigest, resultDigest, lines, holdings}` |

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/http/settlement-api.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { recordingJobs } from "../../src/platform/jobs.ts";
import { buildServer } from "../../src/http/server.ts";
import { jobHandlers } from "../../src/settlement/handlers.ts";
import { issueCombo, settlementWorld } from "../settlement-fixtures.ts";

const w = await settlementWorld();
const jobs = recordingJobs();
const app = buildServer({ db: w.db, ctx: w.ctx, clock: w.clock, jobs });
after(async () => { await app.close(); await w.drop(); });
await issueCombo(w, "vc_1");
const post = (url: string, actor: string, payload: unknown) => app.inject({ method: "POST", url, headers: { "x-actor": actor }, payload: payload as object });
const ev = (id: string, extra: object = {}) => ({ eventId: id, sourceSystem: "app", sourceEventId: id, eventType: "PURCHASE", vcId: "vc_1", amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-01T10:00:00.000Z", ...extra });

test("revenue → batch → jobs → confirm → refund → reversal over HTTP", async () => {
  assert.equal((await post("/revenue-events", "usr_ops", ev("ev_h1"))).statusCode, 403);
  assert.equal((await post("/revenue-events", "sys_ingest", ev("ev_h1"))).statusCode, 201);
  assert.equal((await post("/revenue-events", "sys_ingest", ev("ev_h1"))).statusCode, 200);
  assert.equal((await post("/revenue-events", "sys_ingest", { ...ev("ev_h1"), amountKrw: "1" })).statusCode, 409);
  const b = await post("/batches", "usr_ops", { batchId: "bat_h", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  assert.equal(b.statusCode, 201, b.body);
  await jobs.drain(jobHandlers({ db: w.db, ctx: w.ctx, clock: w.clock, jobs }));
  const view = await app.inject({ method: "GET", url: "/batches/bat_h" });
  assert.equal(view.json().progress, "READY");
  assert.equal((await post("/batches/bat_h/confirm", "usr_ops", {})).statusCode, 403);
  const c = await post("/batches/bat_h/confirm", "usr_settle", {});
  assert.equal(c.statusCode, 200, c.body);
  const runId = view.json().runs[0].runId;
  const run = await app.inject({ method: "GET", url: `/runs/${runId}` });
  assert.equal(run.json().status, "CONFIRMED");
  const rf = await post("/revenue-events", "sys_ingest", { eventId: "rf_h1", sourceSystem: "app", sourceEventId: "rf_h1", eventType: "REFUND", relatedEventId: "ev_h1", amountKrw: "10000", currency: "KRW", occurredAt: "2026-03-02T00:00:00.000Z" });
  assert.equal(rf.statusCode, 201, rf.body);
  await jobs.drain(jobHandlers({ db: w.db, ctx: w.ctx, clock: w.clock, jobs }));
  const after2 = await app.inject({ method: "GET", url: `/runs/${runId}` });
  assert.equal(after2.json().lines.net, "0");
  assert.equal((await post("/revenue-events", "sys_ingest", { eventId: "rf_h2", sourceSystem: "app", sourceEventId: "rf_h2", eventType: "REFUND", relatedEventId: "ev_h1", amountKrw: "1", currency: "KRW", occurredAt: "2026-03-02T00:00:00.000Z" })).statusCode, 422);
});
```
(`GET /runs/:id`의 `lines`는 `{ settle: "<SETTLE 합>", reversal: "<REVERSAL 합>", net: "<전체 합>" }`, `holdings`는 같은 형태.)

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/http/settlement-api.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현**

`rights-core/src/http/server.ts`: `Deps`를 `{ db: Db; ctx: BridgeCtx; clock: Clock; jobs: Jobs }`로 바꾸고 `revenueRoutes(app, deps)`·`settlementRoutes(app, deps)`를 등록한다.

`rights-core/src/revenue/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { ingestRevenue, type RevenueInput } from "./service.ts";
import { refundHook } from "../settlement/service.ts";

export function revenueRoutes(app: FastifyInstance, deps: Deps): void {
  app.post<{ Body: RevenueInput }>("/revenue-events", async (req, reply) => {
    const r = await withActor(deps, req, (tx, actor) => ingestRevenue(tx, deps.clock, actor, req.body, refundHook(deps.jobs)));
    return reply.status(r.created ? 201 : 200).send(r);
  });
}
```
(이 라우트 파일은 `settlement/service.ts`의 `refundHook`을 import한다 — 라우트 계층의 조립이므로 `revenue/service.ts`의 의존 방향 규칙은 지켜진다.)

`rights-core/src/settlement/routes.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { withActor, type Deps } from "../http/server.ts";
import { notFound } from "../platform/errors.ts";
import { batchView, confirmBatch, createBatch } from "./service.ts";

export function settlementRoutes(app: FastifyInstance, deps: Deps): void {
  const d = () => ({ db: deps.db, ctx: deps.ctx, clock: deps.clock, jobs: deps.jobs });
  app.post<{ Body: { batchId: string; periodStart: string; periodEnd: string } }>("/batches", async (req, reply) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return reply.status(201).send(await createBatch(d(), actor, req.body));
  });
  app.get<{ Params: { id: string } }>("/batches/:id", async (req) => deps.db.tx((tx) => batchView(tx, req.params.id)));
  app.post<{ Params: { id: string } }>("/batches/:id/confirm", async (req) => {
    const actor = await withActor(deps, req, async (_tx, a) => a);
    return confirmBatch(d(), actor, req.params.id);
  });
  app.get<{ Params: { id: string } }>("/runs/:id", async (req) => deps.db.tx(async (tx) => {
    const r = (await tx.query("SELECT run_id, status, events_digest, result_digest FROM settlement_run WHERE run_id = $1", [req.params.id])).rows[0];
    if (r === undefined) throw notFound("run", req.params.id);
    const sums = async (table: string) => (await tx.query(
      `SELECT COALESCE(SUM(amount_krw) FILTER (WHERE line_seq = 1), 0)::text AS settle,
              COALESCE(SUM(amount_krw) FILTER (WHERE line_seq > 1), 0)::text AS reversal,
              COALESCE(SUM(amount_krw), 0)::text AS net FROM ${table} WHERE run_id = $1`, [req.params.id],
    )).rows[0];
    return { runId: r.run_id, status: r.status, eventsDigest: r.events_digest, resultDigest: r.result_digest, lines: await sums("allocation_line"), holdings: await sums("unallocated_holding") };
  }));
}
```
(`createBatch`·`confirmBatch`는 자기 트랜잭션을 연다. 신원만 `withActor`로 읽는다 — `withActor`가 신원을 읽는 트랜잭션을 따로 여는 것은 허용한다. 입력 검증: `/batches` 본문의 세 필드가 문자열이 아니면 400 `BAD_REQUEST`.)

`rights-core/src/http/main.ts`: `startBossJobs(url)`로 `jobs`를 만들고, `buildServer({ db, ctx, clock: systemClock, jobs })`, `await jobs.work(jobHandlers({ db, ctx, clock: systemClock, jobs }) as Record<JobName, JobHandler>)`, 종료 시 `await jobs.stop()`.

`rights-core/test/http/api.test.ts`의 `buildServer({ db, ctx, clock })`를 `buildServer({ db, ctx, clock, jobs: recordingJobs() })`로 바꾼다(import 추가).

- [ ] **Step 4: 통과 확인**

Run: `cd rights-core && node --test test/http/settlement-api.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 통과, 전체 fail 0, `TSC_OK`.

- [ ] **Step 5: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/revenue/routes.ts rights-core/src/settlement/routes.ts rights-core/src/http/server.ts rights-core/src/http/main.ts rights-core/test/http/settlement-api.test.ts rights-core/test/http/api.test.ts
git commit -m "feat(rights-core): 수익·정산 HTTP API와 pg-boss 워커 연결

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 정산 시나리오와 결과 기록

**Files:**
- Create: `rights-core/src/scenario/settlement.ts`, `rights-core/test/scenario/settlement.test.ts`
- Modify: `rights-core/src/scenario/main.ts`, `02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md`(10.4)

**Interfaces:**
- Consumes: I-1 시나리오(`runScenario`가 남긴 DB 상태 — 1만 조합 발행), Task 1~6, 실제 pg-boss(`startBossJobs`).
- Produces:
```ts
export type SettlementReport = { purchases: number; refundsPre: number; refundsPost: number; runs: number; verified: number;
  batchMs: number; settleMs: number; conservationOk: boolean; verifyMismatches: number; reversals: number; reversalNetZeroOk: boolean };
export async function runSettlementScenario(deps: { db: Db; ctx: BridgeCtx; appUrl: string }, opts: { purchases: number; seed: number }): Promise<SettlementReport>;
```

- [ ] **Step 1: 실패하는 테스트 작성**

`rights-core/test/scenario/settlement.test.ts`:
```ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFreshDatabase, ADMIN_URL } from "../../src/platform/dbadmin.ts";
import { createDb } from "../../src/platform/db.ts";
import { tempBridge } from "../fixtures.ts";
import { runScenario } from "../../src/scenario/run.ts";
import { runSettlementScenario } from "../../src/scenario/settlement.ts";

const fresh = await createFreshDatabase(ADMIN_URL);
const db = createDb(fresh.appUrl);
const { ctx, cleanup } = tempBridge();
after(async () => { await db.close(); await fresh.drop(); cleanup(); });

test("reduced settlement scenario: 100 issues, 300 purchases, refunds before and after confirmation", async () => {
  await runScenario({ db, ctx }, { n: 100, seed: 7 });
  const r = await runSettlementScenario({ db, ctx, appUrl: fresh.appUrl }, { purchases: 300, seed: 7 });
  assert.equal(r.verified, r.runs);
  assert.equal(r.verifyMismatches, 0);
  assert.equal(r.conservationOk, true);
  assert.equal(r.reversalNetZeroOk, true);
  assert.ok(r.reversals > 0 && r.refundsPre > 0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd rights-core && node --test test/scenario/settlement.test.ts`
Expected: FAIL (모듈 없음).

- [ ] **Step 3: 구현**

`rights-core/src/scenario/settlement.ts`의 흐름(모든 단계는 서비스 함수를 직접 호출하고, 작업은 **실제 pg-boss**로 처리한다):
1. 사용자 `usr_ops`(SPACE_OPS)·`usr_settle`(SPACE_SETTLE)·`sys_ingest`·`sys_settler`·`sys_verifier`(SYSTEM)를 만든다. `startBossJobs(appUrl)`로 작업 큐를 시작하고 `jobHandlers`를 등록한다.
2. `issue_seal`이 있는 `vc_id` 목록(`rights_snapshot`)에서 시드 난수(`mulberry32`)로 골라 `opts.purchases`건의 `PURCHASE`를 넣는다(금액 1,000~50,000원, `occurredAt`은 2026-03 안에서 증가, 1%는 `FLAGGED`).
3. 구매의 5%에 **배치 전 환불**(원 금액의 1~100%, 일부는 전액)을 넣는다(`refundHook` 사용).
4. 배치 `bat_2026_03`(2026-03 전체)를 만들고 `drainIdle`로 모든 작업이 끝날 때까지 기다린다(생성·처리 시간 측정).
5. 모든 run이 `VERIFIED`인지, 검증 불일치(`VOIDED` + `RUN_VERIFY_MISMATCH` 감사)가 0인지 센다.
6. **보존식**: 확정 전 모든 run에 대해 `Σ pool_line(line_seq=1) = Σ settlement_run_event.net_amount_krw`, 그리고 권리 풀 버킷(`rights`)의 합 = `Σ allocation_line(line_seq=1) + Σ unallocated_holding(line_seq=1)`인지 SQL로 확인한다.
7. 배치를 확정한다.
8. 확정된 이벤트의 3%에 **확정 후 환불**을 넣는다 — 그중 절반은 두 번에 나눠 전액을 환불한다. `drainIdle`로 역분개가 끝날 때까지 기다린다.
9. 전액 환불된 이벤트마다 확정 run의 `pool_line`·`allocation_line`·`unallocated_holding` 순합이 0인지 확인한다(`reversalNetZeroOk`).
10. `jobs.stop()` 후 리포트를 돌려준다.

`rights-core/src/scenario/main.ts`: 기존 I-1 시나리오 뒤에 `--settle` 옵션(기본 30000건)이 있으면 `runSettlementScenario`를 이어서 돌리고 두 리포트를 함께 출력한다. `SCENARIO PASS` 조건에 `verifyMismatches === 0 && conservationOk && reversalNetZeroOk && verified === runs`를 더한다.

(코드는 기존 `src/scenario/run.ts`의 스타일 — 시드 난수, `performance.now()` 측정, 서비스 직접 호출 — 을 따른다. 쿼리는 모두 파라미터 바인딩을 쓴다.)

- [ ] **Step 4: 통과 확인과 전체 실행**

Run: `cd rights-core && node --test test/scenario/settlement.test.ts && npm test 2>&1 | grep -E "^not ok|^ℹ (tests|pass|fail)" && npx tsc -p tsconfig.json && echo TSC_OK`
Expected: 통과, 전체 fail 0, `TSC_OK`.

Run: `cd rights-core && npm run scenario -- --settle 30000 2>&1 | tail -30`
Expected: 두 리포트와 마지막 줄 `SCENARIO PASS`. 실패하면 원인을 조사해 고친다(조건을 느슨하게 하지 않는다). 처리 시간이 길면 값을 그대로 기록한다.

- [ ] **Step 5: 결과 기록**

`02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md` 10절 끝에 실제 값으로 채운 표를 추가한다:
```markdown
### 10.4 I-2a 결과 (YYYY-MM-DD)

| 항목 | 결과 |
|---|---|
| 테스트 | rights-core <n>개 통과, mdrl <n>개 통과 |
| 시나리오 매출 / 배치 전 환불 / 확정 후 환불 | <purchases> / <refundsPre> / <refundsPost>건 |
| run / 검증 통과 / 재계산 불일치 | <runs> / <verified> / <verifyMismatches> |
| 보존식(풀 = 순매출, 권리 풀 = 라인 + 보류) | 통과/실패 |
| 역분개 / 전액 환불 순합 0 | <reversals>건 / 통과/실패 |
| 배치 생성 / 정산·검증 처리 시간 | <batchMs> / <settleMs> ms |
| 실행 환경 | <macOS·Node·PostgreSQL·pg-boss 버전>, 로컬 Docker, pg-boss 워커 단일 프로세스 |
```

- [ ] **Step 6: 커밋**

```bash
cd "/Users/changkyuneun/Vocal Combination/03_구현문서_코드"
git add rights-core/src/scenario/settlement.ts rights-core/src/scenario/main.ts rights-core/test/scenario/settlement.test.ts "../02_MDRL_언어규격/02_구현계획/MDRL_시스템통합_아키텍처_설계_v1.0.md"
git commit -m "feat(rights-core): 정산 시나리오(3만 건·환불·역분개)와 I-2a 결과 기록

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
