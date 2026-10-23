import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.ts";

/**
 * 명세·지급(3부-C, 결정 WD4, 시안 Ops-Statements 정정판): 작가 2명은 빅히트가 관리하는 당사자라 빅히트 명세·지급에 작가 행이 보인다.
 * 금액은 플랫폼 위탁 폐지 전과 같다(소속사 2,285,920 · 레이블 2,030,952 · 작가 각 296,604). 개발 DB를 Dynamite 지급 단계까지 돌린다.
 */
test("빅히트 명세·지급: 받는 당사자 4(레이블·소속사·작가 2), 작가 각 296,604원", async ({ page }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "payout"], { stdio: "inherit", timeout: 400_000 });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.setItem("rc.actor.portal", "usr_bh_rights"));
  await page.goto("/portal/ops/statements");
  const kpi = (label: string) => page.locator(".p-kpi").filter({ hasText: label });
  await expect(kpi("받는 당사자").locator(".v")).toHaveText("4");
  await expect(kpi("받는 당사자")).toContainText("레이블 · 소속사 · 작가 2");
  for (const [who, amount] of [["David Stewart\\(작가\\)", "296,604"], ["Jessica Agombar\\(작가\\)", "296,604"], ["빅히트 뮤직 — 레이블", "2,030,952"], ["빅히트 뮤직 매니지먼트\\(소속사\\)", "2,285,920"]] as const) {
    await expect(page.getByRole("row", { name: new RegExp(`${who}.*${amount}`) })).toBeVisible();
  }
  await expect(kpi("이번 지급").locator(".v")).toHaveText("4,910,080원");
  await expect(page.getByText(/작가는 빅히트가 관리하는 당사자다\./)).toBeVisible();
});
