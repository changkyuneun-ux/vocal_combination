/** 실연자 채널(/performer) 호출. 신원은 개발용 x-actor(운영은 본인 인증 기반 로그인 토큰으로 바꾼다). */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const KEY = "performer.user";
export const currentUser = (): string | null => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setUser = (id: string | null) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* 저장 못 해도 화면 상태로 동작 */ } };

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown, user = currentUser()): Promise<T> {
  const res = await fetch(`/api/performer${path}`, {
    method, headers: { ...(user ? { "x-actor": user } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const e = (json ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, e.code ?? `HTTP_${res.status}`, e.message ?? text);
  }
  return json as T;
}

export type Me = { userId: string; partyId: string; displayName: string; identityVerified: boolean; identityMethod?: string };
export type Voice = { voiceId: string; factsScopeId: string; workId: string; title: string; consent: "NONE" | "SIGNED" | "REVOKED" };
export type Consent = { consentId: string; factsScopeId: string; assetId: string; status: "SIGNED" | "REVOKED"; signedAt: string; revokedAt?: string; validTo: string; sourceContractUri?: string };
export type Usage = { snapshotId: string; vcId: string; packId: string; issuedAt: string; slotId: string; stemId: string; durationMs: number };
export type Statement = { partyId: string; from: string; to: string; opening: string; settled: string; reversed: string; holdReleased: string; payoutNet: string; closing: string };
export type Contributions = {
  total: string;
  items: { vcId: string; snapshotId: string; batchId: string; periodStart: string; periodEnd: string; events: number; contributionKrw: string; heldEvents: number }[];
};
export type Confirmation = { requestId: number; recordType: "CLAIM" | "MANDATE"; recordId: string; recordVersion: number; counterpartyId: string; requestedBy: string; dueAt: string; status: string; disputeId?: string };
export type Claim = { claimId: string; edge: string; sourceId: string; targetId: string; shareBps: number; status: string; title: string };
export type Objection = { disputeId: string; claimId: string; reason: string; status: string; openedAt: string; closedAt?: string };
export type Notice = { notificationId: number; kind: string; title: string; body: string; createdAt: string; read: boolean; pushed: boolean };
/** 표준 계약 서명 요청(원천 문서 설계 S4). */
export type ContractSummary = {
  contractId: string; title: string; status: "SENT" | "SIGNED" | "COMPLETED" | "CANCELLED"; createdAt: string;
  signatures: { partyId: string; displayName: string; signedAt?: string }[];
};
export type ContractDetail = ContractSummary & { html: string; sha256: string };
