import { checkForm, explainForm, formToText, previewAllocation, textToForm, type PolicyForm } from "../engine-bridge/policy-form.ts";
import { packRow, slotShareBps } from "../issuance/service.ts";
import { withSystemScope } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import { DomainError, invalid } from "../platform/errors.ts";

export type { PolicyForm };

/** 폼 → MDRL 텍스트. 폼 검사를 통과하지 못하면 422 FORM_INVALID(필드별 진단). */
export function textFromForm(form: PolicyForm, policyId = "pol_draft"): string {
  const diags = checkForm(form);
  if (diags.length > 0) throw invalid("FORM_INVALID", "policy form has problems", diags);
  return formToText(form, policyId);
}

export { textToForm };

/**
 * 대표 조합: 이 팩에서 가장 최근 발행된 조합(실제 배치·멤버 비율), 없으면 슬롯마다 첫 번째 정산 대상 스템을 고른 기본 조합(멤버 비율은 부른 슬롯 수 비례).
 * 곡 전체를 봐야 하므로 system 범위에서 읽는다(팩은 호출자가 먼저 요청자 범위에서 확인한다).
 */
async function representative(tx: Tx, packId: string, scopeId: string) {
  return withSystemScope(tx, async () => {
    const issued = (await tx.query("SELECT snapshot_id, vc_id FROM rights_snapshot WHERE pack_id = $1 ORDER BY created_at DESC, snapshot_id LIMIT 1", [packId])).rows[0];
    if (issued !== undefined) {
      const a = (await tx.query(
        `SELECT a.slot_id, a.part_no, a.stem_id, a.party_id, a.duration_ms, a.rights_bearing AND NOT EXISTS (SELECT 1 FROM slot_part p WHERE p.slot_id = a.slot_id AND p.part_no = a.part_no AND p.kind = 'GROUP') AS counted
           FROM snapshot_stem_assignment a WHERE a.snapshot_id = $1 ORDER BY a.slot_id, a.part_no`, [issued.snapshot_id])).rows;
      const m = (await tx.query("SELECT party_id, pct_bps FROM snapshot_member_pct WHERE snapshot_id = $1", [issued.snapshot_id])).rows;
      const usageMs: Record<string, number> = {};
      for (const r of a) if (r.counted) usageMs[r.stem_id] = (usageMs[r.stem_id] ?? 0) + (r.duration_ms as number);
      return {
        source: "ISSUED" as const, vcId: issued.vc_id as string, usageMs, members: Object.fromEntries(m.map((r) => [r.party_id as string, r.pct_bps as number])),
        assignments: a.map((r) => ({ slotId: r.slot_id as string, partNo: r.part_no as number, stemId: r.stem_id as string, partyId: (r.party_id ?? undefined) as string | undefined })),
      };
    }
    // 기본 조합: 슬롯·파트 순서대로, 지금까지 가장 적게 고른 실연자의 스템을 고른다(한 사람이 다 부르는 조합은 1인 상한에 걸리기 쉽다).
    // 사용 시간은 파트 길이(SL2). 그룹 파트는 사용 시간에 넣지 않으므로 후보가 아니다(SL7).
    const candidates = (await tx.query(
      `SELECT sl.slot_id, p.part_no, p.duration_ms, st.stem_id, st.performer_party_id
         FROM facts_scope f JOIN recording_version r ON r.work_id = f.work_id JOIN part_slot sl ON sl.recording_id = r.recording_id
         JOIN slot_part p ON p.slot_id = sl.slot_id AND p.kind <> 'GROUP'
         JOIN stem st ON st.slot_id = p.slot_id AND st.part_no = p.part_no AND st.rights_bearing AND st.performer_party_id IS NOT NULL
        WHERE f.facts_scope_id = $1 ORDER BY sl.sort_order, sl.slot_id, p.part_no, st.stem_id`, [scopeId])).rows;
    const picked = new Map<string, number>();
    const stems: typeof candidates = [];
    for (const key of [...new Set(candidates.map((c) => `${c.slot_id}#${c.part_no}`))]) {
      const options = candidates.filter((c) => `${c.slot_id}#${c.part_no}` === key);
      const best = options.reduce((a, c) => ((picked.get(c.performer_party_id) ?? 0) < (picked.get(a.performer_party_id) ?? 0) ? c : a));
      picked.set(best.performer_party_id, (picked.get(best.performer_party_id) ?? 0) + 1);
      stems.push(best);
    }
    if (stems.length === 0) throw invalid("NO_COMBINATION", "this song has no rights-bearing stems to build an example combination");
    return {
      source: "DEFAULT" as const, usageMs: Object.fromEntries(stems.map((s) => [s.stem_id as string, s.duration_ms as number])),
      members: slotShareBps(stems.map((s) => s.performer_party_id as string)),
      assignments: stems.map((s) => ({ slotId: s.slot_id as string, partNo: s.part_no as number, stemId: s.stem_id as string, partyId: s.performer_party_id as string })),
    };
  });
}

