import { evaluate, validateAllocation, type AllocationDocument, type VectorExpr } from "mdrl/allocation";
import { digestOf } from "mdrl/core";
import { projectToIr, validateFacts } from "mdrl/facts";
import { parseAllocation } from "mdrl/text";
import type { Tx } from "../platform/db.ts";
import type { Diagnostic } from "../platform/errors.ts";
import { buildFactsDocument } from "./convert-facts.ts";
import { loadFactsRows } from "./facts.ts";
import { membersIr } from "./issue.ts";

/**
 * 분배 규칙 폼(원천 문서 설계 S2). 권리자가 MDRL 없이 정책을 만든다. 폼 → MDRL 텍스트를 만들어 컴파일하고,
 * 기존 텍스트가 이 폼으로 표현되면 폼으로 되돌린다(아니면 "고급 모드로 작성된 정책"). 금액 비율은 모두 bps(정수, 10000 = 100%)다.
 */
export type PolicyForm = {
  packId: string;
  events: ("PRIMARY" | "RESALE" | "TRAFFIC")[];
  tier1: { platformBps: number; opsBps: number; rightsBps: number };
  master: { bps: number };
  performer: {
    bps: number; mode: "HYBRID" | "USAGE_WEIGHTED" | "FIXED" | "MEMBER_PCT";
    fixedBps?: number; usageBps?: number; featuredWeightBps?: number; capBps?: number; viaMandate: boolean;
  };
  work: { bps: number; viaMandate: boolean };
  /** 계약으로 정한 몫(예: 소속사 고정 10%). */
  contracts: { name: string; partyId: string; bps: number; role: string }[];
};

const ID = /^[A-Za-z_][A-Za-z0-9_]*(?:[.-][A-Za-z0-9_]+)*$/;
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** 폼 모양·합계 검사. 진단 목록(비어 있으면 통과). 엔진 검증(컴파일·미리보기)이 마지막 방어선이고, 이것은 입력 단계에서 바로 알려 주는 검사다. */
export function checkForm(f: PolicyForm): Diagnostic[] {
  const out: Diagnostic[] = [];
  const d = (path: string, message: string) => out.push({ code: "FORM_INVALID", path, message });
  const isBps = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10000;
  if (typeof f.packId !== "string" || !ID.test(f.packId)) d("$.packId", "팩 id가 필요하다");
  if (!Array.isArray(f.events) || f.events.length === 0 || !f.events.every((e) => ["PRIMARY", "RESALE", "TRAFFIC"].includes(e))) d("$.events", "매출 종류를 하나 이상 고른다(구매·재판매·감상)");
  const t = f.tier1 ?? ({} as PolicyForm["tier1"]);
  for (const k of ["platformBps", "opsBps", "rightsBps"] as const) if (!isBps(t[k])) d(`$.tier1.${k}`, "0~100% 사이여야 한다");
  if (t.platformBps + t.opsBps + t.rightsBps !== 10000) d("$.tier1", `1차 분할 합이 ${pct(t.platformBps + t.opsBps + t.rightsBps)}다. 100%여야 한다`);
  if (!(t.rightsBps > 0)) d("$.tier1.rightsBps", "권리자 몫은 0보다 커야 한다");
  const parts = [f.master?.bps, f.performer?.bps, f.work?.bps, ...(f.contracts ?? []).map((c) => c.bps)];
  if (!parts.every(isBps)) d("$.tier2", "2차 분할 비율은 0~100% 사이여야 한다");
  else if (parts.reduce((a, b) => a + b, 0) !== 10000) d("$.tier2", `2차 분할 합이 ${pct(parts.reduce((a, b) => a + b, 0))}다. 100%여야 한다`);
  const p = f.performer;
  if (p !== undefined && p.bps > 0) {
    if (!["HYBRID", "USAGE_WEIGHTED", "FIXED", "MEMBER_PCT"].includes(p.mode)) d("$.performer.mode", "실연 몫 나누는 방식을 고른다");
    if (p.mode === "HYBRID" && (p.fixedBps ?? 0) + (p.usageBps ?? 0) !== 10000) d("$.performer", "고정분과 시간 비례분의 합이 100%여야 한다");
    for (const k of ["fixedBps", "usageBps", "featuredWeightBps", "capBps"] as const) if (p[k] !== undefined && !isBps(p[k])) d(`$.performer.${k}`, "0~100% 사이여야 한다");
    if (p.capBps !== undefined && p.capBps === 0) d("$.performer.capBps", "1인 상한은 0보다 커야 한다");
  }
  for (const [i, c] of (f.contracts ?? []).entries()) {
    if (!ID.test(c.name) || ["master", "performer", "work"].includes(c.name)) d(`$.contracts[${i}].name`, "버킷 이름은 영문 식별자이고 master·performer·work와 겹치지 않아야 한다");
    if (!ID.test(c.partyId)) d(`$.contracts[${i}].partyId`, "파티 id가 필요하다");
    if (!ID.test(c.role)) d(`$.contracts[${i}].role`, "역할(예: AGENCY)이 필요하다");
  }
  return out;
}

