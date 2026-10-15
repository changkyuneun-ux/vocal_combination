import { as, expect, ok, prepareSettled, test } from "./fixtures.ts";

/**
 * 정합성 점검(원천 문서 설계 S3a): 곡의 빠진 근거·문서를 이슈로 보여 준다. 경고는 운영이 사유와 함께 위험 수용을 요청하고,
 * 다른 사람(컴플라이언스)이 승인해야 수용된다.
 */
test("점검 이슈 표시, 경고 위험 수용 요청·승인", async ({ page, request }) => {
  const s = await prepareSettled(request);
  // 플랫폼 밖 작가의 지분 주장(ASSERTED) → 확인 대기 경고(DOC_CONFIRMATION_PENDING)가 생긴다.
  await ok(request, "usr_editor", "POST", "/parties", { partyId: "pty_e2e_writer", partyType: "AUTHOR", displayName: "작가 E" });
  await ok(request, "usr_editor", "POST", "/claims", {
    claimId: "c_e2e_writer", factsScopeId: s.factsScopeId, sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_e2e_writer", shareBps: 1000,
    status: "ASSERTED", validFrom: "2026-01-01T00:00:00.000Z",
  });
  const check = await ok<{ issues: { issueId: number; rule: string; severity: string }[] }>(request, "usr_ops", "GET", `/scopes/${s.factsScopeId}/validation`);
  const warn = check.issues.find((i) => i.rule === "DOC_CONFIRMATION_PENDING");
  expect(warn, "확인 대기 경고가 있어야 한다").toBeTruthy();

  await page.goto(`/validation?scope=${s.factsScopeId}`);
  await as(page, "usr_ops");
  await expect(page.getByLabel("점검 요약")).toContainText("경고");
  const row = () => page.getByRole("region", { name: "정합성 점검" }).getByRole("row").filter({ hasText: warn!.rule }).first();
  await expect(row()).toContainText("열림");
  await page.getByLabel("처리 사유").fill("다음 정산 전까지 보완 예정");
  await row().getByRole("button", { name: "위험 수용 요청" }).click();
  await expect(row()).toContainText("수용 요청: 다음 정산 전까지 보완 예정");

  // 요청한 운영은 승인할 수 없다(직무 분리) → 컴플라이언스가 승인한다.
  await as(page, "usr_compliance");
  await row().getByRole("button", { name: "수용 승인" }).click();
  await expect(row()).toContainText("위험 수용");
  await expect(page.getByLabel("점검 요약")).toContainText("위험 수용 1");
});
