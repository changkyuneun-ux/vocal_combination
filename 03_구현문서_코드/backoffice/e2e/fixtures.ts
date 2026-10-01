import { expect, test as base, type APIRequestContext, type Page } from "@playwright/test";

/** 백엔드에 직접 호출한다(브라우저는 Vite 프록시 /api를 쓰지만, 검증 보조 호출은 같은 서버의 8080으로 간다). */
export const BACKEND = "http://127.0.0.1:8080";

/**
 * 사전 조건 확인(워커마다 한 번, 이 test를 쓰는 모든 spec에 자동 적용): 개발 서버가 RC_DEV=1로 떠 있어야 한다
 * (`npm run dev:db -w rights-core`를 한 번 실행했어야 한다). spec은 @playwright/test가 아니라 이 파일의 test·expect를 import한다.
 */
export const test = base.extend<object, { devServerCheck: void }>({
  devServerCheck: [async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext();
    const res = await ctx.get(`${BACKEND}/dev/clock`).catch(() => null);
    await ctx.dispose();
    if (res === null || res.status() === 404 || !res.ok()) {
      throw new Error(
        `rights-core 개발 서버(${BACKEND}/dev/clock)가 응답하지 않거나 404다. 먼저 docker compose up -d 와 npm run dev:db -w rights-core 를 실행하고 npm run dev --prefix ../rights-core 로 RC_DEV 모드 서버를 띄운다.`,
      );
    }
    await use();
  }, { auto: true, scope: "worker" }],
});
export { expect };

export type ApiResult<T = unknown> = { status: number; body: T };

/** 직접 API 호출(검증 보조). actor가 null이면 x-actor 없이(개발 경로). 2xx가 아니어도 던지지 않고 돌려준다. */
export async function api<T = unknown>(
  request: APIRequestContext, actor: string | null, method: "GET" | "POST" | "PUT", path: string, body?: unknown,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (actor) headers["x-actor"] = actor;
  const res = await request.fetch(`${BACKEND}${path}`, { method, headers, data: body });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* JSON 아님 */ }
  return { status: res.status(), body: parsed as T };
}

