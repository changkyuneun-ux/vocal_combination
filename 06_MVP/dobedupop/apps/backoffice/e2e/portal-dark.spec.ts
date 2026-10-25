import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * 포털은 밝은 테마 하나(2026-10-25 버그): OS가 다크 모드여도 theme.css의 다크 변수·h1~h4·[role="status"] 규칙이 새어 들어오지 않는다.
 * colorScheme: dark로 원곡 권리(IR 고정 뒤) · 작품 목록 · 운영 관리(확인 요청 전체)를 열어 글자·바탕·입력이 포털 토큰인지 본다.
 * 1440 스크린샷은 DARK_SHOTS_DIR(없으면 시험 결과 폴더)에 남긴다.
 */
test.use({ colorScheme: "dark" });

const INK = "rgb(15, 23, 42)", INK2 = "rgb(30, 41, 59)", PAGE = "rgb(243, 245, 248)", WHITE = "rgb(255, 255, 255)";
const css = (l: Locator, prop: "color" | "background-color") => l.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

test("다크 모드 브라우저에서도 포털은 밝은 테마: 제목·안내 띠·입력·고르기 상자", async ({ page }, info) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "policy"], { stdio: "inherit", timeout: 300_000 });
  const dir = process.env.DARK_SHOTS_DIR ?? info.outputPath();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/portal/");
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(true);
  await page.evaluate(() => localStorage.clear());

  // 원곡 권리(IR 고정 뒤): 제목 · 안내 띠 · 곡 진행 띠 · 표
  await page.goto("/portal/works/wrk_dynamite/rights");
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveText("Dynamite · 원곡 권리");
  expect(await css(h1, "color")).toBe(INK);
  const band = page.getByText(/이 곡의 권리가 IR v1로 고정됐다/).locator("xpath=ancestor::*[@role='status'][1]");
  expect(await css(band, "color")).toBe(INK2);
  expect(await css(page.getByRole("status", { name: "곡 진행" }), "color")).toBe(INK2);
  expect(await css(page.locator(".p-shell"), "background-color")).toBe(PAGE);
  expect(await css(page.locator(".p-table td").first(), "color")).toBe(INK);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("light");
  await page.screenshot({ path: join(dir, "dark-rights.png"), fullPage: true });

  // 작품 목록: 제목 · 검색 입력 · 고르기 상자
  await page.goto("/portal/works");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("작품 관리");
  expect(await css(page.getByRole("heading", { level: 1 }), "color")).toBe(INK);
  const q = page.getByLabel("작품 검색");
  expect([await css(q, "color"), await css(q, "background-color")]).toEqual([INK, WHITE]);
  const sort = page.getByRole("combobox", { name: "정렬" });
  expect([await css(sort, "color"), await css(sort, "background-color")]).toEqual([INK, WHITE]);
  await page.screenshot({ path: join(dir, "dark-works.png"), fullPage: true });

  // 운영 관리 › 확인 요청 전체: 제목 · 고르기 상자 · 묶음 표
  await page.goto("/portal/ops/confirmations");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("확인 요청 전체");
  expect(await css(page.getByRole("heading", { level: 1 }), "color")).toBe(INK);
  const st = page.getByRole("combobox", { name: "상태" });
  expect([await css(st, "color"), await css(st, "background-color")]).toEqual([INK, WHITE]);
  await expect(page.getByRole("table", { name: "확인 요청" })).toBeVisible();
  expect(await css(page.getByRole("table", { name: "확인 요청" }).locator("tbody td").first(), "color")).toBe(INK);
  await page.screenshot({ path: join(dir, "dark-ops-confirmations.png"), fullPage: true });
});
