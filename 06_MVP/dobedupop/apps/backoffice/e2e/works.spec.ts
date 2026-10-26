import type { Page } from "@playwright/test";
import { expect, resetAll, test } from "./fixtures.ts";
import { onboardBighit } from "./bighit.ts";

/**
 * 빅히트 작품·곡 워크스페이스 화면 흐름(2부-B Task 9, 시안 Catalog·Song-*): 새 곡 마법사 → 원곡 권리(슬롯·파트) → 스템 → 수령 위임 계약 →
 * 분배 규칙·팩(표준 템플릿·미리보기) → 곡 진행 ①~④가 끝나지 않아 컴파일이 이유와 함께 막힌다(2026-10-26 컴파일 조건).
 * 개발 서버(로컬)에서 돈다 — 데모 스택을 다시 빌드하지 않도록 stack-* 대신 개발 DB를 쓴다. 빅히트 테넌트·계정은 Dynamite 온보딩 단계와 같은 API로 만든다.
 */
async function actAs(page: Page, userId: string, path: string) {
  await page.evaluate((u) => localStorage.setItem("rc.actor.portal", u), userId);
  await page.goto(path);
}

test("빅히트: 새 곡 → 권리·슬롯·파트 → 스템 → 위임 계약 → 팩·규칙, 곡 진행 ①~④ 전에는 컴파일이 이유와 함께 막힌다", async ({ page, request }) => {
  test.setTimeout(240_000);
  await resetAll(request);
  await onboardBighit(request);
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto("/portal/");
  await actAs(page, "usr_bh_rights", "/portal/works/new");
  // 1 곡·녹음
  await page.getByLabel("곡 제목").fill("E2E Song");
  // 유형별 거르기: 마스터 보유는 빅히트 관리 레이블만(소속사 없음), "(우리)" 같은 표시 없음(가이드: "우리" 금지)
  expect((await page.getByLabel("마스터 보유").locator("option").allTextContents()).slice(1)).toEqual(["빅히트 레이블"]);
  await page.getByLabel("마스터 보유").selectOption("pty_bighit_label");
  // 녹음 계약서를 그 자리에서 올린다 → 이 곡의 원본 계약서
  await page.getByLabel("녹음 계약서", { exact: true }).setInputFiles({ name: "e2e-master.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% e2e master\n%%EOF\n") });
  await expect(page.getByRole("table", { name: "올린 녹음 계약서" })).toContainText("e2e-master.pdf");
  await page.getByRole("button", { name: "저장하고 ② 원곡 권리로" }).click();
  // 2 원곡 권리: 작가 2명 균등
  await page.getByRole("button", { name: "+ 작가" }).click();
  const authors = page.getByLabel("작가", { exact: true });
  // 작가 고르기는 작가 당사자만
  expect((await authors.nth(0).locator("option").allTextContents()).slice(1).every((t) => /David Stewart|Jessica Agombar/.test(t))).toBe(true);
  await authors.nth(0).selectOption("pty_david_stewart");
  await authors.nth(1).selectOption("pty_jessica_agombar");
  await page.getByRole("button", { name: "균등 분배" }).click();
  await page.getByLabel("작품 계약서", { exact: true }).setInputFiles({ name: "e2e-publishing.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% e2e publishing\n%%EOF\n") });
  await page.getByRole("button", { name: "저장하고 ③ 멤버로" }).click();
  // 3 멤버
  for (const [id, name] of [["pty_jungkook", "정국"], ["pty_jimin", "지민"]] as const) {
    await page.getByLabel("명부에서 당사자 id로 찾기").fill(id);
    await page.getByRole("button", { name: "찾아 더하기" }).click();
    await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  await expect(page.getByRole("checkbox", { name: "지민", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "저장하고 ④ 확인으로" }).click();
  await expect(page.getByText("대기", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "워크스페이스로 — 슬롯·파트 등록" }).click();

  // 원곡 권리: 슬롯 1(반주 파트 1) + 보컬 파트 2(정국)·3(지민)
  await expect(page.getByRole("heading", { name: "E2E Song" })).toBeVisible();
  await page.getByRole("button", { name: "+ 슬롯 추가" }).click();
  await page.getByLabel("구간 이름").fill("Chorus");
  await page.getByLabel("끝(초)").fill("10");
  await page.getByRole("button", { name: "슬롯 저장" }).click();
  for (const [member, start, end] of [["pty_jungkook", "0", "5"], ["pty_jimin", "5", "10"]] as const) {
    await page.getByRole("button", { name: "파트 추가" }).click();
    await page.getByLabel("원곡 담당").selectOption(member);
    await page.getByLabel("파트 시작(초)").fill(start);
    await page.getByLabel("파트 끝(초)").fill(end);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByLabel("원곡 담당")).toHaveCount(0);
  }
  await expect(page.getByRole("table", { name: "슬롯·파트별 담당" }).getByRole("row")).toHaveCount(4);

  // 스템: 두 보컬 파트의 원곡 스템(권리 주장 함께)
  await page.getByRole("navigation", { name: "워크스페이스 탭" }).getByRole("link", { name: "스템", exact: true }).click();
  for (const who of ["파트 2 (정국) 정국", "파트 3 (지민) 지민"]) {
    await page.getByRole("button", { name: `${who} 없음` }).click();
    await page.getByRole("complementary", { name: "스템 추가" }).getByRole("button", { name: "추가", exact: true }).click();
    await expect(page.getByRole("button", { name: `${who} 원곡` })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /원곡$/ })).toHaveCount(2);

  // 문서·계약: 수령 위임 2건(멤버마다 한 건)
  await page.getByRole("navigation", { name: "워크스페이스 탭" }).getByRole("link", { name: "문서·계약", exact: true }).click();
  // ① 원본 계약서: 마법사에서 올린 두 계약서가 이 곡에 묶여 있다
  await expect(page.getByRole("table", { name: "① 원본 계약서" })).toContainText("녹음 계약서");
  await expect(page.getByRole("table", { name: "① 원본 계약서" })).toContainText("작품 퍼블리싱 계약서");
  await page.getByRole("button", { name: "+ 계약 만들기" }).click();
  await page.getByLabel("계약 종류").selectOption("tpl_performer_mandate");
  await page.getByLabel("위임하는 실연자").selectOption("pending");
  await page.getByLabel("수령하는 소속사").selectOption("pty_bighit_agency");
  await page.getByLabel("위임 비율").fill("100");
  await page.getByLabel("시작일").fill("2026-01-01");
  await page.getByLabel("종료일").fill("2026-12-31");
  await expect(page.getByLabel("미리보기")).toBeVisible();
  await page.getByRole("button", { name: "서명 요청 2건 보내기" }).click();
  // ④ 이용 허락: 수령 위임 2건이 한 줄(반영 0 / 멤버 2), 펼치면 멤버마다 한 줄
  const lic = page.getByRole("table", { name: "④ 이용 허락" });
  await expect(lic.getByRole("row", { name: /실연 수익 수령 위임/ })).toContainText("0 / 2");
  await lic.getByRole("button", { name: "펼치기" }).click();
  await expect(lic.locator("tr.cont")).toHaveCount(2);

  // 분배 규칙·팩: 팩 만들기 → 표준 템플릿 → 미리보기 → 컴파일(정책 편집자)
  await page.getByRole("navigation", { name: "워크스페이스 탭" }).getByRole("link", { name: "분배 규칙·팩", exact: true }).click();
  await page.getByRole("button", { name: "팩 만들기" }).click();
  await expect(page.getByText("청구권자를 원곡 권리대로 선언했습니다")).toBeVisible();
  await actAs(page, "usr_bh_policy", page.url().replace(/^https?:\/\/[^/]+/, ""));
  await page.getByRole("button", { name: "표준 템플릿으로" }).click();
  await page.getByRole("button", { name: "텍스트로 보기" }).click();
  await expect(page.getByLabel("분배 규칙 MDRL")).not.toHaveValue("");
  await expect(page.getByLabel("미리보기 근사")).toContainText("정국 기여");
  // 컴파일 조건(2026-10-26): 곡 진행 ①~④가 끝나지 않았으면 버튼이 꺼지고 이유가 보인다(작가 서명·멤버 확인 대기 → ③).
  // 컴파일 → 승인 → 활성화 → 출시 전 과정은 butter.spec.ts가 본다.
  await expect(page.getByRole("button", { name: "컴파일(IR 생성) → 승인으로" })).toBeDisabled();
  await expect(page.getByRole("status", { name: "컴파일할 수 없는 이유" })).toHaveText("③ 권리 확정이 끝나지 않았다 — 곡 진행 ①~④가 끝나야 컴파일한다");

  expect(failed, failed.join("\n")).toEqual([]);
});
