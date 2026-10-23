import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, ok, test } from "./fixtures.ts";

/**
 * IR 생성 뒤 원곡 권리 "새 버전 만들기"(시안 Song-Locked-Fix·Song-Locked-FixPerf):
 * 위치(안내 띠 자리에 열리고 취소·저장하면 다시 띠) · 권리자 유형별 목록 거르기 · 실연(원곡 파트 담당) 바로잡기 → 바뀐 멤버 둘이 실연자 앱에서 확인.
 * 개발 서버(로컬)에서 돈다 — 분배 규칙 활성화(IR v1 고정)까지 돌린 개발 DB를 쓴다.
 */
test("새 버전 만들기: 위치·목록 거르기·실연 파트 담당 바로잡기와 멤버 확인", async ({ page, request }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "policy"], { stdio: "inherit", timeout: 300_000 });
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/portal/works/wrk_dynamite/rights");
  await expect(page.getByRole("status", { name: "IR 고정 상태" })).toContainText("IR 상태");

  // 1. 위치: 안내 띠 자리(작품 카드 위)에 열리고, 띠는 숨는다. 취소하면 다시 띠.
  const band = page.getByText(/이 곡의 권리가 IR v1로 고정됐다/);
  await expect(band).toBeVisible();
  await page.getByRole("button", { name: "새 버전으로 바로잡기" }).click();
  const box = page.getByRole("region", { name: "새 버전 만들기" });
  await expect(box).toBeVisible();
  await expect(band).toHaveCount(0);
  const workCard = page.getByRole("heading", { name: "작품 · 작사·작곡", level: 2 });
  expect((await box.boundingBox())!.y).toBeLessThan((await workCard.boundingBox())!.y);
  await box.getByRole("button", { name: "취소" }).click();
  await expect(box).toHaveCount(0);
  await expect(band).toBeVisible();

  // 2. 목록 거르기: 작품 = 작가만 · 퍼블리싱 문서만, 녹음 = 레이블만 · 녹음 계약만, 실연 = 이 곡의 멤버만 · 실연 동의·수령 위임만
  await page.getByRole("button", { name: "새 버전으로 바로잡기" }).click();
  const texts = async (label: string) => (await box.getByLabel(label, { exact: true }).locator("option").allTextContents()).slice(1);
  expect(await texts("(새) 권리자")).toEqual([]); // 작가 둘은 이미 행에 있다
  expect((await texts("근거 문서")).every((t) => /퍼블리싱|작품 이용허락|권리 확인서 · 작가용/.test(t))).toBe(true);
  await box.getByLabel("권리자 유형").selectOption({ label: "녹음 · 마스터" });
  expect((await texts("근거 문서")).every((t) => /녹음/.test(t))).toBe(true);
  expect((await texts("근거 문서")).length).toBeGreaterThan(0);
  await box.getByLabel("권리자 유형").selectOption({ label: "실연 · 보이스·파트 담당" });
  expect(await box.getByLabel("새 원곡 담당").locator("option").allTextContents()).toEqual(["정국", "지민", "뷔", "진", "RM", "제이홉", "슈가"]);
  expect((await texts("근거 문서")).every((t) => /수령 위임|이용 동의/.test(t))).toBe(true);
  await expect(box.getByText("실연은 %가 아니다")).toBeVisible();

  // 3. 실연 바로잡기: Pre-Chorus 1 파트 2(뷔) → 진. 저장하면 다시 띠, 진·뷔에게 확인 요청.
  const part = box.getByLabel("바로잡을 파트");
  const label = (await part.locator("option").allTextContents()).find((o) => o.includes("Pre-Chorus 1 · 파트 2"))!;
  await part.selectOption({ label });
  await expect(box.getByRole("cell", { name: "뷔", exact: true })).toBeVisible();
  await box.getByLabel("새 원곡 담당").selectOption({ label: "진" });
  await expect(box.getByText("진·뷔 실연자 앱 확인")).toBeVisible();
  await box.getByLabel("효력 시작").fill("2026-03-01");
  await box.getByRole("button", { name: "새 버전 저장" }).click();
  await expect(box).toHaveCount(0);
  await expect(band).toBeVisible();
  await expect(page.getByText("다음 재고정부터 파트 4")).toBeVisible(); // 진: 파트 3 → 4
  type Cfm = { requestId: number; recordType: string; recordId: string; status: string };
  for (const m of ["jin", "v"]) {
    const mine = await ok<Cfm[]>(request, `usr_member_${m}`, "GET", "/performer/confirmations");
    const r = mine.find((x) => x.recordType === "PART" && x.status === "OPEN");
    expect(r, `${m}: ${JSON.stringify(mine)}`).toBeTruthy();
    await ok(request, `usr_member_${m}`, "POST", `/performer/confirmations/${r!.requestId}/confirm`, {});
  }
  const facts = await ok<{ partAssignments: { partyId: string; previousPartyId: string; status: string }[] }>(request, "usr_bh_rights", "GET", "/portal/scopes/fsc_dynamite/facts");
  expect(facts.partAssignments.map((a) => [a.partyId, a.previousPartyId, a.status])).toEqual([["pty_jin", "pty_v", "VERIFIED"]]);
  expect(failed, failed.join("\n")).toEqual([]);
});
