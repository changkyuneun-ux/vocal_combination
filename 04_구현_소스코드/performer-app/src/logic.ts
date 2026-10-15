import type { Consent, Voice } from "./api.ts";

/** 원 단위 금액 표시(정수 문자열 → "1,234원"). */
export function won(krw: string): string {
  const n = BigInt(krw);
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "−" : ""}${s}원`;
}

/** 명세 기간: 그 해 1월 1일부터 다음 해 1월 1일까지(UTC). */
export function yearPeriod(nowIso: string): { from: string; to: string } {
  const y = Number(nowIso.slice(0, 4));
  return { from: `${y}-01-01T00:00:00.000Z`, to: `${y + 1}-01-01T00:00:00.000Z` };
}

/** 이 보이스에서 철회할 수 있는 내 동의(서명 상태, 최근 것). 계약서로 옮겨 적은 동의도 본인이 철회할 수 있다. */
export function revocable(voice: Voice, consents: Consent[]): Consent | undefined {
  return consents.filter((c) => c.assetId === voice.voiceId && c.status === "SIGNED").sort((a, b) => (a.signedAt < b.signedAt ? 1 : -1))[0];
}

/** 새 동의 id: 보이스·시각으로 만든다(같은 순간 두 번 누르지 않는 한 겹치지 않는다). */
export function newConsentId(voiceId: string, nowMs: number): string {
  return `cst_app_${voiceId}_${nowMs.toString(36)}`;
}

export const KIND_LABEL: Record<string, string> = { USAGE: "사용", CONSENT: "동의", PAYOUT: "지급", OBJECTION: "이의제기", IDENTITY: "본인 인증" };
export const EDGE_LABEL: Record<string, string> = { OWNED_BY: "보이스 소유", PERFORMED_BY: "스템 실연" };
