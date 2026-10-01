import type { Clock } from "../platform/clock.ts";
import { DomainError } from "../platform/errors.ts";
import { fakeProvider, type FakeOutcome } from "../payout/fake-provider.ts";
import type { PayoutProvider } from "../payout/provider.ts";

export type DevOutcome = "PAID" | "FAILED" | "UNKNOWN";
export const DEV_OUTCOMES: readonly DevOutcome[] = ["PAID", "FAILED", "UNKNOWN"];
export type DevPspRequest = { at: string; op: "submit" | "status"; instructionId: string; key: string; result: string };
export type DevPsp = {
  /** 서버에 주입하는 지급 사업자. */
  provider: PayoutProvider;
  /** 그 지시의 첫 submit 전에만 의미 있다(가짜 PSP는 키의 결과를 첫 submit에 정한다). */
  setOutcome(instructionId: string, o: DevOutcome): void;
  /** 그 권리자의 이후 지시들. 지시별 지정이 우선한다. */
  setPartyOutcome(partyId: string, o: DevOutcome): void;
  outcomes(): { byInstruction: Record<string, DevOutcome>; byParty: Record<string, DevOutcome> };
  requests(): DevPspRequest[];
  webhookFor(instructionId: string): { providerEventId: string; providerRef: string; status: "PAID" | "FAILED" };
  reset(): void;
};

const KEY_PREFIX = "payout:";
const toFake = (o: DevOutcome): FakeOutcome => (o === "UNKNOWN" ? "UNKNOWN_THEN_PAID" : o);

/**
 * 개발용 PSP 시뮬레이터(통합 설계 12.2-5). 결정적 가짜 PSP를 감싸 지시별·권리자별 결과를 화면에서 정하고, 서버가 PSP에 보낸 요청을 기록한다.
 * 결과 규칙: 지시별 지정 → 권리자별 지정 → 기본 PAID.
 */
export function createDevPsp(clock: Clock): DevPsp {
  const byInstruction = new Map<string, DevOutcome>();
  const byParty = new Map<string, DevOutcome>();
  const MAX_LOG = 500; // 요청 기록은 마지막 500건만 남긴다.
  let log: DevPspRequest[] = [];
  let fake = newFake();
  function newFake() {
    return fakeProvider({ outcome: (i) => toFake(byInstruction.get(i.instructionId) ?? byParty.get(i.partyId) ?? "PAID") });
  }
  const instructionOf = (key: string) => (key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : key);
  const record = (op: "submit" | "status", key: string, result: string) => { log.push({ at: clock.now(), op, instructionId: instructionOf(key), key, result }); if (log.length > MAX_LOG) log = log.slice(-MAX_LOG); };
  const provider: PayoutProvider = {
    async submit(i, key) {
      try {
        const r = await fake.submit(i, key);
        record("submit", key, r.status);
        return r;
      } catch (e) {
        record("submit", key, `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
    async status(ref, key) {
      try {
        const r = await fake.status(ref, key);
        record("status", key, r.status);
        return r;
      } catch (e) {
        record("status", key, `ERROR: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    },
  };
  return {
    // fake를 reset()이 바꿔 끼우므로 위임 객체를 노출한다.
    provider,
    setOutcome: (id, o) => { byInstruction.set(id, o); },
    setPartyOutcome: (id, o) => { byParty.set(id, o); },
    outcomes: () => ({ byInstruction: Object.fromEntries(byInstruction), byParty: Object.fromEntries(byParty) }),
    requests: () => [...log],
    webhookFor(instructionId) {
      try {
        return fake.webhook(KEY_PREFIX + instructionId);
      } catch {
        throw new DomainError("NOT_SUBMITTED", 409, `instruction ${instructionId} has not been sent to the PSP yet`);
      }
    },
    reset() {
      byInstruction.clear();
      byParty.clear();
      log = [];
      fake = newFake();
    },
  };
}