/**
 * 예시 계산(원천 문서 설계 S2): 폼 또는 MDRL 텍스트로 대표 조합의 매출 한 건이 누구에게 얼마 가는지 엔진으로 계산한다. 아무것도 봉인·저장하지 않는다.
 * 폼으로 나타낼 수 있는 정책이면 쉬운 말 설명도 붙인다.
 */
export async function previewPolicy(
  tx: Tx, clock: Clock, input: { packId?: unknown; form?: PolicyForm; sourceText?: unknown; amountKrw?: unknown; eventType?: unknown },
) {
  if (typeof input.packId !== "string") throw new DomainError("BAD_REQUEST", 400, "packId is required");
  const amountKrw = input.amountKrw === undefined ? "10000" : String(input.amountKrw);
  if (!/^[1-9][0-9]{0,12}$/.test(amountKrw)) throw new DomainError("BAD_REQUEST", 400, "amountKrw must be a positive integer");
  const eventType = (input.eventType ?? "PRIMARY") as string;
  const pack = await packRow(tx, input.packId);
  let sourceText: string;
  let form: PolicyForm | null;
  if (input.form !== undefined) {
    const diags = checkForm(input.form);
    if (diags.length > 0) return { sourceText: null, form: input.form, explanation: null, combination: null, pools: [], parties: [], holdings: [], diagnostics: diags };
    form = input.form;
    sourceText = formToText(form, "pol_preview");
  } else if (typeof input.sourceText === "string") {
    sourceText = input.sourceText;
    const back = textToForm(sourceText);
    form = back.form;
  } else throw new DomainError("BAD_REQUEST", 400, "form or sourceText is required");
  const combination = await representative(tx, input.packId, pack.factsScopeId);
  const r = await withSystemScope(tx, () => previewAllocation(tx, {
    scopeId: pack.factsScopeId, sourceText, knownAt: clock.now(), usageMs: combination.usageMs, members: combination.members, amountKrw, eventType,
  }));
  const ids = r.ok ? [...new Set([...r.lines.map((l) => l.party), ...(form?.contracts.map((c) => c.partyId) ?? [])])] : [];
  const names = Object.fromEntries((await withSystemScope(tx, async () => (await tx.query("SELECT party_id, display_name FROM party WHERE party_id = ANY($1)", [ids])).rows))
    .map((p) => [p.party_id as string, p.display_name as string]));
  const parties = new Map<string, { partyId: string; name: string; role: string; bucket: string; amount: bigint }>();
  if (r.ok) for (const l of r.lines) {
    const k = `${l.party}|${l.bucket}|${l.role}`;
    const cur = parties.get(k) ?? { partyId: l.party, name: names[l.party] ?? l.party, role: l.role, bucket: l.bucket, amount: 0n };
    cur.amount += BigInt(l.amount);
    parties.set(k, cur);
  }
  return {
    sourceText, form, explanation: form === null ? null : explainForm(form, names), amountKrw, eventType,
    combination: { source: combination.source, ...("vcId" in combination && { vcId: combination.vcId }), assignments: combination.assignments, members: combination.members },
    pools: r.ok ? r.pools : [],
    parties: [...parties.values()].sort((a, b) => (a.amount === b.amount ? (a.partyId < b.partyId ? -1 : 1) : a.amount > b.amount ? -1 : 1)).map((p) => ({ ...p, amount: p.amount.toString() })),
    holdings: r.ok ? r.holdings : [],
    diagnostics: r.ok ? [] : r.diagnostics,
  };
}
