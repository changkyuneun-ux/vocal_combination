/**
 * Dynamite 계약서 불러오기 예시(3부-B, 결정 CT1·CT2): 빅히트가 등록하는 계약 양식 읽기 틀 2종과, 사람이 원천 문서에 표시하는 조항 인용 문장.
 * 시안 Ops-Templates(읽기 틀 표)·Song-Import(후보 값 표)의 값이다. 시험·E2E·데모 시드가 같은 값을 쓴다.
 */
export const PUBLISHING_FRAME = {
  frameId: "frm_bighit_publishing", title: "빅히트 작품 퍼블리싱 계약 양식", documentKind: "PUBLISHING", pages: 4,
  fields: [
    { key: "title", label: "곡명", irItem: "WORK_TITLE", page: 1, clause: "제1조", pattern: "본 계약의 대상 저작물은 「{text}」" },
    { key: "author1", label: "작가 · 지분 1", irItem: "AUTHOR_SHARE", page: 2, clause: "제3조 1항", pattern: "작가 갑의 지분은 {percent}퍼센트", partyOrder: 1, roleDetail: "LYRICS_COMPOSITION" },
    { key: "author2", label: "작가 · 지분 2", irItem: "AUTHOR_SHARE", page: 2, clause: "제3조 2항", pattern: "작가 을의 지분은 {percent}퍼센트", partyOrder: 2, roleDetail: "LYRICS_COMPOSITION" },
    { key: "effectiveFrom", label: "효력 시작", irItem: "EFFECTIVE_FROM", page: 1, clause: "제2조", pattern: "{date}부터 효력" },
  ],
} as const;

export const MASTER_FRAME = {
  frameId: "frm_bighit_master", title: "빅히트 녹음 계약 양식", documentKind: "MASTER_CONTRACT", pages: 6,
  fields: [
    { key: "recording", label: "녹음", irItem: "RECORDING", page: 1, clause: "제1조", pattern: "대상 녹음은 「{text}」" },
    { key: "owner", label: "마스터 보유자", irItem: "MASTER_OWNER", page: 2, clause: "제4조", pattern: "마스터 권리는 {party}가 보유한다" },
    { key: "effectiveFrom", label: "효력 시작", irItem: "EFFECTIVE_FROM", page: 1, clause: "제2조", pattern: "{date}부터 효력" },
  ],
} as const;

/** 퍼블리싱 계약서(doc_dynamite_publishing v1)에 사람이 표시하는 조항(쪽·인용·종류). 길 A의 조항 표시와 같다. */
export const PUBLISHING_CLAUSES = [
  { page: 1, quote: "본 계약의 대상 저작물은 「Dynamite」", clauseType: "OTHER", note: "제1조" },
  { page: 1, quote: "2026년 1월 1일부터 효력", clauseType: "PERIOD", note: "제2조" },
  { page: 2, quote: "작가 갑의 지분은 50퍼센트", clauseType: "SHARE", note: "제3조 1항" },
  { page: 2, quote: "작가 을의 지분은 50퍼센트", clauseType: "SHARE", note: "제3조 2항" },
] as const;
