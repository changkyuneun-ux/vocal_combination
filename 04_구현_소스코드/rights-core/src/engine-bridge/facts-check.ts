import { validateFacts } from "mdrl/facts";
import type { Tx } from "../platform/db.ts";
import type { Diagnostic } from "../platform/errors.ts";
import { buildFactsDocument } from "./convert-facts.ts";
import { loadFactsRows } from "./facts.ts";

/** 지금의 권리 기록으로 facts를 만들어 MDRL 정적 검증만 한다(봉인하지 않음). 정합성 검증(원천 문서 설계 S3a)이 엔진 진단을 이슈로 옮길 때 쓴다. */
export async function factsDiagnostics(tx: Tx, scopeId: string, knownAt: string): Promise<Diagnostic[]> {
  return [...validateFacts(buildFactsDocument(await loadFactsRows(tx, scopeId, knownAt), knownAt))];
}
