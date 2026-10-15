import { useGet } from "./hooks.ts";

export type DocumentVersion = {
  version: number; kind: string; title: string; parties: string[]; effectiveFrom: string | null; effectiveTo: string | null;
  sha256: string; byteSize: number; mime: string; origin: string; status: string; statusReason?: string; confidentiality: string;
  uploadedBy: string; uploadedAt: string; retentionUntil: string | null; disposedAt?: string;
};
export type DocumentSummary = DocumentVersion & { documentId: string; ownerTenantId: string };
export type DocumentDetail = { documentId: string; ownerTenantId: string; versions: (DocumentVersion & { records: { type: string; id: string; version: number }[] })[] };

export const DOCUMENT_KIND_LABEL: Record<string, string> = {
  MASTER_CONTRACT: "녹음 계약", PUBLISHING: "퍼블리싱(작품) 계약", PERFORMER_CONSENT: "실연 동의서", MANDATE: "위임·전속 계약", PLATFORM_CONTRACT: "플랫폼 계약", EVIDENCE: "기타 증빙",
};

/** 근거 문서 선택지: 거부·폐기되지 않은 최신 버전. 값은 "문서 id@버전". */
export function useDocumentOptions(): { value: string; label: string }[] {
  const q = useGet<DocumentSummary[]>(["documents"], "/documents");
  return (q.data ?? []).filter((d) => d.status !== "REJECTED" && d.disposedAt === undefined)
    .map((d) => ({ value: `${d.documentId}@${d.version}`, label: `${d.title} (${DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}, v${d.version})` }));
}

/** 폼 값 "문서 id@버전"을 근거 참조 배열로 바꾼다. 비어 있으면 undefined(근거 없음). */
export function toEvidence(v: string | undefined): { documentId: string; version: number }[] | undefined {
  if (v === undefined || v === "") return undefined;
  const at = v.lastIndexOf("@");
  return [{ documentId: v.slice(0, at), version: Number(v.slice(at + 1)) }];
}
