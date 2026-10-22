import type { Page } from "@playwright/test";
import { expect, ok, resetAll, test } from "./fixtures.ts";

/**
 * 빅히트 작품·곡 워크스페이스 화면 흐름(2부-B Task 9, 시안 Catalog·Song-*): 새 곡 마법사 → 원곡 권리(슬롯·파트) → 스템 → 수령 위임 계약 →
 * 분배 규칙·팩(표준 템플릿·미리보기) → 컴파일(IR 생성) → 원곡 권리가 조회만 → 승인 → 활성화는 차단 이유와 함께 막힌다.
 * 개발 서버(로컬)에서 돈다 — 데모 스택을 다시 빌드하지 않도록 stack-* 대신 개발 DB를 쓴다. 빅히트 테넌트·계정은 Dynamite 온보딩 단계와 같은 API로 만든다.
 */
async function actAs(page: Page, userId: string, path: string) {
  await page.evaluate((u) => localStorage.setItem("rc.actor", u), userId);
  await page.goto(path);
}

test("빅히트: 새 곡 → 권리·슬롯·파트 → 스템 → 위임 계약 → 팩·규칙 → 컴파일 → 승인, 활성화는 조건 미충족으로 막힌다", async ({ page, request }) => {
  test.setTimeout(240_000);
  await resetAll(request);
  // 온보딩(Dynamite onboard 단계와 같은 API): 빅히트 테넌트 확인됨, 담당자 계정, 멤버·작가 당사자.
  await ok(request, "usr_ops", "POST", "/users", { userId: "usr_rights", displayName: "온보딩", roles: ["ONBOARDING"], tenantId: "tnt_platform" }).catch(() => undefined);
  await ok(request, "usr_rights", "POST", "/tenants", { tenantId: "tnt_bighit", tenantType: "LABEL", name: "빅히트 뮤직", businessNo: "BRN-E2E", country: "KR", representative: "대표" });
  for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT"]) await ok(request, "usr_rights", "PUT", `/tenants/tnt_bighit/checks/${item}`, { checked: true, note: "e2e" });
  await ok(request, "usr_rights", "POST", "/tenants/tnt_bighit/status", { status: "VERIFIED" });
  // 운영은 첫 관리자만 발급하고(결정 TD4), 담당자는 빅히트 관리자가 포털에서 초대한다.
  await ok(request, "usr_ops", "POST", "/users", { userId: "usr_bh_admin", displayName: "빅히트 관리자", roles: ["TENANT_ADMIN"], tenantId: "tnt_bighit" });
  for (const [userId, role] of [["usr_bh_rights", "RIGHTS_EDITOR"], ["usr_bh_policy", "EDITOR"], ["usr_bh_approver", "WORK_APPROVER"], ["usr_bh_activator", "ACTIVATOR"]] as const) {
    await ok(request, "usr_bh_admin", "POST", "/portal/users", { userId, displayName: userId, roles: [role] });
  }
  for (const [partyId, name] of [["pty_jungkook", "정국"], ["pty_jimin", "지민"]] as const) {
    await ok(request, "usr_rights", "POST", "/parties", { partyId, partyType: "MEMBER", displayName: name, tenantId: "tnt_platform_default" });
  }
  for (const [partyId, name] of [["pty_david_stewart", "David Stewart"], ["pty_jessica_agombar", "Jessica Agombar"]] as const) {
    await ok(request, "usr_rights", "POST", "/parties", { partyId, partyType: "AUTHOR", displayName: name });
  }
  for (const [partyId, partyType, displayName] of [["pty_bighit_label", "LABEL", "빅히트 레이블"], ["pty_bighit_agency", "AGENCY", "빅히트 소속사"]] as const) {
    await ok(request, "usr_bh_rights", "POST", "/portal/parties", { partyId, partyType, displayName });
  }
  const failed: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

  await page.goto("/portal/");
  await actAs(page, "usr_bh_rights", "/portal/works/new");
  // 1 곡·녹음
  await page.getByLabel("곡 제목").fill("E2E Song");
  await page.getByLabel("마스터 보유(우리 당사자)").selectOption("pty_bighit_label");
  await page.getByRole("button", { name: "저장하고 2 원곡 권리로" }).click();
  // 2 원곡 권리: 작가 2명 균등
  await page.getByRole("button", { name: "+ 작가" }).click();
  const authors = page.getByLabel("작가", { exact: true });
  await authors.nth(0).selectOption("pty_david_stewart");
  await authors.nth(1).selectOption("pty_jessica_agombar");
  await page.getByRole("button", { name: "균등 분배" }).click();
  await page.getByRole("button", { name: "저장하고 3 멤버로" }).click();
  // 3 멤버
  for (const [id, name] of [["pty_jungkook", "정국"], ["pty_jimin", "지민"]] as const) {
    await page.getByLabel("명부에서 당사자 id로 찾기").fill(id);
    await page.getByRole("button", { name: "찾아 더하기" }).click();
    await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  await expect(page.getByRole("checkbox", { name: "지민", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "저장하고 4 확인으로" }).click();
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
  for (const who of ["파트 2 정국", "파트 3 지민"]) {
    await page.getByRole("button", { name: `${who} 없음` }).click();
    await page.getByRole("button", { name: "스템 저장" }).click();
    await expect(page.getByRole("button", { name: `${who} 원곡` })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /원곡$/ })).toHaveCount(2);

  // 문서·계약: 수령 위임 2건(멤버마다 한 건)
  await page.getByRole("navigation", { name: "워크스페이스 탭" }).getByRole("link", { name: "문서·계약", exact: true }).click();
  await page.getByRole("button", { name: "+ 계약 만들기" }).click();
  await page.getByLabel("계약 종류").selectOption("tpl_performer_mandate");
  await page.getByRole("checkbox", { name: "정국", exact: true }).check();
  await page.getByRole("checkbox", { name: "지민", exact: true }).check();
  await page.getByLabel("수령하는 소속사").selectOption("pty_bighit_agency");
  await page.getByLabel("위임 비율").fill("100");
  await page.getByLabel("시작일").fill("2026-01-01");
  await page.getByLabel("종료일").fill("2026-12-31");
  await page.getByRole("button", { name: "미리보기" }).click();
  await page.getByRole("button", { name: "서명 요청 2건 보내기" }).click();
  await expect(page.getByRole("table", { name: "이 곡의 표준 계약" }).getByRole("row")).toHaveCount(3);

  // 분배 규칙·팩: 팩 만들기 → 표준 템플릿 → 미리보기 → 컴파일(정책 편집자)
  await page.getByRole("navigation", { name: "워크스페이스 탭" }).getByRole("link", { name: "분배 규칙·팩", exact: true }).click();
  await page.getByRole("button", { name: "팩 만들기" }).click();
  await expect(page.getByText("청구권자를 원곡 권리대로 선언했습니다")).toBeVisible();
  await actAs(page, "usr_bh_policy", page.url().replace(/^https?:\/\/[^/]+/, ""));
  await page.getByLabel("표준 템플릿").selectOption("ptpl_indie_standard");
  await page.getByRole("button", { name: "표준 템플릿으로" }).click();
  await expect(page.getByLabel("분배 규칙 MDRL")).not.toHaveValue("");
  await expect(page.getByLabel("미리보기 근사")).toContainText("정국 기여");
  await page.getByRole("button", { name: "컴파일(IR 생성) → 승인으로" }).click();
  await page.getByRole("alertdialog", { name: "컴파일 확인" }).getByRole("button", { name: "컴파일" }).click();
  await expect(page.getByRole("heading", { name: /승인 흐름/ })).toBeVisible();

  // IR 생성 뒤 원곡 권리는 조회만
  await actAs(page, "usr_bh_rights", page.url().replace(/^https?:\/\/[^/]+/, "").replace(/release$/, "rights"));
  await expect(page.getByLabel("IR 상태")).toContainText("IR 생성됨");
  await expect(page.getByRole("button", { name: "파트 추가" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ 슬롯 추가" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 버전으로 바로잡기" })).toBeVisible();

  // 승인(승인 담당) → 활성화는 막힌다(정합성 차단·테넌트 확인됨 상태)
  const release = page.url().replace(/^https?:\/\/[^/]+/, "").replace(/rights$/, "release");
  await actAs(page, "usr_bh_approver", release);
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByRole("button", { name: "승인됨" })).toBeVisible();
  await actAs(page, "usr_bh_activator", release);
  await expect(page.getByRole("button", { name: "활성화", exact: true })).toBeDisabled();
  await expect(page.getByRole("note")).toContainText("활성화할 수 없다");
  await expect(page.getByRole("list", { name: "출시 조건" })).toContainText("테넌트 활성");

  expect(failed, failed.join("\n")).toEqual([]);
});