/** 폼 → MDRL 텍스트(정책 id·버전은 컴파일 때 레지스트리 값으로 다시 고정된다). */
export function formToText(f: PolicyForm, policyId: string, version = 1): string {
  const p = f.performer;
  const poolArgs = [p.mode, ...(p.fixedBps !== undefined ? [`fixed: ${pct(p.fixedBps)}`] : []), ...(p.usageBps !== undefined ? [`usage: ${pct(p.usageBps)}`] : []),
    ...(p.featuredWeightBps !== undefined ? [`featured_weight: ${pct(p.featuredWeightBps)}`] : [])].join(", ");
  const split = [
    ...(f.master.bps > 0 ? [`      master = graph(MASTER_OWNER) : ${pct(f.master.bps)};`] : []),
    ...(p.bps > 0 ? [`      performer = performance_pool(${poolArgs})${p.capBps !== undefined ? ` |> cap(${pct(p.capBps)})` : ""}${p.viaMandate ? " via mandate" : ""} : ${pct(p.bps)};`] : []),
    ...(f.work.bps > 0 ? [`      work = graph(WORK_AUTHOR)${f.work.viaMandate ? " via mandate" : ""} : ${pct(f.work.bps)};`] : []),
    ...f.contracts.filter((c) => c.bps > 0).map((c) => `      ${c.name} = contract(${c.partyId}) : ${pct(c.bps)} as ${c.role};`),
  ];
  const tier1 = [["platform", f.tier1.platformBps], ["ops", f.tier1.opsBps], ["rights", f.tier1.rightsBps]].filter(([, v]) => (v as number) > 0)
    .map(([k, v]) => `    ${k} = ${pct(v as number)};`);
  return [
    `allocation "${policyId}" version ${version} {`,
    `  scope { pack: ${f.packId}; events: [${f.events.join(", ")}]; currency: KRW; }`,
    "  bind { time: ISSUE_TIME; }",
    "  tier1 {", ...tier1, "  }",
    "  tier2 rights {", "    split {", ...split, "    }", "  }",
    "  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }",
    "}", "",
  ].join("\n");
}

