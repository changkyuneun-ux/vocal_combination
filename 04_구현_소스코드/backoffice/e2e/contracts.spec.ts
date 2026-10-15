import { as, expect, ok, prepareSettled, test } from "./fixtures.ts";

/**
 * 표준 계약(원천 문서 설계 S4): 템플릿을 고르고 답을 넣어 계약서를 미리 보고 서명을 요청한다. 플랫폼 밖 작가는 공급자에서 서명하고(개발용 공급자),
 * 기록을 반영하면 서명본이 원천 문서가 되고 작품 이용허락 동의가 그 문서를 근거로 생긴다.
 */
test("작품 이용허락 표준계약: 미리보기 → 서명 요청 → 공급자 서명 → 기록 반영", async ({ page, request }) => {
  const s = await prepareSettled(request);
  await ok(request, "usr_editor", "POST", "/parties", { partyId: "pty_e2e_author", partyType: "AUTHOR", displayName: "작가 K" });

  await page.goto("/contracts");
  await as(page, "usr_editor");
  await page.getByLabel("계약 종류").selectOption("tpl_work_license");
  await page.getByLabel("곡(facts scope)").fill(s.factsScopeId);
  await page.getByLabel("계약 id").fill("ctr_e2e_work");
  await page.getByLabel("허락자(작품 권리자)").fill("pty_e2e_author");
  for (const name of ["미리듣기", "조합 생성", "대한민국", "팬앱", "팬 커뮤니티"]) await page.getByRole("checkbox", { name }).check();
  await page.getByLabel("시작일").fill("2026-01-01");
  await page.getByLabel("종료일").fill("2027-01-01");
  await page.getByRole("button", { name: "미리보기" }).click();
  await expect(page.getByLabel("서명할 당사자")).toContainText("pty_e2e_author");
  await expect(page.frameLocator("iframe[title='계약서 미리보기']").getByText("제1조 당사자")).toBeVisible();
  await page.getByRole("button", { name: "서명 요청" }).click();
  await expect(page.getByRole("status").filter({ hasText: "서명을 요청했습니다" })).toBeVisible();

  const row = () => page.getByRole("row").filter({ hasText: "ctr_e2e_work" });
  await expect(row()).toContainText("서명 대기");
  await row().getByRole("button", { name: "공급자 서명(개발)" }).click();
  await expect(row()).toContainText("서명 완료(반영 전)");
  await row().getByRole("button", { name: "기록 반영" }).click();
  await expect(row()).toContainText("기록 반영됨");
  await expect(row()).toContainText("doc_ctr_e2e_work");
  await expect(row()).toContainText("CONSENT cns_ctr_e2e_work");
});
