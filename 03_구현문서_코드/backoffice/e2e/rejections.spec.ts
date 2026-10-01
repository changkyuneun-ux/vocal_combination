import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { api, as, expect, ok, poll, prepareSettled, resetAll, test } from "./fixtures.ts";

/**
 * 거부 경로 5개(통합 설계 12.3). 각 테스트는 resetAll로 시작하고(prepareSettled도 reset부터 한다), 준비는 api 보조로 빠르게 만든 뒤
 * 거부되는 동작과 그 결과 확인만 화면으로 한다.
 */

type Paged<T> = { items: T[]; next: string | null };
type Seed = { packId: string; policyId: string; policyText: string };
type Instruction = { instructionId: string; partyId: string; status: string; holdReason: string | null; grossKrw: string };

const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const bodyRows = (scope: Locator) => scope.locator("tbody > tr");
const DAY_MS = 86_400_000;

/** reset → 합성 곡 시드 → 정책 컴파일(usr_editor). activate면 승인·활성화와 팩 활성화까지. */
async function preparePolicy(request: APIRequestContext, activate: boolean): Promise<Seed> {
  await resetAll(request);
  await ok(request, null, "POST", "/dev/seed/synthetic-song", {});
  const seed = await ok<Seed>(request, null, "GET", "/dev/seed/synthetic-song");
  await ok(request, "usr_editor", "POST", `/policies/${seed.policyId}/compile`, { packId: seed.packId, sourceText: seed.policyText });
  if (activate) {
    await ok(request, "usr_approver", "POST", `/policies/${seed.policyId}/versions/1/approve`, {});
    await ok(request, "usr_activator", "POST", `/policies/${seed.policyId}/versions/1/activate`, {});
    await ok(request, "usr_activator", "POST", `/packs/${seed.packId}/activate`, {});
  }
  return seed;
}

/** 미지급금 계정이 있는 권리자 전원의 지급 프로필을 usr_settle2로 등록한다(지급 실행자 usr_settle과 달라 ACCOUNT_SOD가 아니다). */
async function registerProfiles(request: APIRequestContext): Promise<string[]> {
  const parties = (await ok<Paged<{ kind: string; partyId: string | null }>>(request, "usr_settle", "GET", "/ledger/accounts?limit=200")).items
    .filter((a) => a.kind === "PARTY_PAYABLE" && a.partyId !== null).map((a) => a.partyId!);
  expect(parties.length).toBeGreaterThan(0);
  for (const p of parties) {
    await ok(request, "usr_settle2", "PUT", `/parties/${p}/payout-profile`, { taxType: "DOMESTIC_INDIVIDUAL", kycVerified: true, payoutAccountRef: `acct_${p}` });
  }
  return parties;
}

const instructionsOf = async (request: APIRequestContext, runId: string) =>
  (await ok<Paged<Instruction>>(request, "usr_settle", "GET", `/payout-runs/${runId}/instructions?limit=200`)).items;

/** 화면에서 지급 run을 만들고(usr_settle, asOf = 현재) 상세로 가서 run id를 돌려준다. */
async function runPayoutInUi(page: Page): Promise<string> {
  await page.goto("/payout/runs");
  await as(page, "usr_settle");
  await page.getByRole("button", { name: "지급 run 만들기", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "지급 run을 만들었습니다" }).getByRole("link").click();
  await expect(page).toHaveURL(/\/payout\/runs\/pr-/);
  return decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
}

