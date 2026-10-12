import { useState } from "react";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { useList } from "../../api/hooks.ts";
import { PARTY_TYPES, compact, opts } from "../../api/registry.ts";
import type { Party } from "../../api/types.ts";

export function Parties() {
  const [type, setType] = useState("");
  const list = useList<Party>("parties", "/parties", { type });
  return (
    <>
      <Section title="당사자 목록">
        <label className="field"><span>종류 필터</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">전체</option>
            {PARTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <ErrorPanel error={list.error} />
        <DataTable<Party> rows={list.pages} empty="당사자가 없습니다."
          columns={[
            { key: "partyId", label: "당사자 id" }, { key: "partyType", label: "유형" }, { key: "displayName", label: "표시명" },
            { key: "isni", label: "ISNI", render: (r) => r.isni ?? "—" }, { key: "ipiNo", label: "IPI", render: (r) => r.ipiNo ?? "—" },
            { key: "createdAt", label: "등록", render: (r) => <Instant iso={r.createdAt} /> },
          ]} />
        <Pager next={list.next} loadMore={list.loadMore} />
      </Section>
      <Section title="당사자 등록">
        <RegisterForm path="/parties" submitLabel="권리자 등록" invalidate={["parties"]}
          fields={[
            { name: "partyId", label: "당사자 id", type: "text", required: true },
            { name: "partyType", label: "유형", type: "select", required: true, options: opts(PARTY_TYPES) },
            { name: "displayName", label: "표시명", type: "text", required: true },
            { name: "isni", label: "ISNI", type: "text" }, { name: "ipiNo", label: "IPI 번호", type: "text" },
          ]}
          toBody={(v) => compact(v)} />
      </Section>
    </>
  );
}
