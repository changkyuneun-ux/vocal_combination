import { expect, prepareSettled, resetAll, test } from "./fixtures.ts";

/** ⑧ 권리 파이프라인 관제(다음 작업 8): 운영 백오피스 홈의 단계별 신호, 한 건 추적, 영향 분석을 화면으로 확인한다. */
test("⑧ 관제 홈: 8단계 신호, 조합 한 건 추적, 동의 철회 영향 분석", async ({ page, request }) => {
  await resetAll(request);
  const s = await prepareSettled(request);

  await page.goto("/");
  const table = page.getByRole("table", { name: "파이프라인 단계별 신호" });
  await expect(table.locator("tbody tr")).toHaveCount(8);
  await expect(table.locator('[data-signal="flagged"]')).toContainText("이상거래 의심 이벤트 1");

  await page.getByLabel("추적 시작점").selectOption("vc");
  await page.getByLabel("추적할 id").fill(s.vcIds[0]!);
  await page.getByRole("button", { name: "추적", exact: true }).click();
  await expect(page.getByText("발행 봉인:")).toBeVisible();
  await expect(page.locator(`[data-event="${s.eventIds[0]}"]`)).toContainText("CONFIRMED");

  await page.getByLabel("영향 분석 대상").selectOption("consent");
  await page.getByLabel("영향 분석 id").fill(`cst_${s.factsScopeId}_performer_vo_a_pty_member_a`);
  await page.getByRole("button", { name: "분석", exact: true }).click();
  await expect(page.getByText("영향받는 발행 조합")).toBeVisible();
  await expect(page.getByText("역분개 검토", { exact: true })).toBeVisible();
});
