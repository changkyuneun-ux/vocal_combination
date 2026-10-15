import { as, expect, ok, prepareSettled, test } from "./fixtures.ts";

/** 연동 허브(다음 작업 14)와 감상 수익 풀(다음 작업 13): 파트너 파일의 거부 줄을 자산 대응 등록 후 재처리하고, 재생 없는 풀을 배정한다. */
test("연동 허브: 거부 큐 재처리, 감상 수익 풀 배정", async ({ page, request }) => {
  const s = await prepareSettled(request);
  await ok(request, "usr_ops", "POST", "/hub/assets", { tenantId: "tnt_dev_partner", externalId: "DBP-E2E-1", vcId: s.vcIds[0] });
  const file = await ok<{ fileId: string }>(request, "usr_partner", "POST", "/partner/inbound", {
    format: "DISTRIBUTOR_CSV", fileName: "march.csv",
    content: "transaction_id,type,asset_id,amount_krw,occurred_at\ntx1,SALE,DBP-E2E-1,1200,2026-03-20\ntx2,SALE,DBP-E2E-9,1500,2026-03-21\n",
  });

  await page.goto("/hub");
  await as(page, "usr_ops");
  await page.getByRole("button", { name: file.fileId }).click();
  await expect(page.getByText("UNKNOWN_ASSET (재처리 가능)")).toBeVisible();
  await page.getByRole("textbox", { name: "파트너 테넌트", exact: true }).fill("tnt_dev_partner");
  await page.getByRole("textbox", { name: "파트너 자산 id", exact: true }).fill("DBP-E2E-9");
  await page.getByRole("textbox", { name: "조합 id", exact: true }).fill(s.vcIds[1]!);
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.getByRole("button", { name: "고칠 수 있는 거부 줄 재처리" }).click();
  await expect(page.getByText("재처리 1줄 중 1줄 적용")).toBeVisible();
  await expect(page.getByText("UNKNOWN_ASSET (재처리 가능)")).toHaveCount(0);

  await as(page, "usr_settle");
  await page.goto("/revenue/traffic");
  await expect(page.getByRole("heading", { name: "감상 수익 풀" })).toBeVisible();
  await page.getByLabel("풀 id").fill("pool_e2e_ad");
  await page.getByLabel("수익 종류").selectOption("AD");
  await page.getByLabel("기간 시작").fill("2026-05-01T00:00:00.000Z");
  await page.getByLabel("기간 끝").fill("2026-06-01T00:00:00.000Z");
  await page.getByLabel("금액(원)").fill("50000");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.getByRole("button", { name: "배정", exact: true }).click();
  await expect(page.getByText("NO_PLAYS")).toBeVisible();
});
