// 개발 서버(RC_DEV)를 초기화하고 Dynamite 페르소나 단계를 지정한 단계까지 돌린다(E2E 사전 조건).
// 사용: node e2e/seed-dynamite.mjs <마지막 단계 id> [--authors-later]  (--authors-later: 작가용 권리 확인서를 보내지 않는다 — 계약서 불러오기 E2E)
// 구매 수는 데모와 같은 기본값(조합 1,200·500·300·200)이라 지급 금액도 데모와 같다.
// 단계는 코어의 시나리오(src/scenario/dynamite-personas.ts)를 그대로 쓰고, 호출은 데모 시드와 같은 HTTP 드라이버로 보낸다.
const root = new URL("../../../", import.meta.url);
const { STEPS } = await import(new URL("services/rights-core/src/scenario/dynamite-personas.ts", root).href);
const { httpDriver } = await import(new URL("demo/dynamite/src/http-driver.ts", root).href);
const CORE = process.env.E2E_BACKEND ?? "http://127.0.0.1:8080";
const last = process.argv[2] ?? "contracts";
const opts = { authorsConfirmLater: process.argv.includes("--authors-later") };
const r = await fetch(`${CORE}/dev/reset`, { method: "POST", headers: { "content-type": "application/json", "x-dbp-csrf": "1" }, body: "{}" });
if (!r.ok) throw new Error(`reset failed: ${r.status} ${await r.text()}`);
const d = httpDriver(CORE, { log: () => {} });
for (const st of STEPS) {
  await st.run(d, {}, opts);
  if (st.id === last) break;
}
console.log(`dynamite seeded through ${last}`);
