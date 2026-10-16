import { expect, test } from "./fixtures.ts";
import { ensureDynamite } from "./demo-seed.ts";

/**
 * 화면 점검(MVP 진행계획 M5): 데모 스택(Dynamite 시드 완료 상태)에서 페르소나로 로그인해 메뉴의 모든 화면을 열고,
 * 실패한 API 호출(4xx·5xx)과 콘솔 오류를 모은다. 5xx·콘솔 오류는 실패, 4xx는 목록으로 남긴다(역할 밖 위젯 등 검토 대상).
 *   E2E_BACKEND=http://127.0.0.1:18080 npx playwright test e2e/stack-screens.spec.ts
 */
const DOMAIN = process.env.E2E_DOMAIN ?? "dobedupop.localhost";
test.beforeAll(async ({ request }) => { test.setTimeout(25 * 60_000); await ensureDynamite(request); });
const cases: { app: string; persona: string }[] = [
  { app: "portal", persona: "usr_bh_rights" }, { app: "portal", persona: "usr_bh_policy" },
  { app: "ops", persona: "usr_ops" }, { app: "ops", persona: "usr_settle" },
];

for (const c of cases) {
  test(`${c.app} 화면 점검 — ${c.persona}`, async ({ page }) => {
    test.setTimeout(300_000);
    const problems: string[] = [];
    let route = "/";
    page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${route} → ${r.request().method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`); });
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console ${route}: ${m.text().slice(0, 200)}`); });
    await page.goto(`http://${c.app}.${DOMAIN}/?persona=${c.persona}`);
    await expect(page.getByLabel("로그인한 사용자")).toContainText(c.persona);
    const links = await page.locator("nav.menu a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    for (const href of links) {
      route = href;
      await page.goto(`http://${c.app}.${DOMAIN}${href}`);
      await page.waitForLoadState("networkidle");
    }
    console.log(`\n[${c.app} ${c.persona}] ${links.length} screens, ${problems.length} problems\n${problems.join("\n")}`);
    expect(problems.filter((p) => /^5\d\d|^console/.test(p))).toEqual([]);
  });
}

test("실연자 앱 화면 점검 — 정국", async ({ page }) => {
  const problems: string[] = [];
  page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`); });
  await page.goto(`http://artist.${DOMAIN}/?persona=usr_member_jungkook`);
  await expect(page.getByText("본인 인증됨")).toBeVisible();
  for (const tab of ["동의", "사용", "수익", "이의제기", "알림"]) {
    await page.getByRole("button", { name: new RegExp(`^${tab}`) }).first().click();
    await page.waitForLoadState("networkidle");
  }
  console.log(`\n[artist usr_member_jungkook] ${problems.length} problems\n${problems.join("\n")}`);
  expect(problems.filter((p) => /^5\d\d|^console/.test(p))).toEqual([]);
});