test.describe("거부 경로", () => {
  test.afterEach(async ({ request }) => {
    // 4번이 멈춘 submit-payout을 실패해도 다시 연다(초기화도 일시정지를 푼다).
    await api(request, null, "POST", "/dev/jobs/resume", { name: "submit-payout" }).catch(() => undefined);
  });

  test("1. 정산 불가 조합(멤버 a가 4슬롯 모두) → ISSUE_NOT_SETTLEABLE, 발행 목록 변화 없음", async ({ page, request }) => {
    const seed = await preparePolicy(request, true);
    await page.goto(`/packs/${seed.packId}`);
    await as(page, "usr_issuer");
    const list = region(page, "발행 목록");
    await expect(list).toContainText("발행이 없습니다.");
    for (const slot of ["slt_1", "slt_2", "slt_3", "slt_4"]) await page.getByLabel(`${slot} 스템`).selectOption(`stm_a_${slot}`);
    await page.getByLabel("slt_mr 스템").selectOption("stm_mr");
    await expect(page.getByRole("status").filter({ hasText: "합계" })).toHaveText("합계 10000 / 10000");
    await page.getByRole("button", { name: "발행", exact: true }).click();
    const issueSection = region(page, "조합 발행");
    await expect(issueSection.locator(".error-panel")).toContainText("ISSUE_NOT_SETTLEABLE");
    await expect(list).toContainText("발행이 없습니다.");
    expect((await ok<Paged<unknown>>(request, "usr_issuer", "GET", "/issues")).items).toHaveLength(0);
  });

  test("2. 같은 사용자의 승인·활성화 → ROLE_REQUIRED, 정책 활성 아님", async ({ page, request }) => {
    const seed = await preparePolicy(request, false);
    await page.goto(`/policy/${seed.policyId}`);
    await as(page, "usr_approver");
    const ver = region(page, "버전").locator("li.ver").first();
    await expect(ver.locator(".badge")).toHaveText("COMPILED");
    await page.getByRole("button", { name: `${seed.policyId} 버전 1 승인`, exact: true }).click();
    await expect(ver.locator(".badge")).toHaveText("APPROVED");
    // 같은 사용자(usr_approver)가 활성화: 활성화 역할이 없어 requireRole이 먼저 거부한다(policy/service.ts activatePolicy).
    // 직무 분리 코드 SOD_VIOLATION(같은 digest에 이미 서명한 사람)도 서비스에 있지만, 승인·활성화 두 역할을 함께 가진 개발 사용자가 없어
    // 화면으로는 닿을 수 없다(사용자를 만드는 API도 없다) — 이 테스트는 역할 거부만 단언한다.
    await page.getByRole("button", { name: `${seed.policyId} 버전 1 활성화`, exact: true }).click();
    await expect(ver.locator(".error-panel")).toContainText("ROLE_REQUIRED");
    await expect(ver.locator(".badge")).toHaveText("APPROVED");
    const policies = await ok<Paged<{ policyId: string; activeVersion: number | null }>>(request, "usr_editor", "GET", "/policies");
    expect(policies.items.find((p) => p.policyId === seed.policyId)?.activeVersion ?? null).toBeNull();
  });

  test("3. 계좌 냉각 중 지급 실행 → HELD + ACCOUNT_COOLING", async ({ page, request }) => {
    test.setTimeout(180_000);
    await prepareSettled(request);
    const parties = await registerProfiles(request);
    // 시계를 움직이지 않고 곧바로 지급 실행.
    await runPayoutInUi(page);
    const rows = bodyRows(region(page, "지시 표"));
    await expect(rows).toHaveCount(parties.length);
    for (const p of parties) {
      const row = rows.filter({ has: page.getByRole("cell", { name: p, exact: true }) });
      await expect(row.locator(".badge")).toHaveText("HELD");
      await expect(row).toContainText("ACCOUNT_COOLING");
    }
    await rows.first().getByRole("link").click();
    await expect(page).toHaveURL(/\/payout\/instructions\//);
    const head = page.getByRole("region", { name: /^지급 지시 / });
    await expect(head.locator(".badge").first()).toHaveText("HELD");
    await expect(head).toContainText("보류 사유 ACCOUNT_COOLING");
  });

  test("4. 지급 판정 뒤 계좌 토큰 변경 → FAILED + ACCOUNT_CHANGED, PSP submit 없음", async ({ page, request }) => {
    test.setTimeout(180_000);
    await prepareSettled(request);
    await registerProfiles(request);
    await ok(request, null, "POST", "/dev/clock/advance", { ms: 31 * DAY_MS }); // 초기 보류 30일·냉각 72시간이 지나게
    await ok(request, null, "POST", "/dev/jobs/pause", { name: "submit-payout" });

    const runId = await runPayoutInUi(page);
    const pending = await poll("PENDING 지시", () => instructionsOf(request, runId), (xs) => xs.some((x) => x.status === "PENDING"));
    const target = pending.find((x) => x.status === "PENDING")!;
    const row = bodyRows(region(page, "지시 표")).filter({ has: page.getByRole("cell", { name: target.partyId, exact: true }) });
    await expect(row.locator(".badge")).toHaveText("PENDING");

    // usr_settle2가 화면에서 그 권리자의 계좌 토큰을 바꾼다.
    await page.goto("/payout/profiles");
    await as(page, "usr_settle2");
    const p = target.partyId;
    await page.getByRole("button", { name: `권리자[${p}] 프로필 편집`, exact: true }).click();
    await page.getByLabel(`권리자[${p}] 계좌 토큰 입력`).fill(`acct_${p}_v2`);
    await page.getByRole("button", { name: `권리자[${p}] 프로필 저장`, exact: true }).click();
    const profileRow = region(page, "권리자별 프로필").getByRole("row").filter({ has: page.getByRole("cell", { name: p, exact: true }) });
    await expect(profileRow).toContainText(`acct_${p}_v2`);

    await ok(request, null, "POST", "/dev/jobs/resume", { name: "submit-payout" });
    await page.goto(`/payout/instructions/${encodeURIComponent(target.instructionId)}`);
    await as(page, "usr_settle");
    const head = page.getByRole("region", { name: `지급 지시 ${target.instructionId}`, exact: true });
    // 지시 상세는 PENDING 동안 3초마다 갱신한다.
    await expect(head.locator(".badge").first()).toHaveText("FAILED", { timeout: 60_000 });
    await expect(head).toContainText("실패 사유 ACCOUNT_CHANGED");

    // PSP 요청 기록에 그 지시의 submit이 없다.
    const reqs = await ok<{ items: { op: string; instructionId: string }[] }>(request, null, "GET", "/dev/psp/requests");
    expect(reqs.items.filter((r) => r.instructionId === target.instructionId)).toEqual([]);
    await page.goto("/dev/psp");
    const log = region(page, "PSP 요청 기록");
    await expect(log.getByText(/PSP 요청 기록이 없습니다|submit|status/).first()).toBeVisible();
    await expect(log.getByRole("cell", { name: target.instructionId, exact: true })).toHaveCount(0);
  });

  test("5. 중복 webhook(repeat 2) → 응답 둘 다 성공, webhook 이력 1건, PAYOUT_SETTLED 1건", async ({ page, request }) => {
    test.setTimeout(180_000);
    await prepareSettled(request);
    await registerProfiles(request);
    await ok(request, null, "POST", "/dev/clock/advance", { ms: 31 * DAY_MS });
    const now = (await ok<{ now: string }>(request, null, "GET", "/dev/clock")).now;
    const runId = "pr-e2e-dup-1";
    await ok(request, "usr_settle", "POST", "/payout-runs", { payoutRunId: runId, asOf: now });
    const xs = await poll("SUBMITTED 지시", () => instructionsOf(request, runId), (ys) => ys.some((y) => y.status === "SUBMITTED") && !ys.some((y) => y.status === "PENDING"));
    const target = xs.find((x) => x.status === "SUBMITTED")!;

    await page.goto(`/dev/psp?instruction=${encodeURIComponent(target.instructionId)}`);
    await as(page, "usr_settle");
    const focused = region(page, "지정한 지시");
    await focused.getByLabel(`지시[${target.instructionId}] webhook 반복`).selectOption("2");
    await focused.getByRole("button", { name: `지시[${target.instructionId}] webhook 보내기`, exact: true }).click();
    const res = bodyRows(focused.getByRole("table", { name: `지시[${target.instructionId}] webhook 응답` }));
    await expect(res).toHaveCount(2);
    // 둘 다 성공: 처음은 201(created), 중복은 200(created: false) — payout/routes.ts.
    await expect(res.nth(0).locator("td").nth(1)).toHaveText("201");
    await expect(res.nth(1).locator("td").nth(1)).toHaveText("200");
    await expect(res.nth(1).locator("td").nth(2)).toContainText('"created":false');

    await poll("PAYOUT_SETTLED 분개", async () => (await ok<Paged<unknown>>(request, "usr_settle", "GET", "/ledger/entries?kind=PAYOUT_SETTLED&limit=200")).items.length, (n) => n >= 1, 60_000);
    await page.goto(`/payout/instructions/${encodeURIComponent(target.instructionId)}`);
    const head = page.getByRole("region", { name: `지급 지시 ${target.instructionId}`, exact: true });
    await expect(head.locator(".badge").first()).toHaveText("PAID", { timeout: 30_000 });
    await expect(bodyRows(region(page, "webhook 이력"))).toHaveCount(1);

    await page.goto("/ledger");
    await page.getByLabel("종류 필터").selectOption("PAYOUT_SETTLED");
    await expect(bodyRows(region(page, "분개 목록"))).toHaveCount(1);
  });
});
