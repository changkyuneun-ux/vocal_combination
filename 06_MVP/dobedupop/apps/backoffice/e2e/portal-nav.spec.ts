import type { Page } from "@playwright/test";
import { BACKEND, expect, ok, resetAll, test } from "./fixtures.ts";
import { onboardBighit } from "./bighit.ts";

/**
 * 권리 테넌트 포털 사이드 메뉴·운영 관리·쪽 나눔(3부-A Task 7, 시안 Sidebar·Nav-Ops-Confirm·Ops-*).
 * 개발 서버(로컬)에서 돈다 — 데모 스택을 다시 빌드하지 않도록 stack-* 대신 개발 DB를 쓴다.
 */
async function actAs(page: Page, userId: string, path: string) {
  await page.evaluate((u) => localStorage.setItem("rc.actor.portal", u), userId);
  await page.goto(path);
}
const T0 = "2026-01-01T00:00:00.000Z";

test("사이드 메뉴 이동, 운영 관리 → 곡 워크스페이스, 원천 문서 쪽 나눔, 빈 화면", async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetAll(request);
  await onboardBighit(request);
  const p = (path: string, body: unknown) => ok(request, "usr_bh_rights", "POST", `/portal${path}`, body);
  await p("/works", { workId: "wrk_navtest", title: "Nav Test" });
  await p("/scopes", { factsScopeId: "fsc_navtest", workId: "wrk_navtest" });
  await p("/recordings", { recordingId: "rcd_navtest", workId: "wrk_navtest", masterOwnerPartyId: "pty_bighit_label", versionTitle: "Original", masterClaim: {} });
  await p("/claims", { claimId: "c_nav_ds", factsScopeId: "fsc_navtest", sourceId: "wrk_navtest", edge: "WRITTEN_BY", targetId: "pty_david_stewart", shareBps: 10000, status: "ASSERTED", validFrom: T0 });
  const pdf = Buffer.from("%PDF-1.4\n% nav test\n%%EOF\n");
  const up = await request.fetch(`${BACKEND}/portal/documents?kind=MASTER_CONTRACT&title=${encodeURIComponent("Nav 녹음 계약서")}&parties=pty_bighit_label`, { method: "POST", headers: { "x-actor": "usr_bh_rights", "content-type": "application/pdf" }, data: pdf });
  expect(up.status()).toBe(201);
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto("/portal/");
  await actAs(page, "usr_bh_rights", "/portal/");
  const nav = page.getByRole("navigation", { name: "권리 테넌트 메뉴" });
  // 시나리오 1: 작품 목록 → 곡 열기(원곡 권리) → 곡 안의 화면은 본문 탭으로만, 사이드 메뉴는 곡 이름 줄이 늘 지금 화면(시안 Sidebar 2차)
  await expect(nav.getByRole("link", { name: /새 곡 워크스페이스/ })).toHaveCount(0);
  await nav.getByRole("link", { name: /작품 목록/ }).click();
  await expect(page).toHaveURL(/\/portal\/works$/);
  await page.getByRole("link", { name: "열기" }).first().click();
  await expect(page).toHaveURL(/\/works\/wrk_navtest\/rights$/);
  // 경로 줄은 두지 않는다(2026-10-23): 위치는 사이드 메뉴 활성과 제목으로 안다
  await expect(page.getByRole("navigation", { name: "위치" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nav Test · 원곡 권리");
  await expect(nav.getByText("최근 연 작품")).toHaveCount(0);
  const tabs = page.getByRole("navigation", { name: "워크스페이스 탭" });
  for (const [label, tab] of [["스템", "stems"], ["확인·동의", "confirm"], ["문서·계약", "contracts"], ["분배 규칙·팩", "policy"], ["승인·출시", "release"]] as const) {
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    await tabs.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/works/wrk_navtest/${tab}$`));
    await expect(tabs.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /^Nav Test/ })).toHaveAttribute("aria-current", "page");
  }
  // 곡 이름 줄을 누르면 원곡 권리 탭
  await nav.getByRole("link", { name: /^Nav Test/ }).click();
  await expect(page).toHaveURL(/\/works\/wrk_navtest\/rights$/);
  // 작품 목록의 곡 이름도 원곡 권리로
  await nav.getByRole("link", { name: /작품 목록/ }).click();
  await page.getByRole("link", { name: "Nav Test", exact: true }).click();
  await expect(page).toHaveURL(/\/works\/wrk_navtest\/rights$/);
  // 시나리오 2: 운영 관리 › 확인 요청 전체 → 행 링크로 곡 확인·동의
  await nav.getByRole("link", { name: /확인 요청 전체/ }).click();
  await expect(page.getByRole("navigation", { name: "위치" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: /확인 요청 전체/ })).toHaveAttribute("aria-current", "page");
  // 고르기 상자의 처음 값은 언제나 '전체'(2026-10-23)
  await expect(page.getByRole("combobox", { name: "상태" })).toHaveValue("ALL");
  await expect(page.getByRole("combobox", { name: "상태" }).locator("option").first()).toHaveText("전체");
  await page.getByRole("link", { name: "곡 워크스페이스 › 확인·동의 →" }).first().click();
  await expect(page).toHaveURL(/\/works\/wrk_navtest\/confirm$/);
  // 시나리오 3: 원천 문서 쪽 나눔 — 1건이면 1–1 / 1, 다음 쪽 비활성
  await page.goto("/portal/ops/documents");
  const pager = page.getByRole("navigation", { name: "쪽" });
  await expect(pager).toContainText("1–1 / 1");
  await expect(pager.getByRole("button", { name: "다음 쪽" })).toBeDisabled();
  await expect(pager.getByRole("button", { name: "1" })).toHaveAttribute("aria-current", "page");
  // 시나리오 4: 위임 대행·신탁·유통 연결 빈 화면, 플랫폼 열람 기록은 포털에 없다
  await page.goto("/portal/delegation");
  await expect(page.getByText("맡긴 업무가 없습니다. MVP에서는 쓰지 않는 메뉴입니다.")).toBeVisible();
  await page.goto("/portal/links");
  await expect(page.getByText("연결이 없습니다. MVP에서는 쓰지 않는 메뉴입니다.")).toBeVisible();
  await expect(nav.getByText("플랫폼 열람 기록")).toHaveCount(0);
  await page.goto("/portal/inspections");
  await expect(page.getByRole("heading", { name: "플랫폼 열람 기록" })).toHaveCount(0);
  expect(failed, failed.join("\n")).toEqual([]);
});
