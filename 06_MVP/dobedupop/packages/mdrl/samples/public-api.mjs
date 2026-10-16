// 저장소 내 적합성 데이터를 사용하는 공개 API 예제. 실제 권리 승인 데이터가 아니다.
import { readFileSync } from "node:fs";
import { projectToIr } from "mdrl/facts";
import { compileAllocation } from "mdrl/text";
import { evaluate, verifyAllocationResult } from "mdrl/allocation";
import { evaluateGrant } from "mdrl/grant";
import { ProfileRegistry } from "mdrl/profiles";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const unwrap = (result) => {
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
};
const allocationCase = json("conformance/allocation/001-basic/input.json");
const factsCase = json(`conformance/facts/${allocationCase.facts_case}/input.json`);
const { facts, usage, as_of, known_at } = factsCase;
const policy = unwrap(compileAllocation(read("conformance/text/001-basic.mdrl")));
const projection = unwrap(projectToIr(facts, usage, as_of, known_at));
const { snapshot, events, run_id: runId } = allocationCase;
const settlement = unwrap(evaluate({ policy, facts, projection, snapshot, events, runId }));
const errors = verifyAllocationResult({ policy, facts, usage, asOf: as_of, knownAt: known_at, snapshot, events, runId }, settlement);
if (errors.length) throw new Error(JSON.stringify(errors));

// 독립 Grant 예제: 권리 요구는 있지만 허락이 없으므로 DENY.
// Allocation은 Grant를 자동 검사하지 않는다. 두 호출의 통합은 서버의 후속 구현 대상이다.
const decision = evaluateGrant({
  requirements: [{ asset: facts.body.recordings[0].id, right_type: "MASTER",
    scope: { actions: ["COMBINE"], territories: ["KR"], media: ["APP"],
      period: { from: as_of }, audience: ["PERSONAL"] } }],
  grants: [], as_of, known_at,
});
if (decision.result !== "DENY") throw new Error("Missing grant must deny");
console.log(JSON.stringify({
  profile: ProfileRegistry.get("vocal-combination")?.id,
  grantDecision: decision.result,
  resultDigest: settlement.result_digest,
  allocatedLines: settlement.lines.length,
  holdings: settlement.holdings.length,
}, null, 2));
