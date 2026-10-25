import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";

/**
 * 문서·계약 › + 원본 계약서 올리기(시안 Song-Contracts-Upload): 오른쪽 칸 토글(버튼 다시 누르기·취소·×), 올리면 ① 원본 계약서 표에 바로 나타난다.
 * 곡 진행 ④ 이용 허락은 네 종류 중 끝난 종류 수 "n / 4종". 개발 서버(로컬)에서 돈다.
 */
test("원본 계약서 올리기: 칸 토글, 올리면 ① 표에 바로, 곡 진행 ④는 n / 4종", async ({ page }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "contracts"], { stdio: "inherit", timeout: 300_000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/portal/works/wrk_dynamite/contracts");
  await expect(page.getByRole("status", { name: "곡 진행" })).toContainText(/[0-4] \/ 4종/);
  const originals = page.getByRole("table", { name: "① 원본 계약서" });
  await expect(originals.locator("tbody tr")).toHaveCount(2);
  const btn = page.getByRole("button", { name: "+ 원본 계약서 올리기" });
  const panel = page.getByRole("complementary", { name: "원본 계약서 올리기" });
  // 토글: 다시 누르기 · 취소 · ×
  await btn.click();
  await expect(panel).toBeVisible();
  await expect(btn).toHaveClass(/primary/);
  await btn.click();
  await expect(panel).toHaveCount(0);
  await btn.click();
  await panel.getByRole("button", { name: "취소" }).click();
  await expect(panel).toHaveCount(0);
  await btn.click();
  await panel.getByRole("button", { name: "닫기" }).click();
  await expect(panel).toHaveCount(0);
  // 한 번에 하나: 계약 만들기를 열면 올리기 칸은 닫힌다
  await btn.click();
  await page.getByRole("button", { name: "+ 계약 만들기" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "계약 만들기" })).toBeVisible();
  // 올리기 → ① 표에 바로 나타난다
  await btn.click();
  expect(await panel.getByLabel("계약서 종류").locator("option").allTextContents()).toEqual(["녹음 계약서 — 마스터 보유 근거", "작품 계약서 — 작가 지분 근거"]);
  await expect(panel.getByRole("button", { name: "올리기" })).toBeDisabled();
  await panel.getByLabel("계약서 종류").selectOption({ label: "작품 계약서 — 작가 지분 근거" });
  await panel.getByLabel("계약서 파일", { exact: true }).setInputFiles({ name: "추가 작사 계약서.pdf", mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% e2e upload ${Date.now()}\n%%EOF\n`) });
  await expect(panel).toContainText("추가 작사 계약서.pdf");
  await panel.getByLabel("효력 시작").fill("2026-02-01");
  await panel.getByRole("button", { name: "올리기" }).click();
  await expect(panel).toHaveCount(0);
  await expect(originals.locator("tbody tr")).toHaveCount(3);
  await expect(originals.getByRole("row", { name: /2026-02-01/ })).toContainText("작품 · 작가 지분");
});
