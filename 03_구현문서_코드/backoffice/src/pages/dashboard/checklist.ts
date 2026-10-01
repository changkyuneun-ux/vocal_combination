/** 대시보드 "권장 검증 순서" 체크리스트 판정(순수 함수, 단위 테스트 대상). */

/** 한 데이터 원천의 읽기 결과: 값이거나, 읽기 실패(오류 문장). 실패를 완료로 세지 않는다. */
export type Fact<T> = { ok: true; value: T } | { ok: false; error: string };

export type Facts = {
  parties: Fact<number>;
  activePolicy: Fact<boolean>;
  activePacks: Fact<number>;
  issues: Fact<number>;
  purchases: Fact<number>;
  refunds: Fact<number>;
  confirmedBatches: Fact<number>;
  reversals: Fact<number>;
  releasedHolds: Fact<number>;
  profiles: Fact<number>;
  paidInstructions: Fact<number>;
  /** 점검 위반 수(0이면 정상). */
  invariantViolations: Fact<number>;
};

export type StepState = "done" | "todo" | "unknown";
export type StepResult = { no: number; label: string; to: string; state: StepState; error?: string };

export const STEPS: { no: number; label: string; to: string }[] = [
  { no: 1, label: "권리자 등록", to: "/registry/parties" },
  { no: 2, label: "정책 활성화", to: "/policy" },
  { no: 3, label: "팩 활성화", to: "/packs" },
  { no: 4, label: "조합 발행", to: "/issues" },
  { no: 5, label: "구매·환불 기록", to: "/revenue" },
  { no: 6, label: "배치 확정", to: "/settlement/batches" },
  { no: 7, label: "역분개 확인", to: "/ledger" },
  { no: 8, label: "보류 해제", to: "/settlement/holds" },
  { no: 9, label: "지급 프로필 등록", to: "/payout/profiles" },
  { no: 10, label: "지급 실행·PAID", to: "/payout/runs" },
  { no: 11, label: "점검 정상", to: "/statements" },
];

type Verdict = { state: StepState; error?: string };
const bad = (f: { ok: false; error: string }): Verdict => ({ state: "unknown", error: f.error });
const atLeastOne = (f: Fact<number>): Verdict => (!f.ok ? bad(f) : { state: f.value >= 1 ? "done" : "todo" });

/** 둘 다 1건 이상이어야 한다. 한쪽이 0건으로 확정이면 다른 쪽을 몰라도 미완료. */
function both(a: Fact<number>, b: Fact<number>): Verdict {
  if ((a.ok && a.value < 1) || (b.ok && b.value < 1)) return { state: "todo" };
  if (!a.ok) return bad(a);
  if (!b.ok) return bad(b);
  return { state: "done" };
}

export function judge(f: Facts): StepResult[] {
  const v: Verdict[] = [
    atLeastOne(f.parties),
    !f.activePolicy.ok ? bad(f.activePolicy) : { state: f.activePolicy.value ? "done" : "todo" },
    atLeastOne(f.activePacks),
    atLeastOne(f.issues),
    both(f.purchases, f.refunds),
    atLeastOne(f.confirmedBatches),
    atLeastOne(f.reversals),
    atLeastOne(f.releasedHolds),
    atLeastOne(f.profiles),
    atLeastOne(f.paidInstructions),
    !f.invariantViolations.ok ? bad(f.invariantViolations) : { state: f.invariantViolations.value === 0 ? "done" : "todo" },
  ];
  return STEPS.map((s, i) => ({ ...s, ...v[i]! }));
}

/** 목록 한 쪽의 건수 표시: 다음 쪽이 있으면 "200+". */
export function countLabel(p: { items: unknown[]; next: string | null }): string {
  return `${p.items.length}${p.next ? "+" : ""}`;
}