/** MDRL 텍스트 → 폼. 이 폼이 표현하지 못하는 구조(다른 버킷 이름, mix·floor_guarantee 등)면 form 없이 이유를 돌려준다. */
export function textToForm(text: string): { form: PolicyForm } | { form: null; reason: string; diagnostics?: Diagnostic[] } {
  const parsed = parseAllocation(text);
  if (!parsed.ok) return { form: null, reason: "MDRL 텍스트를 읽을 수 없다", diagnostics: [...parsed.errors] };
  const b = parsed.value.body;
  const no = (reason: string) => ({ form: null as null, reason });
  if (b.bind.time !== "ISSUE_TIME") return no(`발행 시점 고정이 아닌 정책(${b.bind.time})`);
  if (b.tier1.rights !== "rights") return no(`권리자 풀 이름이 rights가 아니다(${b.tier1.rights})`);
  const t1 = Object.fromEntries(b.tier1.buckets.map((x) => [x.name, Number(x.bps)]));
  if (Object.keys(t1).some((k) => !["platform", "ops", "rights"].includes(k))) return no("1차 분할에 platform·ops·rights 밖의 버킷이 있다");
  const form: PolicyForm = {
    packId: b.scope.pack, events: [...b.scope.events] as PolicyForm["events"],
    tier1: { platformBps: t1.platform ?? 0, opsBps: t1.ops ?? 0, rightsBps: t1.rights ?? 0 },
    master: { bps: 0 }, performer: { bps: 0, mode: "HYBRID", viaMandate: false }, work: { bps: 0, viaMandate: false }, contracts: [],
  };
  for (const s of b.tier2.split) {
    const v = s.vector;
    if (s.name === "master" && v.fn === "graph" && v.role === "MASTER_OWNER" && !v.via_mandate && !s.via_mandate) form.master = { bps: Number(s.bps) };
    else if (s.name === "work" && v.fn === "graph" && v.role === "WORK_AUTHOR" && !s.via_mandate) form.work = { bps: Number(s.bps), viaMandate: v.via_mandate === true };
    else if (s.name === "performer") {
      const inner: VectorExpr = v.fn === "cap" ? v.of : v;
      if (inner.fn !== "performance_pool") return no("실연 버킷이 performance_pool이 아니다");
      form.performer = {
        bps: Number(s.bps), mode: inner.mode as PolicyForm["performer"]["mode"], viaMandate: s.via_mandate === true,
        ...(inner.fixed !== undefined && { fixedBps: Number(inner.fixed) }), ...(inner.usage !== undefined && { usageBps: Number(inner.usage) }),
        ...(inner.featured_weight !== undefined && { featuredWeightBps: Number(inner.featured_weight) }), ...(v.fn === "cap" && { capBps: Number(v.max) }),
      };
    } else if (v.fn === "contract" && !s.via_mandate) form.contracts.push({ name: s.name, partyId: v.party, bps: Number(s.bps), role: s.role });
    else return no(`폼으로 나타낼 수 없는 버킷: ${s.name}`);
  }
  return { form };
}

const MODE: Record<string, string> = {
  HYBRID: "참여 멤버에게 똑같이 나누는 고정분과 부른 시간에 비례하는 몫을 섞는다", USAGE_WEIGHTED: "부른 시간에 비례해 나눈다",
  FIXED: "참여 멤버에게 똑같이 나눈다", MEMBER_PCT: "팬이 정한 멤버 비율대로 나눈다",
};
const EVENT: Record<string, string> = { PRIMARY: "구매", RESALE: "재판매", TRAFFIC: "감상" };

