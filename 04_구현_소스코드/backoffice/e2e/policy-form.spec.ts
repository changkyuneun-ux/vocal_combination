import { as, expect, prepareSettled, test } from "./fixtures.ts";

/** 분배 규칙 폼(원천 문서 설계 S2): MDRL을 폼으로 불러와 바꾸면 예시 계산·쉬운 말 설명·활성 버전 비교가 바뀌고, MDRL로 만들어 컴파일한다. */
test("분배 규칙 폼: 불러오기, 예시 계산, 버전 비교, MDRL 생성·컴파일", async ({ page, request }) => {
  const s = await prepareSettled(request);
  await page.goto(`/policy/${s.policyId}`);
  await as(page, "usr_editor");
  await page.getByRole("button", { name: "편집기에서 불러오기" }).click();
  await expect(page.getByRole("status").filter({ hasText: "폼으로 불러왔습니다" })).toBeVisible();
  await expect(page.getByLabel("쉬운 말 설명")).toContainText("매출의 70%는 권리자 몫");
  await expect(page.getByLabel("예시 계산")).toContainText("pty_label");
  await expect(page.getByLabel("활성 버전과 비교")).toContainText("바뀐 항목이 없습니다");

  await page.getByLabel("실연 1인 상한(%)").fill("60");
  await expect(page.getByLabel("활성 버전과 비교")).toContainText("실연 1인 상한: 50% → 60%");
  await expect(page.getByLabel("쉬운 말 설명")).toContainText("실연 몫의 60%를 넘지 못하고");

  await page.getByLabel("2차 녹음(%)").fill("50");
  await expect(page.getByLabel("폼 진단")).toContainText("2차 분할 합이 110%");
  await page.getByLabel("2차 녹음(%)").fill("40");

  await page.getByRole("button", { name: "MDRL로 만들기" }).click();
  await expect(page.getByLabel("정책 원문(MDRL)")).toHaveValue(/cap\(60%\)/);
  await page.getByRole("button", { name: "컴파일", exact: true }).click();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
});
