import { as, expect, ok, resetAll, test } from "./fixtures.ts";

/**
 * 권리자 포털(/portal, 다음 작업 6): 운영 백오피스와 같은 코드베이스지만 권리 화면만 있고 /api/portal 채널을 쓴다.
 * 개발 레이블(usr_label, 테넌트 tnt_dev_label)에게는 플랫폼이 등록한 합성 곡이 보이지 않는다(RLS).
 */
test("권리자 포털: 권리 화면만 있고, 레이블 사용자는 자기 테넌트 데이터만 본다", async ({ page, request }) => {
  await resetAll(request);
  await ok(request, null, "POST", "/dev/seed/synthetic-song", {});

  await page.goto("/portal/");
  // 포털 틀은 시안 머리글(디자인 가이드 4절): 사이드바 없이 주 메뉴 작품 · 모아 보기 · 분배 규칙·팩 · 발행·정산 · 조직.
  await expect(page.locator(".p-brand")).toHaveText("dobedupop");
  const menu = page.getByRole("navigation", { name: "주 메뉴" });
  for (const m of ["작품", "모아 보기", "분배 규칙·팩", "발행·정산", "조직"]) await expect(menu.getByRole("link", { name: m, exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "모아 보기", exact: true }).click();
  await expect(page.getByRole("link", { name: "당사자", exact: true })).toBeVisible();
  for (const ops of ["정산 배치", "원장", "지급 run", "매출", "PSP 시뮬레이터"]) await expect(page.getByRole("link", { name: ops, exact: true })).toHaveCount(0);
  await page.goto("/portal/");

  await as(page, "usr_label");
  await expect(page.getByText("tnt_dev_label")).toBeVisible();
  await page.goto("/portal/registry/assets");
  await expect(page.getByText("곡이 없습니다.")).toBeVisible();

  await as(page, "usr_editor"); // 플랫폼 운영 사용자는 포털에서도 전체를 본다(온보딩·대행)
  await page.goto("/portal/registry/assets");
  await expect(page.getByRole("cell", { name: "wrk_nova_summer", exact: true })).toBeVisible();
});
