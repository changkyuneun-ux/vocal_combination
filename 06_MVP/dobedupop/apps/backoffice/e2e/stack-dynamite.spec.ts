import { expect, ok, test } from "./fixtures.ts";
import { ensureDynamite } from "./demo-seed.ts";

/**
 * 데모 스택의 Dynamite 시연 데이터(MVP 진행계획 M4): 데모 진행판의 단계를 끝까지 실행한 상태를 만들고(이미 끝났으면 그대로),
 * 역할을 나눈 코어(API·워커·검증 워커)에서 정산·검증·확정·지급이 예시 보고서와 같은 금액으로 끝났는지 본다.
 *   E2E_BACKEND=http://127.0.0.1:18080 npx playwright test   (deploy/compose/compose.demo.test.yml로 코어 API를 잠시 연다)
 */
test("Dynamite 시연 데이터: 역할을 나눈 코어에서 정산 확정·지급 완료, 금액은 예시 보고서와 같다", async ({ request }) => {
  test.setTimeout(25 * 60_000);
  await ensureDynamite(request);
  const runs = await ok<{ items: { status: string }[] }>(request, "usr_ops", "GET", "/batches/bat_bts_2026_03/runs?limit=200");
  expect(runs.items.map((r) => r.status)).toEqual(["CONFIRMED", "CONFIRMED", "CONFIRMED", "CONFIRMED"]);
  const pay = await ok<{ items: { partyId: string; status: string; netKrw: string; withholdingKrw: string }[] }>(request, "usr_settle", "GET", "/payout-runs/pay-2026-05/instructions?limit=50");
  const by = Object.fromEntries(pay.items.map((i) => [i.partyId, `${i.status} ${i.netKrw} ${i.withholdingKrw}`]));
  expect(by).toEqual({
    pty_bighit_agency: "PAID 2285920 0", pty_bighit_label: "PAID 2030952 0",
    pty_david_stewart: "PAID 296604 83650", pty_jessica_agombar: "PAID 296604 83650",
  });
});
