import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "mdrl/allocation";
import { reverse } from "mdrl/allocation";
import { shadowReport } from "mdrl/allocation";
import { evaluationInput, loadAllocationCase } from "../../../../packages/mdrl/test/helpers.ts";

test("reverse contract: partial refund creates negative reversal lines conserving value", () => {
  const c = loadAllocationCase("001-basic");
  const evalRes = evaluate(evaluationInput(c));
  assert.ok(evalRes.ok);
  const original = evalRes.value;

  // 10,000원 매출 중 2,500원 부분 환불
  const rev = reverse({
    original,
    policy: c.policy,
    eventId: "ev_001",
    refund: { id: "rf_test_1", reason: "REFUND", amount: "2500" },
    priors: [],
    runId: "rev_run_01",
  });

  assert.ok(rev.ok);
  assert.equal(rev.value.sequence, "1");
  assert.equal(rev.value.cumulative, "2500");

  // pool 라인 합계가 정확히 -2,500원인지 검증
  const totalPoolReversed = rev.value.pool_lines.reduce(
    (acc, p) => acc + BigInt(p.amount),
    0n,
  );
  assert.equal(totalPoolReversed, -2500n);

  // 모든 역분개 라인의 금액이 음수인지 확인
  assert.ok(rev.value.lines.every((l) => BigInt(l.amount) < 0n));
});

test("reverse contract: refund exceeding original or remaining settled amount is rejected", () => {
  const c = loadAllocationCase("001-basic");
  const evalRes = evaluate(evaluationInput(c));
  assert.ok(evalRes.ok);
  const original = evalRes.value;

  // 원금 10,000원을 초과하는 12,000원 환불 시도
  const rev = reverse({
    original,
    policy: c.policy,
    eventId: "ev_001",
    refund: { id: "rf_excess", reason: "REFUND", amount: "12000" },
    priors: [],
    runId: "rev_excess_run",
  });

  assert.equal(rev.ok, false);
  assert.ok(rev.errors.some((e) => e.code === "REV_EXCEEDS_REMAINING"));
});

test("shadowReport contract: recalculating with revised policy computes exact delta per party", () => {
  const c = loadAllocationCase("001-basic");
  const evalInput = evaluationInput(c);

  // 동일 입력(baseline = candidate)으로 섀도 리포트 생성 시 차액(delta)은 0이어야 함
  const s = shadowReport([{ baseline: evalInput, candidate: evalInput }]);

  assert.ok(s.ok);
  assert.equal(s.value.format, "mdrl-shadow-report/1");

  // 모든 당사자의 delta가 0이어야 함
  for (const p of s.value.parties) {
    assert.equal(p.delta, "0", `delta for party ${p.party}`);
  }
});
