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
    parties: { partyId: string; name: string; noAccount: boolean; manager: string | null }[] };
  frame: { frameId: string; version: number; title: string; pages: number | null; documentKind: string } | null;
  values: ImportValue[]; gaps: Gaps | null; ir: IrGapRow[]; missing: string[];
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
  signerParties: { partyId: string; name: string; noAccount: boolean; manager: string | null }[];
};
/** 빠진 것 입력(시안 Song-Import 2026-10-23 정정): 동의 기록과 같은 어휘 — 이용 행위·지역·매체·공개 대상. */
export type Gaps = { actions: string[]; territories: string[]; media: string[]; audience: string[]; validTo: string };
export const ACTIONS: [string, string][] = [["PREVIEW", "미리듣기"], ["COMBINE", "조합 생성"], ["PERSONAL_HOLD", "개인 보관"], ["SHARE_LINK", "링크 공유"], ["DOWNLOAD", "내려받기"]];
export const TERRITORIES: [string, string][] = [["KR", "대한민국"], ["JP", "일본"], ["US", "미국"]];
export const MEDIA: [string, string][] = [["FAN_APP", "팬앱"], ["EXTERNAL_SNS", "외부 SNS"]];
export const AUDIENCE: [string, string][] = [["FAN_COMMUNITY", "팬 커뮤니티"], ["PUBLIC", "전체 공개"]];
/** 관리 테넌트 이름 → 시안의 짧은 이름("빅히트 뮤직 — 레이블" → "빅히트 뮤직"). */
export const managerName = (m: string | null) => (m ?? "").replace(/\s*—.*$/, "");
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
