import { asPortal, expect, ok, resetAll, test } from "./fixtures.ts";

/**
 * 권리자 포털(/portal, 다음 작업 6): 운영 백오피스와 같은 코드베이스지만 권리 화면만 있고 /api/portal 채널을 쓴다.
 * 개발 레이블(usr_label, 테넌트 tnt_dev_label)에게는 플랫폼이 등록한 합성 곡이 보이지 않는다(RLS).
 * 포털은 권리 테넌트 소속만 들어온다 — 플랫폼 계정은 403 CHANNEL_FORBIDDEN이고 화면은 오류 패널로 안내한다. 데모 도구·사용자 전환은 없다.
 */
test("권리자 포털: 권리 화면만 있고, 레이블 사용자는 자기 테넌트 데이터만 본다", async ({ page, request }) => {
  await resetAll(request);
  await ok(request, null, "POST", "/dev/seed/synthetic-song", {});

  await asPortal(page, "usr_label", "/portal/");
  // 포털 틀(3부-A, 디자인 가이드 4절): 머리글 + 사이드 메뉴(작품 관리 / 운영 관리). 운영 앱 메뉴는 없다.
  await expect(page.locator(".p-brand")).toHaveText("dobedupop");
  const menu = page.getByRole("navigation", { name: "권리 테넌트 메뉴" });
  for (const m of ["작품 관리", "운영 관리"]) await expect(menu.getByRole("button", { name: new RegExp(m) })).toBeVisible();
  await expect(menu.getByRole("link", { name: /작품 목록/ })).toBeVisible();
  for (const ops of ["정산 배치", "원장", "지급 run", "매출", "PSP 시뮬레이터"]) await expect(page.getByRole("link", { name: ops, exact: true })).toHaveCount(0);

  await expect(page.getByLabel("데모 도구")).toHaveCount(0);
  await expect(page.getByLabel("사용자 전환")).toHaveCount(0);
  await expect(page.getByLabel("로그인한 사용자")).toHaveText(/ · usr_label$/);
  await expect(page.locator(".p-org")).not.toContainText("▾");
  await page.goto("/portal/registry/assets");
  await expect(page.getByText("곡이 없습니다.")).toBeVisible();

  // 플랫폼 계정(usr_editor)은 포털에 들어오지 못한다 — 운영 앱에서 그 사용자를 골라도 포털 저장값은 따로다.
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("rc.actor", "usr_editor"));
  await page.goto("/portal/registry/assets");
  await expect(page.getByLabel("로그인한 사용자")).toHaveText(/ · usr_label$/);
  await asPortal(page, "usr_editor", "/portal/works");
  await expect(page.getByText("CHANNEL_FORBIDDEN").first()).toBeVisible();
  await expect(page.getByText("권리자 포털은 권리 테넌트 소속 계정으로만 씁니다")).toBeVisible();
});
