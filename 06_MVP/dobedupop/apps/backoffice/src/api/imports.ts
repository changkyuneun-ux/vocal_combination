/** 계약서 불러오기(3부-B, 결정 CT1~CT5) 응답 모양. 코어 src/contracts/imports.ts·frames.ts와 같다. */
export type FrameValue = { text: string } | { partyId: string; shareBps: number; roleDetail: string | null } | { partyId: string } | { date: string };
export type ImportValue = {
  key: string; label: string; irItem: string; page: number; clause: string; value: FrameValue | null; partyName: string | null; quote: string | null;
  origin: "FRAME" | "MANUAL"; compared: "SAME" | "NEW" | "DIFFERENT" | null; confirmed: boolean; confirmedBy: string | null;
};
export type IrGapRow = { group: string; need: string; source: string; state: "FILLED" | "MISSING" | "IN_PROGRESS"; count?: string };
export type ImportStep = "VALUES" | "GAPS" | "READY" | "CONFIRM_SENT" | "DONE";
export type ImportView = {
  importId: string; factsScopeId: string; workId: string; step: ImportStep; contractId: string | null; createdBy: string; createdAt: string;
  document: { documentId: string; version: number; title: string; kind: string; mime: string; sha256: string; uploadedAt: string; effectiveFrom: string | null; effectiveTo: string | null;
    parties: { partyId: string; name: string; offPlatform: boolean }[] };
  frame: { frameId: string; version: number; title: string; pages: number | null; documentKind: string } | null;
  values: ImportValue[]; gaps: { usage: string[]; territory: string; validTo: string } | null; ir: IrGapRow[]; missing: string[];
};
export type ReadingFrame = {
  frameId: string; version: number; ownerTenantId: string; title: string; documentKind: string; pages: number | null;
  fields: { key: string; label: string; irItem: string; page: number; clause: string; pattern: string }[];
  status: string; authoredBy: string; authoredAt: string; approvedBy?: string; approvedAt?: string; uses: number;
};
export type ConfirmationPreview = {
  html: string; signers: string[]; labels: Record<string, string>; answers: Record<string, unknown>;
  records: { type: string; edge?: string; rightType?: string }[];
  template: { templateId: string; version: number; title: string; clauses: { clauseId: string; heading: string; text: string }[] };
  signerParties: { partyId: string; name: string; offPlatform: boolean }[];
};
export const USAGE: [string, string][] = [["COMBINE", "조합"], ["PURCHASE", "구매"], ["LISTEN", "감상"], ["RESALE", "재판매"]];
export const TERRITORY: [string, string][] = [["WORLD", "전 세계"], ["KR", "대한민국"]];
export const IMPORT_STEPS = ["계약서 불러오기", "후보 값 확인", "IR 정보 대조", "빠진 것 입력", "권리 확인서 서명"];
/** 단계 → 지금 칸(1부터). 확인서를 보냈으면 5. */
export function stepNo(step: ImportStep | null): number {
  return step === null ? 1 : step === "VALUES" ? 2 : step === "GAPS" ? 4 : step === "READY" ? 4 : 5;
}
/** 후보 값을 화면 글자로(시안: "David Stewart · 작사·작곡 50%", 날짜는 Mono). */
export const ROLE_DETAIL: Record<string, string> = { LYRICS_COMPOSITION: "작사·작곡", LYRICS: "작사", COMPOSITION: "작곡", ARRANGEMENT: "편곡" };
export function valueText(v: ImportValue): string {
  const x = v.value;
  if (x === null) return "—";
  if ("text" in x) return x.text;
  if ("date" in x) return x.date;
  if ("shareBps" in x) return `${v.partyName ?? x.partyId} · ${ROLE_DETAIL[x.roleDetail ?? ""] ?? x.roleDetail ?? ""} ${x.shareBps / 100}%`.replace(" ·  ", " · ");
  return v.partyName ?? x.partyId;
}