/** 2xx만 허용하는 호출. 아니면 상태·본문을 담아 던진다. */
export async function ok<T = unknown>(
  request: APIRequestContext, actor: string | null, method: "GET" | "POST" | "PUT", path: string, body?: unknown,
): Promise<T> {
  const r = await api<T>(request, actor, method, path, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} as ${actor ?? "-"} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** 개발 DB 초기화(시계·사용자 복원 포함). /dev/reset은 TRUNCATE 전에 모든 큐를 멈추고 pg-boss offWork가 진행 중 작업을 기다리므로 이전 시나리오의 작업과 경합하지 않는다. */
export async function resetAll(request: APIRequestContext): Promise<void> {
  await ok(request, null, "POST", "/dev/reset", {});
}

/** 헤더의 사용자 전환 select를 바꾼다. */
export async function as(page: Page, userId: string): Promise<void> {
  await page.getByLabel("사용자 전환").selectOption(userId);
}

/** 헤더 가상 시계 버튼("+1시간", "+1일", "+3일", "+30일")을 누른다. */
export async function advance(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
}

/** 조건이 참이 될 때까지 500ms 간격으로 최대 30초 재조회한다. */
export async function poll<T>(what: string, fn: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (done(last)) return last;
    if (Date.now() > end) throw new Error(`시간 초과(${timeoutMs}ms): ${what}; 마지막 값 ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

type Paged<T> = { items: T[]; next: string | null };
type Seed = { packId: string; factsScopeId: string; policyId: string; policyText: string };

export type Settled = {
  packId: string; factsScopeId: string; policyId: string;
  vcIds: string[]; eventIds: string[]; flaggedEventId: string;
  batchId: string; runIds: string[];
  /** 정산 반영(분개) 뒤의 가상 시계 */
  clockNow: string;
};

export const SLOTS = ["slt_1", "slt_2", "slt_3", "slt_4"] as const;
const PERIOD_START = "2026-03-01T00:00:00.000Z";
const PERIOD_END = "2026-04-01T00:00:00.000Z";

/**
 * 정산이 끝난 상태까지 API만으로 만든다(Task 10 계약 테스트와 Task 11 시나리오가 쓴다):
 * reset → 합성 곡 시드 → 정책 컴파일·승인·활성 → 팩 활성 → 조합 발행 3개 → 구매(1건 FLAGGED) → 시계 설정 →
 * 배치 → 모든 run VERIFIED 대기 → 확정 → 확정 run 수만큼 SETTLEMENT 분개가 생길 때까지 대기.
 */
export async function prepareSettled(request: APIRequestContext): Promise<Settled> {
  await resetAll(request);
  await ok(request, null, "POST", "/dev/seed/synthetic-song", {});
  const seed = await ok<Seed>(request, null, "GET", "/dev/seed/synthetic-song");
  const { packId, policyId } = seed;

  await ok(request, "usr_editor", "POST", `/policies/${policyId}/compile`, { packId, sourceText: seed.policyText });
  await ok(request, "usr_approver", "POST", `/policies/${policyId}/versions/1/approve`, {});
  await ok(request, "usr_activator", "POST", `/policies/${policyId}/versions/1/activate`, {});
  await ok(request, "usr_activator", "POST", `/packs/${packId}/activate`, {});

  // 슬롯 4개 + MR. 멤버 조합 3가지(각 슬롯의 담당 멤버 a·b·c).
  const picks = [["a", "b", "c", "a"], ["b", "b", "c", "c"], ["c", "a", "b", "a"]];
  const vcIds: string[] = [];
  for (const [i, pick] of picks.entries()) {
    const vcId = `vc_e2e_${i + 1}`;
    const members: Record<string, number> = {};
    for (const m of pick) members[`pty_member_${m}`] = (members[`pty_member_${m}`] ?? 0) + 2500;
    await ok(request, "usr_issuer", "POST", "/issues", {
      packId, vcId,
      assignments: [...SLOTS.map((s, k) => ({ slotId: s, stemId: `stm_${pick[k]}_${s}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
      members,
    });
    vcIds.push(vcId);
  }

  // 구매(sys_ingest): 3월 중. 마지막 1건은 FLAGGED.
  const eventIds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const eventId = `ev_e2e_${i + 1}`;
    await ok(request, "sys_ingest", "POST", "/revenue-events", {
      eventId, sourceSystem: "app", sourceEventId: eventId, eventType: "PURCHASE", vcId: vcIds[i % vcIds.length],
      amountKrw: String(10_000 * (i + 1)), currency: "KRW", integrity: i === 3 ? "FLAGGED" : "CLEAR",
      occurredAt: `2026-03-${String(5 + i).padStart(2, "0")}T00:00:00.000Z`,
    });
    eventIds.push(eventId);
  }
  const flaggedEventId = eventIds[3]!;

  await ok(request, null, "POST", "/dev/clock/set", { at: "2026-04-02T00:00:00.000Z" });
  const batchId = "bat_e2e_1";
  const created = await ok<{ runs: unknown[]; skipped: unknown[] }>(request, "usr_ops", "POST", "/batches", { batchId, periodStart: PERIOD_START, periodEnd: PERIOD_END });
  expect(created.runs.length, "발행 조합마다 run 1개").toBe(vcIds.length);
  expect(created.skipped, "건너뛴 이벤트 없음").toEqual([]);

  const runs = await poll(
    "배치의 모든 run이 VERIFIED",
    async () => {
      const items = (await ok<Paged<{ runId: string; status: string }>>(request, "usr_ops", "GET", `/batches/${batchId}/runs?limit=200`)).items;
      const failed = items.filter((r) => r.status === "FAILED");
      if (failed.length > 0) throw new Error(`run이 FAILED: ${failed.map((r) => r.runId).join(", ")}`);
      return items;
    },    (rs) => rs.length > 0 && rs.every((r) => r.status === "VERIFIED"),
  );
  const runIds = runs.map((r) => r.runId);

  await ok(request, "usr_settle", "POST", `/batches/${batchId}/confirm`, {});
  await poll(
    "확정 run 수만큼 SETTLEMENT 분개",
    async () => {
      const es = await ok<Paged<{ sourceRef: string }>>(request, "usr_settle", "GET", "/ledger/entries?kind=SETTLEMENT&limit=200");
      const refs = new Set(es.items.map((e) => e.sourceRef));
      return runIds.filter((id) => refs.has(`run:${id}`)).length;
    },
    (n) => n === runIds.length,
  );
  const clock = await ok<{ now: string }>(request, null, "GET", "/dev/clock");
  expect(runIds.length).toBeGreaterThan(0);
  return { packId, factsScopeId: seed.factsScopeId, policyId, vcIds, eventIds, flaggedEventId, batchId, runIds, clockNow: clock.now };
}
