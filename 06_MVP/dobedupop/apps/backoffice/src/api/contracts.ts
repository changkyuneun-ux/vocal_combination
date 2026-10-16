import { toBps } from "./policyForm.ts";

/** 표준 계약(원천 문서 설계 S4) 화면용 타입과 변환. */
export type TemplateVar = { name: string; label: string; type: "party" | "recording" | "voice" | "date" | "multi" | "bps"; options?: [string, string][]; optional?: boolean };
export type Template = {
  templateId: string; version: number; kind: string; recordKind: string; title: string; variables: TemplateVar[];
  clauses: { clauseId: string; heading: string; text: string }[]; signerVars: string[]; status: string; authoredBy?: string; approvedBy?: string;
};
export type Signature = { partyId: string; displayName: string; signerVar: string; signedAt?: string; method?: string; signedBy?: string };
export type Contract = {
  contractId: string; templateId: string; templateVersion: number; factsScopeId: string; title: string; status: string; provider: string; sha256: string;
  createdBy: string; createdAt: string; signatures: Signature[]; records: { type: string; id: string }[]; document?: { documentId: string; version: number }; html?: string;
};
export type FormValue = string | string[];

/** 템플릿별로 쓸 수 있는(승인된) 최신 버전만 고른다. */
export function usableTemplates(all: Template[]): Template[] {
  const best = new Map<string, Template>();
  for (const t of all) if (t.status === "APPROVED" && (best.get(t.templateId)?.version ?? 0) < t.version) best.set(t.templateId, t);
  return [...best.values()].sort((a, b) => a.title.localeCompare(b.title, "ko"));
}

/** 입력 폼 값 → API 답. 빈 값은 빼고, 비율(%)은 bps로 바꾼다. */
export function toAnswers(vars: TemplateVar[], form: Record<string, FormValue>): Record<string, string | string[] | number> {
  const out: Record<string, string | string[] | number> = {};
  for (const v of vars) {
    const x = form[v.name];
    if (x === undefined || x === "" || (Array.isArray(x) && x.length === 0)) continue;
    out[v.name] = v.type === "bps" ? toBps(String(x)) : x;
  }
  return out;
}

export const CONTRACT_STATUS: Record<string, [string, string]> = {
  SENT: ["서명 대기", "warn"], SIGNED: ["서명 완료(반영 전)", "warn"], COMPLETED: ["기록 반영됨", "ok"], CANCELLED: ["취소", "muted"],
};
