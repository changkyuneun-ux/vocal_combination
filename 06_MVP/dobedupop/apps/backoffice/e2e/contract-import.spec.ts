import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { BACKEND, expect, ok, test } from "./fixtures.ts";
import { MASTER_FRAME, PUBLISHING_CLAUSES, PUBLISHING_FRAME } from "../../../services/rights-core/src/scenario/dynamite-frames.ts";

/**
 * 계약서 불러오기 → 권리 확인서(3부-B Task 6, 결정 CT1~CT5, 시안 Song-Contracts·Song-Import·Song-ClaimConfirm):
 * Dynamite를 표준 계약 단계까지 돌린 개발 DB에서 퍼블리싱 계약서를 불러와 후보 4개를 확인하고, 빠진 것을 입력하고, 작가용 확인서를 보낸다 →
 * 계정 없는 작가 2명이 빅히트가 보낸 전자서명 링크로 서명(공급자 통지, 결정 WD2) → 기록 반영 → 정합성 점검 전체의 경고가 0이 된다.
 * 사전 조건(API): 읽기 틀 2종 등록(빅히트)·승인(플랫폼 — 읽기 틀 승인은 권리 확정이 아니다, CT2), 원천 문서 조항 표시(길 A),
 * 지급 정보(레이블·소속사는 운영, 작가는 빅히트 — 결정 WD4).
 * 개발 서버(로컬)에서 돈다 — 데모 스택을 다시 빌드하지 않도록 stack-* 대신 개발 DB를 쓴다.
 */
async function actAs(page: Page, userId: string, path: string) {
  await page.goto("/portal/");
  await page.evaluate((u) => localStorage.setItem("rc.actor", u), userId);
  await page.goto(path);
}

test("빅히트: 퍼블리싱 계약서 불러오기 → 후보 4개 확인 → 빠진 것 입력 → 작가용 확인서 → 작가 2명 전자서명 → 기록 반영 → 경고 0", async ({ page, request }) => {
  test.setTimeout(420_000);
  execFileSync("node", [fileURLToPath(new URL("./seed-dynamite.mjs", import.meta.url)), "contracts", "--authors-later"], { stdio: "inherit", timeout: 300_000 });
  const BH = "usr_bh_rights";
  for (const f of [PUBLISHING_FRAME, MASTER_FRAME]) {
    await ok(request, BH, "POST", "/portal/reading-frames", f);
    await ok(request, "usr_legal", "POST", `/reading-frames/${f.frameId}/versions/1/approve`, {});
  }
  for (const c of PUBLISHING_CLAUSES) await ok(request, BH, "POST", "/portal/documents/doc_dynamite_publishing/versions/1/clauses", c);
  for (const p of ["pty_bighit_label", "pty_bighit_agency"]) await ok(request, "usr_accounts", "PUT", `/parties/${p}/payout-profile`, { taxType: "DOMESTIC_CORP", payoutAccountRef: `tok_${p}`, kycVerified: true });
  for (const p of ["pty_david_stewart", "pty_jessica_agombar"]) await ok(request, "usr_bh_admin", "PUT", `/portal/parties/${p}/payout-profile`, { taxType: "FOREIGN", payoutAccountRef: `tok_${p}`, kycVerified: true });
  const warns = async () => (await ok<{ counts: { warn: number } }>(request, BH, "GET", "/portal/scopes/fsc_dynamite/validation")).counts.warn;
  expect(await warns()).toBe(2); // 작가 지분 2건의 상대 확인 대기
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  // 문서·계약 탭 → 계약서 불러오기
  await actAs(page, BH, "/portal/works/wrk_dynamite/contracts");
  await page.getByRole("link", { name: "계약서 불러오기" }).click();
  await expect(page.getByRole("heading", { name: "계약서 불러오기", level: 1 })).toBeVisible();
  await page.getByLabel("불러올 계약서").selectOption({ label: "Dynamite 작품 퍼블리싱 계약서 v1" });
  await page.getByRole("button", { name: "불러오기", exact: true }).click();
  await expect(page.getByText("빅히트 작품 퍼블리싱 계약 양식 v1 — 값 4개를 후보로 채움")).toBeVisible();
  // ② 후보 값 4개 확인(근거 조항이 함께 보인다)
  await expect(page.getByText("“작가 갑의 지분은 50퍼센트”")).toBeVisible();
  for (const l of ["곡명", "작가 · 지분 1", "작가 · 지분 2", "효력 시작"]) {
    const box = page.getByRole("checkbox", { name: `${l} 확인` });
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "true");
  }
  await expect(page.getByText("4 / 4 확인함")).toBeVisible();
  // ③ 대조: 팬앱 이용 범위·기간이 빠짐 → ④ 입력
  await expect(page.getByRole("row", { name: /팬앱 이용 범위 · 기간.*빠짐/ })).toBeVisible();
  for (const c of ["미리듣기", "조합 생성", "개인 보관", "대한민국", "일본", "미국", "팬앱", "팬 커뮤니티"]) await page.getByRole("button", { name: c, exact: true }).click();
  await page.getByLabel("기간 끝").fill("2030-12-31");
  await page.getByRole("button", { name: "권리 확인서 만들기 →" }).click();
  // ⑤ 권리 확인서 — 작가용 미리보기 → 서명 요청
  await expect(page.getByRole("heading", { name: "권리 확인서 — 작가용" })).toBeVisible();
  await expect(page.getByText("이용 행위 미리듣기·조합 생성·개인 보관, 지역 대한민국·일본·미국, 매체 팬앱, 공개 대상 팬 커뮤니티, 2026-01-01 ~ 2030-12-31")).toBeVisible();
  await expect(page.getByRole("row", { name: /David Stewart.*전자서명 링크\(계정 없음\) · 이메일.*대기/ })).toBeVisible();
  await expect(page.getByText("상대 확인 14일 대기 없음 — 경고 2건이 닫힌다")).toBeVisible();
  await page.getByRole("button", { name: "서명 요청 보내기" }).click();
  await expect(page.getByRole("row", { name: /작가용.*서명 대기/ })).toBeVisible();
  // 작가 2명이 빅히트가 보낸 전자서명 링크로 서명한다(개발용 공급자 통지 — 결정 WD2). 플랫폼 원문 대조 경로는 없다(WD3).
  const cc = await ok<{ kind: string; contract: { contractId: string } | null }[]>(request, BH, "GET", "/portal/scopes/fsc_dynamite/claim-confirmations");
  const id = cc.find((x) => x.kind === "AUTHOR")!.contract!.contractId;
  expect((await request.post(`${BACKEND}/ops/contracts/${id}/platform-verify`, { headers: { "x-actor": "usr_ops" }, data: { partyId: "pty_david_stewart", reason: "x" } })).status()).toBe(404);
  for (const a of ["pty_david_stewart", "pty_jessica_agombar"]) await ok(request, null, "POST", `/dev/esign/${id}/sign`, { partyId: a });
  await page.reload();
  await expect(page.getByRole("row", { name: /David Stewart.*서명됨/ })).toBeVisible();
  await page.getByRole("button", { name: "기록 반영" }).click();
  await expect(page.getByRole("row", { name: /작가용.*서명됨 ·/ })).toBeVisible();
  // 정합성 점검 전체: 경고 0
  expect(await warns()).toBe(0);
  await page.goto("/portal/ops/validation");
  await page.getByRole("button", { name: "다시 점검" }).click();
  await expect(page.locator(".p-kpi").filter({ hasText: "경고" }).locator(".v")).toHaveText("0");
  expect(failed).toEqual([]);
});
