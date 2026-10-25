import { expect, ok, resetAll, test } from "./fixtures.ts";
import { onboardBighit } from "./bighit.ts";

/**
 * 작품 묶음 표(2026-10-24, 디자인 가이드 5절): 운영 관리 목록은 작품마다 요약 한 줄 → 누르면 그 작품 상세만 펼친다.
 * 한 번에 한 작품, 전체 펼치기 없음. 작품 목록은 10개 단위, 상세는 10행 단위 쪽 나눔.
 * 개발 서버(로컬)에서 돈다 — 작품 11개와 한 작품의 확인 요청 12건을 API로 만든다.
 */
test("작품 묶음 표: 한 번에 한 작품, 작품 목록 10개·상세 10행 쪽 나눔", async ({ page, request }) => {
  test.setTimeout(180_000);
  await resetAll(request);
  await onboardBighit(request);
  const p = (path: string, body: unknown) => ok(request, "usr_bh_rights", "POST", `/portal${path}`, body);
  const n2 = (i: number) => String(i).padStart(2, "0");
  for (let i = 1; i <= 11; i++) {
    await p("/works", { workId: `wrk_g${n2(i)}`, title: `묶음 ${n2(i)}` });
    await p("/scopes", { factsScopeId: `fsc_g${n2(i)}`, workId: `wrk_g${n2(i)}` });
  }
  // 묶음 01: 작가 확인 요청 12건(작가 지분 주장 12개 → 상대 확인)
  for (let k = 1; k <= 12; k++) {
    await p("/claims", { claimId: `c_g01_${n2(k)}`, factsScopeId: "fsc_g01", sourceId: "wrk_g01", edge: "WRITTEN_BY", targetId: k % 2 ? "pty_david_stewart" : "pty_jessica_agombar",
      shareBps: 500, roleDetail: "LYRICS", status: "ASSERTED", validFrom: "2026-01-01T00:00:00.000Z" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.setItem("rc.actor.portal", "usr_bh_rights"));
  await page.goto("/portal/ops/confirmations");
  const table = page.getByRole("table", { name: "확인 요청" });
  const card = table.locator("xpath=ancestor::section[1]");
  // 작품 목록: 10개 단위 쪽 나눔(바깥 쪽 나눔은 표 카드 맨 아래 줄)
  const outer = card.locator(".p-tfoot").getByRole("navigation", { name: "쪽" });
  await expect(outer).toContainText("1–10 / 11");
  await expect(table.getByRole("button", { name: /^묶음 [0-9]+$/ })).toHaveCount(10);
  await expect(page.getByRole("button", { name: /전체 펼치기/ })).toHaveCount(0);
  // 첫 작품이 펼쳐져 있다 — 상세 10행 쪽 나눔
  const g1 = page.getByRole("region", { name: "묶음 01 상세" });
  await expect(g1).toBeVisible();
  await expect(table.getByRole("row", { name: /묶음 01/ }).first()).toContainText("작가 서명 대기");
  const inner = g1.getByRole("navigation", { name: "쪽" });
  await expect(inner).toContainText("1–10 / 12");
  await expect(g1.locator("tbody tr")).toHaveCount(10);
  await inner.getByRole("button", { name: "다음 쪽" }).click();
  await expect(inner).toContainText("11–12 / 12");
  await expect(g1.locator("tbody tr")).toHaveCount(2);
  // 다른 작품을 누르면 그 작품만 펼친다(한 번에 하나), 다시 누르면 접힌다
  await table.getByRole("button", { name: /묶음 02/ }).click();
  const g2 = page.getByRole("region", { name: "묶음 02 상세" });
  await expect(g2).toContainText("확인 요청이 없습니다.");
  await expect(g1).toHaveCount(0);
  await expect(table.getByRole("button", { name: /묶음 02/ })).toHaveAttribute("aria-expanded", "true");
  await table.getByRole("button", { name: /묶음 02/ }).click();
  await expect(g2).toHaveCount(0);
  await expect(page.getByRole("region", { name: /상세$/ })).toHaveCount(0);
  // 작품 목록 2쪽: 11번째 작품
  await outer.getByRole("button", { name: "다음 쪽" }).click();
  await expect(outer).toContainText("11–11 / 11");
  await expect(table.getByRole("button", { name: /묶음 11/ })).toBeVisible();
  // 필터는 작품 요약 기준: 대기만 → 대기 요청이 있는 작품(묶음 01)만
  await page.getByRole("combobox", { name: "상태" }).selectOption("OPEN");
  await expect(outer).toContainText("1–1 / 1");
  await expect(table.getByRole("button", { name: /묶음 01/ })).toBeVisible();
});
