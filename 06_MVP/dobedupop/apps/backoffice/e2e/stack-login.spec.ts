import { expect, ok, test } from "./fixtures.ts";
import { totp } from "./totp.ts";

/**
 * 로그인(MVP 진행계획 M3)을 배포된 데모 스택의 서브도메인에서 브라우저로 확인한다. 계정 준비는 코어 API(E2E_BACKEND, x-actor)로 한다.
 *   E2E_BACKEND=http://127.0.0.1:18080 npx playwright test
 */
const DOMAIN = process.env.E2E_DOMAIN ?? "dobedupop.localhost";
const site = (sub: string) => `http://${sub}.${DOMAIN}`;
const uid = Date.now().toString(36);

test("권리자 포털: 초대 링크로 비밀번호를 정하고 아이디·비밀번호로 로그인, 로그아웃", async ({ page, request }) => {
  await ok(request, "usr_ops", "POST", "/tenants", { tenantId: `tnt_lbl_${uid}`, tenantType: "LABEL", name: `레이블 ${uid}` });
  const inv = await ok<{ inviteToken: string }>(request, "usr_ops", "POST", "/users", { userId: `usr_lbl_${uid}`, displayName: "레이블 권리 편집", tenantId: `tnt_lbl_${uid}`, roles: ["RIGHTS_EDITOR"] });
  await page.goto(`${site("portal")}/?invite=${inv.inviteToken}`);
  await page.getByLabel("새 비밀번호").fill("label-password-123");
  await page.getByRole("button", { name: "비밀번호 정하기" }).click();
  await expect(page.getByRole("status")).toContainText("비밀번호를 정했습니다");
  await page.getByLabel("아이디").fill(`usr_lbl_${uid}`);
  await page.getByLabel("비밀번호").fill("label-password-123");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByLabel("로그인한 사용자")).toContainText(`usr_lbl_${uid}`);
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page.getByRole("button", { name: "로그인" })).toBeVisible();
});

test("운영 백오피스: 처음 로그인에서 인증 앱(TOTP)을 등록하고 코드로 들어간다", async ({ page, request }) => {
  const inv = await ok<{ inviteToken: string }>(request, "usr_ops", "POST", "/users", { userId: `usr_ops_${uid}`, displayName: "운영 신입", tenantId: "tnt_platform", roles: ["SPACE_OPS"] });
  await page.goto(`${site("ops")}/?invite=${inv.inviteToken}`);
  await page.getByLabel("새 비밀번호").fill("ops-password-1234");
  await page.getByRole("button", { name: "비밀번호 정하기" }).click();
  await page.getByLabel("아이디").fill(`usr_ops_${uid}`);
  await page.getByLabel("비밀번호").fill("ops-password-1234");
  await page.getByRole("button", { name: "로그인" }).click();
  const secret = (await page.getByLabel("인증 앱 등록 키").innerText()).trim();
  await page.getByLabel("인증 앱 코드").fill(totp(secret, Date.now()));
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByLabel("로그인한 사용자")).toContainText(`usr_ops_${uid}`);
});

test("실연자 앱: 본인 인증 코드로 로그인한다(데모는 코드를 화면에 보여 준다)", async ({ page, request }) => {
  await ok(request, "usr_editor", "POST", "/parties", { partyId: `pty_m_${uid}`, partyType: "MEMBER", displayName: "멤버 데모", tenantId: "tnt_platform_default" });
  await ok(request, "usr_ops", "POST", "/users", { userId: `usr_m_${uid}`, displayName: "멤버 데모", tenantId: "tnt_platform_default", roles: ["PERFORMER"], partyId: `pty_m_${uid}` });
  await page.goto(site("artist"));
  await page.getByLabel("계정 아이디").fill(`usr_m_${uid}`);
  await page.getByRole("button", { name: "인증 코드 받기" }).click();
  const code = (await page.getByTestId("dev-code").innerText()).replace(/\D/g, "");
  await page.getByLabel("인증 코드").fill(code);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("본인 인증됨")).toBeVisible();
});

test("데모 페르소나 빠른 로그인, 게이트웨이는 개발용 신원 헤더를 지운다", async ({ page }) => {
  await page.goto(site("ops"));
  await page.getByRole("region", { name: "데모 페르소나" }).getByRole("button", { name: /usr_ops/ }).first().click();
  await expect(page.getByLabel("로그인한 사용자")).toContainText("usr_ops");
  const r = await page.request.get(`${site("portal")}/api/portal/me`, { headers: { "x-actor": "usr_ops" } });
  expect(r.status()).toBe(401);
});

test("운영 온보딩 화면: 테넌트 등록 → 담당자 계정 발급(초대 링크) → 담당자가 포털에 로그인", async ({ page, browser }) => {
  const tid = `tnt_ui_${uid}`;
  await page.goto(`${site("ops")}/admin/tenants?persona=usr_ops`);
  await page.getByLabel("테넌트 id").fill(tid);
  await page.getByLabel("테넌트 이름").fill(`UI 레이블 ${uid}`);
  await page.getByLabel("테넌트 유형").selectOption("LABEL");
  await page.getByRole("button", { name: "테넌트 등록" }).click();
  await page.getByRole("status").getByRole("link", { name: tid }).click();
  await expect(page.getByRole("heading", { name: `UI 레이블 ${uid}` })).toBeVisible();
  await page.getByLabel("새 계정 아이디").fill(`usr_ui_${uid}`);
  await page.getByLabel("새 계정 이름").fill("UI 권리 편집");
  await page.getByRole("checkbox", { name: "권리 편집" }).check();
  await page.getByRole("button", { name: "계정 만들기" }).click();
  const link = await page.getByLabel("초대 링크 주소").inputValue();
  expect(link).toMatch(new RegExp(`^http://portal\\.${DOMAIN.replace(/\./g, "\\.")}/\\?invite=`));
  await expect(page.getByRole("row").filter({ hasText: `usr_ui_${uid}` })).toContainText("초대 수락 대기");
  const p2 = await (await browser.newContext()).newPage();
  await p2.goto(link);
  await p2.getByLabel("새 비밀번호").fill("ui-password-12345");
  await p2.getByRole("button", { name: "비밀번호 정하기" }).click();
  await p2.getByLabel("아이디").fill(`usr_ui_${uid}`);
  await p2.getByLabel("비밀번호").fill("ui-password-12345");
  await p2.getByRole("button", { name: "로그인" }).click();
  await expect(p2.getByLabel("로그인한 사용자")).toContainText(`usr_ui_${uid}`);
  await expect(p2.getByRole("heading", { name: `UI 레이블 ${uid}` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: `usr_ui_${uid}` })).toContainText("비밀번호");
});
