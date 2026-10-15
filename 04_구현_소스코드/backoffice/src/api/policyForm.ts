/** 분배 규칙 폼(원천 문서 설계 S2). 코어 engine-bridge/policy-form.ts의 PolicyForm과 같은 모양이다. 비율은 bps(10000 = 100%). */
export type PolicyForm = {
  packId: string;
  events: ("PRIMARY" | "RESALE" | "TRAFFIC")[];
  tier1: { platformBps: number; opsBps: number; rightsBps: number };
  master: { bps: number };
  performer: { bps: number; mode: "HYBRID" | "USAGE_WEIGHTED" | "FIXED" | "MEMBER_PCT"; fixedBps?: number; usageBps?: number; featuredWeightBps?: number; capBps?: number; viaMandate: boolean };
  work: { bps: number; viaMandate: boolean };
  contracts: { name: string; partyId: string; bps: number; role: string }[];
};

export type Preview = {
  sourceText: string | null; form: PolicyForm | null; explanation: string[] | null; amountKrw: string;
  combination: { source: "ISSUED" | "DEFAULT"; vcId?: string; assignments: { slotId: string; stemId: string; partyId?: string }[]; members: Record<string, number> } | null;
  pools: { bucket: string; amount: string }[]; parties: { partyId: string; name: string; role: string; bucket: string; amount: string }[];
  holdings: { bucket: string; reason: string; amount: string }[]; diagnostics: { code: string; path: string; message: string }[];
};

export function defaultForm(packId: string): PolicyForm {
  return {
    packId, events: ["PRIMARY"], tier1: { platformBps: 2500, opsBps: 500, rightsBps: 7000 }, master: { bps: 4000 },
    performer: { bps: 4500, mode: "HYBRID", fixedBps: 4000, usageBps: 6000, featuredWeightBps: 7000, capBps: 5000, viaMandate: true },
    work: { bps: 1500, viaMandate: false }, contracts: [],
  };
}

export const pct = (bps: number | undefined) => (bps === undefined ? "없음" : `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`);
export const toBps = (percent: string) => Math.round(Number(percent) * 100);
const MODE: Record<string, string> = { HYBRID: "고정 + 시간 비례", USAGE_WEIGHTED: "부른 시간 비례", FIXED: "참여 멤버 균등", MEMBER_PCT: "팬이 정한 멤버 비율" };
const EVENT: Record<string, string> = { PRIMARY: "구매", RESALE: "재판매", TRAFFIC: "감상" };

/** 두 폼의 차이를 사람이 읽는 항목으로(예: "실연 1인 상한: 60% → 50%"). 버전 비교에 쓴다. */
export function formDiff(a: PolicyForm, b: PolicyForm): { label: string; before: string; after: string }[] {
  const rows: [string, string, string][] = [
    ["대상 매출", a.events.map((e) => EVENT[e] ?? e).join("·"), b.events.map((e) => EVENT[e] ?? e).join("·")],
    ["1차 플랫폼", pct(a.tier1.platformBps), pct(b.tier1.platformBps)],
    ["1차 운영", pct(a.tier1.opsBps), pct(b.tier1.opsBps)],
    ["1차 권리자", pct(a.tier1.rightsBps), pct(b.tier1.rightsBps)],
    ["2차 녹음", pct(a.master.bps), pct(b.master.bps)],
    ["2차 실연", pct(a.performer.bps), pct(b.performer.bps)],
    ["2차 작품", pct(a.work.bps), pct(b.work.bps)],
    ["실연 나누는 방식", MODE[a.performer.mode] ?? a.performer.mode, MODE[b.performer.mode] ?? b.performer.mode],
    ["실연 고정분", pct(a.performer.fixedBps), pct(b.performer.fixedBps)],
    ["실연 시간 비례분", pct(a.performer.usageBps), pct(b.performer.usageBps)],
    ["주실연 가중", pct(a.performer.featuredWeightBps), pct(b.performer.featuredWeightBps)],
    ["실연 1인 상한", pct(a.performer.capBps), pct(b.performer.capBps)],
    ["실연 몫 위임 수령", a.performer.viaMandate ? "예" : "아니오", b.performer.viaMandate ? "예" : "아니오"],
    ["작품 몫 위임 수령", a.work.viaMandate ? "예" : "아니오", b.work.viaMandate ? "예" : "아니오"],
    ["계약 몫", a.contracts.map((c) => `${c.partyId} ${pct(c.bps)}`).join(", ") || "없음", b.contracts.map((c) => `${c.partyId} ${pct(c.bps)}`).join(", ") || "없음"],
  ];
  return rows.filter(([, x, y]) => x !== y).map(([label, before, after]) => ({ label, before, after }));
}
