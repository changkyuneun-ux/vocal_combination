import { readFileSync } from "node:fs";
import type { EvaluationInput } from "../src/allocation/evaluate.ts";
import type { AllocationDocument, RevenueEvent, Snapshot } from "../src/allocation/types.ts";
import { projectToIr } from "../src/facts/result.ts";
import type { Claim, ClaimantRole, FactsDocument, Mandate } from "../src/facts/types.ts";

export type BasicInput = {
  facts: FactsDocument;
  usage: Record<string, string>;
  as_of: string;
  known_at: string;
  declared_claimants: { role: ClaimantRole; party: string }[];
};

/** 매 호출마다 파일을 새로 읽으므로 반환값을 자유롭게 변형해도 된다. */
export function loadBasic(): BasicInput {
  return JSON.parse(readFileSync(new URL("../conformance/facts/001-basic/input.json", import.meta.url), "utf8"));
}

export function claimOf(input: BasicInput, id: string): Claim {
  const c = input.facts.body.claims.find((x) => x.id === id);
  if (!c) throw new Error(`no claim ${id}`);
  return c;
}

export function mandateOf(input: BasicInput, id: string): Mandate {
  const m = input.facts.body.mandates.find((x) => x.id === id);
  if (!m) throw new Error(`no mandate ${id}`);
  return m;
}

const BODY_ARRAYS = ["parties", "works", "recordings", "voices", "stems", "claims", "mandates"] as const;

/** 정규형(id 오름차순, 코드 유닛 비교)으로 7개 엔티티 배열을 정렬한다. 엔티티를 추가한 테스트는 호출해야 한다. */
export function sortBody(input: BasicInput): BasicInput {
  const body = input.facts.body as unknown as Record<string, { id: string }[]>;
  for (const k of BODY_ARRAYS) body[k]!.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return input;
}

export type AllocationCase = {
  facts_case: string;
  policy: AllocationDocument;
  snapshot: Snapshot;
  events: RevenueEvent[];
  run_id: string;
};

export function loadAllocationCase(name = "001-basic"): AllocationCase {
  return JSON.parse(readFileSync(new URL(`../conformance/allocation/${name}/input.json`, import.meta.url), "utf8"));
}

export function loadFactsCase(name: string): BasicInput {
  return JSON.parse(readFileSync(new URL(`../conformance/facts/${name}/input.json`, import.meta.url), "utf8"));
}

/** 할당 케이스의 facts 케이스로 투영 IR을 만들어 평가기 입력을 구성한다. */
export function evaluationInput(c: AllocationCase): EvaluationInput {
  const f = loadFactsCase(c.facts_case);
  const p = projectToIr(f.facts, f.usage, f.as_of, f.known_at);
  if (!p.ok) throw new Error(p.errors.map((e) => e.code).join(","));
  return { policy: c.policy, facts: f.facts, projection: p.value, snapshot: c.snapshot, events: c.events, runId: c.run_id };
}
