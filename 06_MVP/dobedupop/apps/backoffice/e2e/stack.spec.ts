import { expect, ok, prepareSettled, test } from "./fixtures.ts";

/**
 * 배포된 데모 스택 시험(MVP 진행계획 M2): 코어를 역할별 컨테이너(API·워커·검증 워커)로 나눠도 정산이 끝까지 돈다.
 * 실행(워커) → 독립 재계산(검증 워커) → VERIFIED → 확정 → 원장 분개(워커). 봉인 원문은 S3 호환 저장소에 있다.
 *   E2E_BACKEND=http://127.0.0.1:18080 npx playwright test   (deploy/compose/compose.demo.test.yml로 코어 API를 잠시 연다)
 */
test("역할을 나눈 코어에서 정산이 실행·검증·확정·분개까지 간다", async ({ request }) => {
  const s = await prepareSettled(request);
  expect(s.runIds.length).toBeGreaterThan(0);
  const runs = await ok<{ items: { status: string }[] }>(request, "usr_ops", "GET", `/batches/${s.batchId}/runs?limit=200`);
  expect(runs.items.every((r) => r.status === "CONFIRMED")).toBe(true);
});
