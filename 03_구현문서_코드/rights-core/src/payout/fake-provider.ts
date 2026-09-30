import type { PayoutProvider, ProviderResult } from "./provider.ts";

type Entry = { amount: bigint; accountRef: string; ref: string; submits: number };

/**
 * 결정적 가짜 PSP(통합 설계 11.2-7). 금액(실지급액) 규칙: 97의 배수 → FAILED, 89의 배수 → 첫 submit만 UNKNOWN(이후 submit은
 * ACCEPTED, status는 PAID), 그 밖 → ACCEPTED 후 status PAID. 같은 멱등 키는 같은 결과(97·89가 아니면 submit은 늘 같은 값).
 * 같은 키를 다른 금액·계좌로 다시 쓰면 거부한다(throw — 실제 PSP의 멱등 키 충돌). 제공자 참조는 키에서 정해진다. 호출 기록(calls)과 webhook 생성기를 테스트용으로 노출한다.
 */
export function fakeProvider(): PayoutProvider & {
  calls: { op: string; key: string }[];
  webhook(key: string): { providerEventId: string; providerRef: string; status: "PAID" | "FAILED" };
} {
  const calls: { op: string; key: string }[] = [];
  const byKey = new Map<string, Entry>();
  const final = (e: Entry): "PAID" | "FAILED" => (e.amount % 97n === 0n ? "FAILED" : "PAID");
  return {
    calls,
    async submit(i, key): Promise<ProviderResult> {
      calls.push({ op: "submit", key });
      let e = byKey.get(key);
      if (e === undefined) {
        e = { amount: i.amountKrw, accountRef: i.accountRef, ref: `fk_${key}`, submits: 0 };
        byKey.set(key, e);
      } else if (e.amount !== i.amountKrw || e.accountRef !== i.accountRef) {
        throw new Error(`fake provider: idempotency key ${key} reused with a different amount or account`);
      }
      e.submits++;
      if (final(e) === "FAILED") return { status: "FAILED", providerRef: e.ref, reason: "REJECTED_BY_FAKE" };
      if (e.amount % 89n === 0n && e.submits === 1) return { status: "UNKNOWN" };
      return { status: "ACCEPTED", providerRef: e.ref };
    },
    async status(_ref, key): Promise<ProviderResult> {
      calls.push({ op: "status", key });
      const e = byKey.get(key);
      if (e === undefined) return { status: "UNKNOWN" };
      return { status: final(e), providerRef: e.ref };
    },
    webhook(key) {
      const e = byKey.get(key);
      if (e === undefined) throw new Error(`fake provider: no payout submitted with key ${key}`);
      return { providerEventId: `evt_${key}`, providerRef: e.ref, status: final(e) };
    },
  };
}
