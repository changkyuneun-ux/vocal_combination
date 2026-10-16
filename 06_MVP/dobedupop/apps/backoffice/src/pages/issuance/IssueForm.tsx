import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Diagnostics } from "../../components/Diagnostics.tsx";
import { useAction, useGet } from "../../api/hooks.ts";
import { issue } from "../../api/issuance.ts";
import type { IssueBody, IssueSeal, PackDetailData, ScopeFacts, Stem } from "../../api/types.ts";
import { autoMemberBps, sumBps } from "./members.ts";

const stemLabel = (s: Stem) => `${s.stemId}${s.performerPartyId ? ` · ${s.performerPartyId}` : ""}${s.rightsBearing ? "" : " · 권리 대상 아님"}`;
/** 스템 id 요약: stm_a_slt_1 → a1, stm_mr → mr */
const brief = (id: string) => id.replace(/^stm_/, "").replace(/_?slt_/, "");

export function IssueForm({ pack }: { pack: PackDetailData }) {
  const facts = useGet<ScopeFacts>(["facts", pack.factsScopeId], `/scopes/${encodeURIComponent(pack.factsScopeId)}/facts`);
  const [stemBySlot, setStemBySlot] = useState<Record<string, string>>({});
  const [manual, setManual] = useState<{ key: string; values: Record<string, string> } | null>(null);
  const [vcEdit, setVcEdit] = useState<string | null>(null);
  const m = useAction<IssueBody, IssueSeal>(issue, ["issues"]);

  const slots = facts.data?.slots ?? [];
  const stems = facts.data?.stems ?? [];
  const byId = useMemo(() => new Map(stems.map((s) => [s.stemId, s])), [stems]);
  const picked = slots.filter((s) => stemBySlot[s.slotId]).map((s) => ({ slotId: s.slotId, stemId: stemBySlot[s.slotId]! }));
  const auto = autoMemberBps(picked.map((a) => { const s = byId.get(a.stemId); return s?.rightsBearing ? s.performerPartyId : null; }));
  const autoKey = JSON.stringify(auto);
  const shown: Record<string, string> = manual && manual.key === autoKey ? manual.values : Object.fromEntries(Object.entries(auto).map(([k, v]) => [k, String(v)]));
  const parties = Object.keys(auto).sort();
  const parsed = Object.fromEntries(parties.map((p) => [p, (shown[p] ?? "").trim() === "" ? NaN : Number(shown[p])]));
  const valid = parties.every((p) => Number.isInteger(parsed[p]) && parsed[p]! >= 0 && parsed[p]! <= 10000);
  const total = valid ? sumBps(parsed) : NaN;
  const vcId = vcEdit ?? `vc_${picked.map((a) => brief(a.stemId)).join("")}`;
  const canIssue = picked.length > 0 && parties.length > 0 && total === 10000 && vcId.trim() !== "" && !m.isPending;

  const submit = () => m.mutate({ packId: pack.packId, vcId: vcId.trim(), assignments: picked, members: parsed });
  return (
    <div className="stack">
      <p className="muted">발행 담당(usr_issuer)이 발행합니다. 팩이 활성 상태여야 합니다.</p>
      <ErrorPanel error={facts.error} />
      <fieldset className="stack">
        <legend>슬롯별 스템</legend>
        {slots.map((sl) => (
          <label key={sl.slotId} className="field"><span>{sl.slotId} 스템</span>
            <select value={stemBySlot[sl.slotId] ?? ""} onChange={(e) => setStemBySlot((s) => ({ ...s, [sl.slotId]: e.target.value }))}>
              <option value="">선택…</option>
              {stems.filter((s) => s.slotId === sl.slotId).map((s) => <option key={s.stemId} value={s.stemId}>{stemLabel(s)}</option>)}
            </select>
          </label>
        ))}
      </fieldset>
      <section className="stack" aria-label="멤버 비율">
        <h3>멤버 비율(bps)</h3>
        {parties.length === 0 ? <p className="muted">권리 대상 스템을 고르면 실연자별 비율이 채워집니다.</p> : (
          <table className="data">
            <thead><tr><th scope="col">멤버(party id)</th><th scope="col">bps</th></tr></thead>
            <tbody>
              {parties.map((p) => (
                <tr key={p}><td>{p}</td>
                  <td><input type="number" aria-label={`${p} bps`} value={shown[p] ?? ""} min={0} max={10000}
                    onChange={(e) => setManual({ key: autoKey, values: { ...shown, [p]: e.target.value } })} /></td></tr>
              ))}
            </tbody>
          </table>
        )}
        <p className={total === 10000 || parties.length === 0 ? "muted" : "bad"} role="status">합계 {Number.isNaN(total) ? "—" : total} / 10000</p>
      </section>
      <label className="field"><span>조합(vcId)</span><input value={vcId} onChange={(e) => setVcEdit(e.target.value)} /></label>
      <div><button type="button" className="btn primary" disabled={!canIssue} onClick={submit}>발행</button></div>
      {m.isSuccess && (
        <p className="muted" role="status">발행했습니다: <Link to={`/issues/${encodeURIComponent(m.data.snapshotId)}`}>{m.data.snapshotId}</Link></p>
      )}
      <ErrorPanel error={m.error} />
      <Diagnostics error={m.error} />
    </div>
  );
}
