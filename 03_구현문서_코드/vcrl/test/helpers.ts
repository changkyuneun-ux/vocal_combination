import { readFileSync } from "node:fs";
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
