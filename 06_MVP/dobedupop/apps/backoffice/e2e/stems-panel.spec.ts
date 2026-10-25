import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, ok, test } from "./fixtures.ts";

/**
 * 스템 탭 오른쪽 칸(시안 Song-Stems-Panel): 토글(같은 칸·× → 닫힘, 표가 넓어짐) · + 스템 추가(다시 누르기·취소·× → 닫힘) ·
 * 수정(같은 칸이 수정 폼, 취소 → 상세) · IR 고정 뒤 쓰지 않음 → 같은 자리에 새로 추가(다음 IR, 실연 주장 + 부른 멤버 확인 요청).
 * 개발 서버(로컬)에서 돈다 — 분배 규칙 활성화(IR v1 고정)까지 돌린 개발 DB를 쓴다.
 */
test("스템 오른쪽 칸: 토글·추가·수정·쓰지 않음(IR 고정 뒤)", async ({ page, request }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "policy"], { stdio: "inherit", timeout: 300_000 });
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.setViewportSize({ width: 1440, height: 1000 }); // 시안 폭: 표 옆에 오른쪽 칸이 선다
  await page.goto("/portal/");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/portal/works/wrk_dynamite/stems");
  const table = page.getByRole("region", { name: /스템 — 슬롯·보컬 파트/ });
  await expect(table).toBeVisible();
  const wide = (await table.boundingBox())!.width;
  const cell = page.getByRole("button", { name: /Intro Chorus · 파트 1 \(정국\) 지민 등록/ });
  const detail = page.getByRole("complementary", { name: "선택한 스템" });

  // 1. 토글: 같은 칸 다시 → 닫힘, × → 닫힘. 열리면 표가 좁아지고 닫히면 다시 넓어진다.
  await cell.click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("IR v1 포함");
  expect((await table.boundingBox())!.width).toBeLessThan(wide);
  await cell.click();
  await expect(detail).toHaveCount(0);
  expect((await table.boundingBox())!.width).toBe(wide);
  await cell.click();
  await detail.getByRole("button", { name: "닫기" }).click();
  await expect(detail).toHaveCount(0);

  // 2. + 스템 추가: 다시 누르기·취소·× → 닫힘. 한 번에 하나만(상세가 열려 있으면 추가 폼으로 바뀐다).
  const addBtn = page.getByRole("button", { name: "+ 스템 추가" });
  const add = page.getByRole("complementary", { name: "스템 추가" });
  await cell.click();
  await addBtn.click();
  await expect(add).toBeVisible();
  await expect(detail).toHaveCount(0);
  await addBtn.click();
  await expect(add).toHaveCount(0);
  await addBtn.click();
  await add.getByRole("button", { name: "취소" }).click();
  await expect(add).toHaveCount(0);
  await addBtn.click();
  await add.getByRole("button", { name: "닫기" }).click();
  await expect(add).toHaveCount(0);
  // 부른 멤버는 이 곡의 멤버만
  await addBtn.click();
  expect(await add.getByLabel("부른 멤버").locator("option").allTextContents()).toEqual(["정국", "지민", "뷔", "진", "RM", "제이홉", "슈가"]);
  await addBtn.click();

  // 3. 수정(IR 뒤 = 새 버전(오디오 바꾸기)): 같은 칸이 수정 폼, 부른 멤버·권리 부담은 못 바꾼다, 취소 → 상세
  await cell.click();
  await detail.getByRole("button", { name: "새 버전(오디오 바꾸기)" }).click();
  const edit = page.getByRole("complementary", { name: "스템 수정" });
  await expect(edit).toBeVisible();
  await expect(edit.getByLabel("부른 멤버")).toBeDisabled();
  await expect(edit.getByRole("radio", { name: "예" })).toBeDisabled();
  await expect(edit.getByRole("button", { name: "저장" })).toBeDisabled();
  await edit.getByRole("button", { name: "취소" }).click();
  await expect(detail).toBeVisible();

  // 4. 쓰지 않음 → 그 칸이 비고, 같은 자리에 새로 추가(다음 IR) → 실연 주장 + 지민에게 확인 요청
  await detail.getByRole("button", { name: "쓰지 않음" }).click();
  await expect(detail).toHaveCount(0);
  const empty = page.getByRole("button", { name: /Intro Chorus · 파트 1 \(정국\) 지민 없음/ });
  await expect(empty).toBeVisible();
  await empty.click();
  await expect(add).toBeVisible();
  await expect(add.getByLabel("부른 멤버")).toHaveValue("pty_jimin");
  await expect(add.getByText("다음 IR에 들어간다")).toBeVisible();
  await add.getByRole("button", { name: "추가" }).click();
  await expect(add).toHaveCount(0);
  await expect(cell).toBeVisible();
  const facts = await ok<{ stems: { stemId: string; retiredAt: string | null; performerPartyId: string | null }[]; claims: { sourceId: string; edge: string; status: string; supersededAt: string | null }[] }>(
    request, "usr_bh_rights", "GET", "/portal/scopes/fsc_dynamite/facts");
  const retired = facts.stems.filter((s) => s.retiredAt !== null);
  expect(retired.map((s) => s.performerPartyId)).toEqual(["pty_jimin"]);
  const added = facts.stems.find((s) => s.stemId === `${retired[0]!.stemId}_v2`)!;
  expect(added.retiredAt).toBeNull();
  expect(facts.claims.find((c) => c.sourceId === added.stemId && c.edge === "PERFORMED_BY" && c.supersededAt === null)?.status).toBe("ASSERTED");
  const asks = await ok<{ recordId: string; status: string }[]>(request, "usr_member_jimin", "GET", "/performer/confirmations");
  expect(asks.some((r) => r.recordId === `c_perf_${added.stemId}` && r.status === "OPEN")).toBe(true);
  expect(failed, failed.join("\n")).toEqual([]);
});
