import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Diagnostics } from "../../components/Diagnostics.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { useActor } from "../../app/actor.ts";
import { useAction, useGet } from "../../api/hooks.ts";
import { activatePack, CLAIMANT_ROLES, setClaimants, type Declared } from "../../api/issuance.ts";
import type { PackDetailData } from "../../api/types.ts";
import { IssueForm } from "./IssueForm.tsx";
import { IssueTable } from "./Issues.tsx";

const INV = ["pack", "packs"];

function ClaimantEditor({ packId, initial }: { packId: string; initial: Declared[] }) {
  const [rows, setRows] = useState<Declared[]>(initial);
  const save = useAction<Declared[], unknown>((e) => setClaimants(packId, e), INV);
  const set = (i: number, patch: Partial<Declared>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ok = rows.every((r) => r.party.trim() !== "" && r.role !== "");
  return (
    <div className="stack">
      <table className="data">
        <thead><tr><th scope="col">권리자 party id</th><th scope="col">역할</th><th scope="col">삭제</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input aria-label={`선언 ${i + 1} party id`} value={r.party} onChange={(e) => set(i, { party: e.target.value })} /></td>
              <td>
                <select aria-label={`선언 ${i + 1} 역할`} value={r.role} onChange={(e) => set(i, { role: e.target.value })}>
                  <option value="">선택…</option>
                  {CLAIMANT_ROLES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </td>
              <td><button type="button" className="btn tiny" aria-label={`선언 ${i + 1} 삭제`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>삭제</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, { party: "", role: "" }])}>선언 행 추가</button>
        <button type="button" className="btn primary" disabled={!ok || save.isPending} onClick={() => save.mutate(rows.map((r) => ({ role: r.role, party: r.party.trim() })))}>권리자 선언 저장</button>
      </div>
      {save.isSuccess && <p className="muted" role="status">저장했습니다</p>}
      <ErrorPanel error={save.error} />
    </div>
  );
}

export function PackDetail() {
  const { packId = "" } = useParams();
  const actor = useActor();
  const pack = useGet<PackDetailData>(["pack", packId], `/packs/${encodeURIComponent(packId)}`);
  const activate = useAction<void, unknown>(() => activatePack(packId), INV);
  const { reset } = activate;
  useEffect(() => { reset(); }, [actor, reset]);
  const p = pack.data;
  return (
    <>
      <Section title={`팩 ${packId}`} actions={
        <button type="button" className="btn primary" disabled={!p || p.status === "ACTIVE" || activate.isPending} onClick={() => activate.mutate()}>팩 활성화</button>
      }>
        <ErrorPanel error={pack.error} />
        {p && (
          <dl className="kv">
            <dt>코드</dt><dd>{p.packCode}</dd><dt>제목</dt><dd>{p.title}</dd><dt>범위</dt><dd>{p.factsScopeId}</dd>
            <dt>상태</dt><dd><StatusBadge status={p.status} /></dd>
            <dt>생성(UTC)</dt><dd><Instant iso={p.createdAt} /></dd>
            <dt>활성 정책</dt><dd>{p.activePolicy ? `${p.activePolicy.policyId}@${p.activePolicy.version}` : <span className="muted">없음 (정책을 먼저 활성화하세요)</span>}</dd>
          </dl>
        )}
        <p className="muted">팩 활성화는 활성화 담당(usr_activator)이 합니다.</p>
        <ErrorPanel error={activate.error} />
        <Diagnostics error={activate.error} />
      </Section>
      {p && (
        <>
          <Section title="권리자 선언 표">
            <DataTable rows={p.claimants} empty="선언된 권리자가 없습니다."
              columns={[{ key: "partyId", label: "권리자" }, { key: "claimantRole", label: "역할" }]} />
          </Section>
          <Section title="권리자 선언 편집">
            <p className="muted">권리 편집자(usr_editor)가 저장합니다. 활성 팩은 바꿀 수 없습니다.</p>
            <ClaimantEditor key={JSON.stringify(p.claimants)} packId={packId}
              initial={p.claimants.map((c) => ({ party: c.partyId, role: c.claimantRole }))} />
          </Section>
          <Section title="조합 발행">
            <IssueForm pack={p} />
          </Section>
          <Section title="발행 목록">
            <IssueTable pack={packId} />
          </Section>
        </>
      )}
    </>
  );
}
