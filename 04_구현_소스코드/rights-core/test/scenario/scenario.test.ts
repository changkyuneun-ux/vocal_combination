import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { tempBridge } from "../fixtures.ts";
import { mulberry32 } from "../../src/scenario/prng.ts";
import { runScenario } from "../../src/scenario/run.ts";

const { db, drop } = await freshDb();
const { ctx, cleanup } = tempBridge();
after(async () => { await drop(); cleanup(); });

test("mulberry32 is deterministic", () => {
  const a = mulberry32(42), b = mulberry32(42);
  const xs = Array.from({ length: 5 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test("reduced scenario (200 combinations): all seals re-derive, dispute flow passes", async () => {
  const r = await runScenario({ db, ctx }, { n: 200, seed: 7 });
  assert.equal(r.issued, 200);
  // 한 멤버가 모든 슬롯을 부른 조합(멤버 3명·슬롯 4개면 3/81)은 사전 검사로 거부되고 다음 조합으로 넘어간다.
  assert.ok(r.rejected > 0 && r.rejected < 200, String(r.rejected));
  assert.equal(r.auditMismatches, 0);
  assert.equal(r.factsRederiveOk, true);
  assert.equal(r.disputeFlowOk, true);
  // 조합 지분 IR에는 as_of(발행 시각)가 들어가므로 발행마다 digest가 다르다. 같은 조합은 벡터·경로만 같다.
  assert.equal(r.distinctProjections, r.issued);
  assert.ok(r.distinctVectorSets >= 2 && r.distinctVectorSets <= 81, String(r.distinctVectorSets));
  assert.ok(r.p95Ms > 0);
});