/** 쉬운 말 설명. names는 파티 표시 이름(없으면 id). */
export function explainForm(f: PolicyForm, names: Record<string, string> = {}): string[] {
  const p = f.performer;
  const out = [
    `대상 매출: ${f.events.map((e) => EVENT[e] ?? e).join("·")}.`,
    `매출의 ${pct(f.tier1.rightsBps)}는 권리자 몫이고, 플랫폼 ${pct(f.tier1.platformBps)}, 운영 ${pct(f.tier1.opsBps)}이다.`,
  ];
  const parts: string[] = [];
  if (f.master.bps > 0) parts.push(`${pct(f.master.bps)}는 녹음 권리자에게`);
  if (p.bps > 0) parts.push(`${pct(p.bps)}는 그 조합을 부른 멤버에게`);
  if (f.work.bps > 0) parts.push(`${pct(f.work.bps)}는 작품 권리자에게 지분대로`);
  for (const c of f.contracts.filter((x) => x.bps > 0)) parts.push(`${pct(c.bps)}는 계약에 따라 ${names[c.partyId] ?? c.partyId}에게`);
  out.push(`권리자 몫 중 ${parts.join(", ")} 간다.`);
  if (p.bps > 0) {
    const detail = p.mode === "HYBRID" && p.fixedBps !== undefined && p.usageBps !== undefined
      ? `${pct(p.fixedBps)}는 참여 멤버에게 똑같이, ${pct(p.usageBps)}는 부른 시간에 비례해 나눈다` : MODE[p.mode] ?? p.mode;
    out.push(`실연 몫은 ${detail}.${p.featuredWeightBps !== undefined ? ` 주실연과 부실연이 섞이면 주실연 쪽에 ${pct(p.featuredWeightBps)}를 준다.` : ""}${p.capBps !== undefined ? ` 한 사람은 실연 몫의 ${pct(p.capBps)}를 넘지 못하고, 넘친 몫은 다른 멤버에게 다시 나뉜다.` : ""}`);
    if (p.viaMandate) out.push("소속사 등에 실연 수익 수령을 위임한 멤버의 몫은 위임받은 쪽이 받는다.");
  }
  if (f.work.bps > 0 && f.work.viaMandate) out.push("작품 몫은 작가가 위임한 곳(예: 신탁단체)이 받는다.");
  out.push("원 단위 끝수는 최대잉여법으로 정리해 합계가 정확히 맞는다.");
  return out;
}

/**
 * 예시 계산(봉인 없음): 지금의 권리 기록으로 facts를 만들고, 주어진 정책 텍스트와 대표 조합(사용량·멤버 비율)으로 매출 한 건을 평가한다.
 * 정책·facts가 엔진 검증을 통과하지 못하면 진단을 돌려준다. 결과는 어디에도 쓰지 않는다.
 */
export async function previewAllocation(
  tx: Tx, input: { scopeId: string; sourceText: string; knownAt: string; usageMs: Record<string, number>; members: Record<string, number>; amountKrw: string; eventType: string },
): Promise<{ ok: true; pools: { bucket: string; amount: string }[]; lines: { party: string; role: string; bucket: string; amount: string }[]; holdings: { bucket: string; reason: string; amount: string }[] } | { ok: false; diagnostics: Diagnostic[] }> {
  const facts = buildFactsDocument(await loadFactsRows(tx, input.scopeId, input.knownAt), input.knownAt);
  const fErr = validateFacts(facts);
  if (fErr.length > 0) return { ok: false, diagnostics: [...fErr] };
  const parsed = parseAllocation(input.sourceText);
  if (!parsed.ok) return { ok: false, diagnostics: [...parsed.errors] };
  const policy: AllocationDocument = { ...parsed.value, depends_on: [{ ref: `vc:facts/${facts.id}@${facts.version}`, digest: digestOf(facts) }] };
  const pErr = validateAllocation(policy);
  if (pErr.length > 0) return { ok: false, diagnostics: [...pErr] };
  const usage = Object.fromEntries(Object.entries(input.usageMs).map(([k, v]) => [k, String(v)]));
  const projection = projectToIr(facts, usage, input.knownAt, input.knownAt);
  if (!projection.ok) return { ok: false, diagnostics: [...projection.errors] };
  const r = evaluate({
    policy, facts, projection: projection.value, snapshot: membersIr(input.members), runId: "preview",
    events: [{ id: "preview", type: input.eventType as never, amount: input.amountKrw, currency: "KRW", integrity: "CLEAR" }],
  });
  if (!r.ok) return { ok: false, diagnostics: [...r.errors] };
  return {
    ok: true,
    pools: r.value.pool_lines.map((p) => ({ bucket: p.bucket, amount: p.amount })),
    lines: r.value.lines.map((l) => ({ party: l.party, role: l.role, bucket: l.bucket, amount: l.amount })),
    holdings: r.value.holdings.map((h) => ({ bucket: h.bucket, reason: h.reason, amount: h.amount })),
  };
}
