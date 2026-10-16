import { fakeProvider } from "./fake-provider.ts";

/**
 * 지급 사업자(PSP) 연동 인터페이스(통합 설계 11.2-7). 같은 멱등 키(payout:<instruction_id>)로 다시 보내도 PSP는 한 번만 지급한다.
 * ACCEPTED: 접수(결과는 나중에 status·webhook), PAID·FAILED: 끝 상태, UNKNOWN: 접수 여부 불명(새로 보내지 않고 status로 재조회).
 * 구현은 DB 트랜잭션 안에서 부르지 않는다(handlers.ts가 순서를 지킨다).
 */
export type ProviderResult = { status: "ACCEPTED" | "PAID" | "FAILED" | "UNKNOWN"; providerRef?: string; reason?: string };
export type PayoutProvider = {
  submit(i: { instructionId: string; partyId: string; accountRef: string; amountKrw: bigint }, idempotencyKey: string): Promise<ProviderResult>;
  /** providerRef를 아직 모르면(submit 결과 불명) 빈 문자열을 넘기고, 멱등 키로 조회한다. */
  status(providerRef: string, idempotencyKey: string): Promise<ProviderResult>;
};

/** RC_PSP 환경 변수로 어댑터를 고른다. 이 단계에는 가짜 어댑터만 있다: 비었거나 "fake"가 아니면 시작을 거부한다. */
export function providerFromEnv(env: Readonly<Record<string, string | undefined>>): PayoutProvider {
  const v = env.RC_PSP;
  if (v === undefined || v === "" || v === "fake") return fakeProvider();
  throw new Error(`RC_PSP must be "fake" or unset, got ${v}`);
}

/**
 * 운영(production) 진입점용: 가상 PSP로는 시작하지 않는다(MVP 진행계획 M2 — production은 가상 공급자 거부).
 * 실제 PSP 어댑터가 아직 없으므로 지금은 항상 거부한다. 어댑터가 생기면 여기서 고른다.
 */
export function productionProviderFromEnv(env: Readonly<Record<string, string | undefined>>): PayoutProvider {
  const v = env.RC_PSP;
  if (v === undefined || v === "" || v === "fake") throw new Error("PRODUCTION_REFUSES_FAKE: RC_PSP must name a real PSP adapter in production (none is implemented yet; run the demo profile instead)");
  throw new Error(`RC_PSP: unknown PSP adapter ${v}`);
}

/** 지급 멱등 키 형식(payout:<instruction_id>). 키를 만드는 모든 곳이 이 상수·함수를 쓴다. */
export const PAYOUT_KEY_PREFIX = "payout:";
export const payoutIdempotencyKey = (instructionId: string): string => `${PAYOUT_KEY_PREFIX}${instructionId}`;
