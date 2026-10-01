import { api } from "./client.ts";

/** 등록 POST는 모두 현재 사용자(x-actor)로 보낸다. 본문 필드는 rights-core registry/service.ts의 입력 타입과 같다. */
export const post = (path: string, body: unknown) => api<Record<string, unknown>>("POST", path, body);

export const PARTY_TYPES = ["LABEL", "AGENCY", "PUBLISHER", "CMO", "AUTHOR", "ARTIST", "MEMBER", "SESSION", "AI_PROVIDER", "FAN", "PLATFORM"] as const;
export const CLAIM_EDGES = ["PERFORMED_BY", "OWNED_BY", "CONTROLLED_BY", "WRITTEN_BY", "CONTRIBUTED_BY"] as const;
export const RECORD_STATUSES = ["ASSERTED", "VERIFIED", "DISPUTED", "SUPERSEDED"] as const;
export const VISIBILITIES = ["PUBLIC", "PARTIES", "PRIVATE"] as const;
export const RIGHT_KINDS = ["MASTER", "WORK", "PERFORMER"] as const;

export const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }));

/** 빈 문자열은 생략하고 나머지만 담는다. */
export function compact(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x !== undefined));
}

export function int(s: string | undefined): number {
  return Number(s);
}

/** datetime-local 값("2026-01-01T00:00:00")을 UTC ISO로. 빈 값은 빈 문자열. */
export function toIso(local: string | undefined): string {
  if (!local) return "";
  const t = /Z$|[+-]\d\d:\d\d$/.test(local) ? local : `${local}${local.length === 16 ? ":00" : ""}Z`;
  return t;
}
