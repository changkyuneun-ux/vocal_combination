import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { useList } from "../../api/hooks.ts";
import type { PolicyRow } from "../../api/types.ts";

export function Policies() {
  const [pack, setPack] = useState("");
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const nav = useNavigate();
  const list = useList<PolicyRow>("policies", "/policies", { pack });
  return (
    <Section title="정책 목록" actions={<button type="button" className="btn primary" onClick={() => setCreating((v) => !v)}>새 정책</button>}>
      {creating && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (newId.trim()) nav(`/policy/${encodeURIComponent(newId.trim())}`); }}>
          <label className="field"><span>새 정책 id</span><input value={newId} onChange={(e) => setNewId(e.target.value)} required /></label>
          <button type="submit" className="btn">편집기 열기</button>
        </form>
      )}
      <label className="field"><span>팩 필터</span><input value={pack} onChange={(e) => setPack(e.target.value)} placeholder="pak_nova_summer" /></label>
      <ErrorPanel error={list.error} />
      <DataTable<PolicyRow> rows={list.pages} empty="정책이 없습니다."
        columns={[
          { key: "policyId", label: "정책 id", render: (r) => <Link to={`/policy/${encodeURIComponent(r.policyId)}`}>{r.policyId}</Link> },
          { key: "packId", label: "팩" }, { key: "latestVersion", label: "최신 버전" },
          { key: "activeVersion", label: "활성 버전", render: (r) => r.activeVersion ?? "—" },
        ]} />
      <Pager next={list.next} loadMore={list.loadMore} />
    </Section>
  );
}
