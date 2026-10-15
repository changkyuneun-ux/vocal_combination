import { expect, test } from "@playwright/test";
import { ok, prepareSettled } from "../../backoffice/e2e/fixtures.ts";

/**
 * 실연자 앱(다음 작업 11, 모바일 화면): 로그인 → 본인 인증 → 사용 이력·수익·알림 → 이의제기 → 동의 철회·재동의.
 * 백오피스 E2E의 정산 준비(합성 곡, 3개 조합 발행, 매출, 정산 확정)를 그대로 쓴다. 합성 곡 시드가 멤버별 실연자 계정을 만든다.
 */
test("실연자 앱: 본인 인증부터 동의 철회까지", async ({ page, request }) => {
  const settled = await prepareSettled(request);

  await page.goto("/");
  await page.getByLabel("계정 id").fill("usr_singer_b");
  await page.getByRole("button", { name: "들어가기" }).click();

  await test.step("본인 인증(개발용 코드)", async () => {
    await page.getByRole("button", { name: "인증 코드 받기" }).click();
    const code = (await page.getByTestId("dev-code").innerText()).replace(/\D/g, "");
    await page.getByLabel("인증 코드").fill(code);
    await page.getByRole("button", { name: "확인" }).click();
    await expect(page.getByText("본인 인증됨")).toBeVisible();
  });

  await test.step("사용 이력: 멤버 b가 부른 조합", async () => {
    await page.getByRole("button", { name: "사용", exact: true }).click();
    await expect(page.locator("[data-usage]")).not.toHaveCount(0);
    await expect(page.locator('[data-usage="vc_e2e_2"]').first()).toBeVisible();
  });

  await test.step("수익: 올해 명세", async () => {
    await page.getByRole("button", { name: "수익", exact: true }).click();
    await expect(page.getByRole("heading", { name: /년 명세/ })).toBeVisible();
    await expect(page.getByTestId("closing")).toContainText("원");
    await expect(page.getByTestId("contribution-total")).toContainText("원");
    await expect(page.locator("[data-contribution]")).not.toHaveCount(0);
  });

  await test.step("알림: 발행 알림이 와 있고, 누르면 읽음", async () => {
    await page.getByRole("button", { name: /^알림/ }).click();
    const usage = page.locator('[data-notice="USAGE"]');
    await expect(usage).not.toHaveCount(0);
    await usage.first().click();
    await expect(usage.first()).not.toHaveClass(/unread/);
  });

  await test.step("이의제기: 내 스템 실연 주장에 이의 → 검토 중", async () => {
    await page.getByRole("button", { name: "이의제기", exact: true }).first().click();
    const claim = page.locator('[data-claim="c_perf_b_slt_2"]');
    await claim.getByRole("button", { name: "이의제기" }).click();
    await claim.getByLabel("이의 사유").fill("이 파트는 제가 부른 녹음이 아닙니다");
    await claim.getByRole("button", { name: "이의제기 제출" }).click();
    await expect(page.locator("[data-objection]").first()).toContainText("검토 중");
  });

  await test.step("동의: 철회 → 다시 동의", async () => {
    await page.getByRole("button", { name: "동의", exact: true }).click();
    const voice = page.locator('[data-voice="vo_b"]');
    await expect(voice).toContainText("동의함");
    await voice.getByRole("button", { name: "철회하기" }).click();
    await voice.getByLabel("철회 사유").fill("활동 중단");
    await voice.getByRole("button", { name: "철회 확정" }).click();
    await expect(voice).toContainText("철회함");
    await voice.getByRole("button", { name: "동의하기" }).click();
    await expect(voice).toContainText("동의함");
  });

  await test.step("계약 서명: 소속사가 보낸 수익 수령 위임계약을 읽고 서명", async () => {
    await ok(request, "usr_editor", "POST", "/parties", { partyId: "pty_e2e_agency", partyType: "LABEL", displayName: "소속사 E" });
    await ok(request, "usr_editor", "POST", "/contracts", {
      contractId: "ctr_e2e_mandate", templateId: "tpl_performer_mandate", factsScopeId: settled.factsScopeId,
      answers: { performer: "pty_member_b", agency: "pty_e2e_agency", shareBps: 2000, validFrom: "2026-01-01", validTo: "2027-01-01" },
    });
    await page.reload();
    const card = page.locator('[data-contract="ctr_e2e_mandate"]');
    await card.getByRole("button", { name: "계약서 읽기" }).click();
    await expect(card.frameLocator("iframe[title='계약서']").getByText("제2조 위임 범위")).toBeVisible();
    await card.getByRole("button", { name: "읽었고 서명합니다" }).click();
    await expect(card).toHaveCount(0);
    const c = await ok<{ signatures: { partyId: string; signedAt?: string }[] }>(request, "usr_editor", "GET", "/contracts/ctr_e2e_mandate");
    expect(c.signatures.find((s) => s.partyId === "pty_member_b")?.signedAt).toBeTruthy();
  });
});
