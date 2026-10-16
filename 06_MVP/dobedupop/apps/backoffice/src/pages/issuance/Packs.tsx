import { Link } from "react-router";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { useList } from "../../api/hooks.ts";
import type { PackRow } from "../../api/types.ts";

export function Packs() {
  const list = useList<PackRow>("packs", "/packs");
  return (
    <>
      <Section title="팩 목록">
        <ErrorPanel error={list.error} />
        <DataTable<PackRow> rows={list.pages} empty="팩이 없습니다."
          columns={[
            { key: "packId", label: "팩 id", render: (r) => <Link to={`/packs/${encodeURIComponent(r.packId)}`}>{r.packId}</Link> },
            { key: "packCode", label: "코드" }, { key: "title", label: "제목" }, { key: "factsScopeId", label: "범위" },
            { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
            { key: "createdAt", label: "생성(UTC)", render: (r) => <Instant iso={r.createdAt} /> },
          ]} />
        <Pager next={list.next} loadMore={list.loadMore} />
      </Section>
      <Section title="팩 생성">
        <p className="muted">권리 편집자(usr_editor)로 생성합니다.</p>
        <RegisterForm path="/packs" submitLabel="팩 생성" invalidate={["packs"]}
          fields={[
            { name: "packId", label: "팩 id", type: "text", required: true },
            { name: "packCode", label: "팩 코드", type: "text", required: true },
            { name: "title", label: "제목", type: "text", required: true },
            { name: "factsScopeId", label: "범위 id", type: "text", required: true },
          ]}
          toBody={(v) => ({ packId: v.packId, packCode: v.packCode, title: v.title, factsScopeId: v.factsScopeId })} />
      </Section>
    </>
  );
}
