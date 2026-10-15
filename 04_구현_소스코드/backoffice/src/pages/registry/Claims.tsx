import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { useGet } from "../../api/hooks.ts";
import { CLAIM_EDGES, RECORD_STATUSES, VISIBILITIES, compact, opts, toIso } from "../../api/registry.ts";
import type { ScopeFacts } from "../../api/types.ts";
import { toEvidence, useDocumentOptions } from "../../api/documents.ts";
import { currentApp } from "../../app/apps.ts";

export function Claims() {
  const [scope, setScope] = useScopeParam();
  const docs = useDocumentOptions();
  const facts = useGet<ScopeFacts>(["facts", scope], `/scopes/${encodeURIComponent(scope)}/facts`, { enabled: scope !== "" });
  return (
    <>
      <Section title="범위 선택">
        <ScopeSelect scope={scope} onChange={setScope} />
        {scope !== "" && <ErrorPanel error={facts.error} />}
      </Section>
      {scope !== "" && (
        <>
          <Section title="권리 주장 표">
            <DataTable rows={facts.data?.claims ?? []} empty="권리 주장이 없습니다."
              columns={[
                { key: "claimId", label: "주장 id" }, { key: "version", label: "버전" }, { key: "sourceId", label: "원천" }, { key: "edge", label: "관계" },
                { key: "targetId", label: "대상" }, { key: "shareBps", label: "지분(bps)" }, { key: "performerRole", label: "역할", render: (r) => r.performerRole ?? "—" },
                { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
                { key: "validFrom", label: "유효 시작(UTC)", render: (r) => <Instant iso={r.validFrom} /> },
                { key: "supersededAt", label: "대체됨", render: (r) => <Instant iso={r.supersededAt} /> },
              ]} />
          </Section>
          <Section title="권리 주장 등록">
            <RegisterForm path="/claims" submitLabel="권리 등록" invalidate={["facts", "scope", "disputes"]} key={`claim-${scope}`}
              fields={[
                { name: "claimId", label: "주장 id", type: "text", required: true },
                { name: "factsScopeId", label: "범위 id", type: "text", required: true, initial: scope },
                { name: "sourceId", label: "원천 id", type: "text", required: true },
                { name: "edge", label: "관계", type: "select", required: true, options: opts(CLAIM_EDGES) },
                { name: "targetId", label: "대상 id", type: "text", required: true },
                { name: "shareBps", label: "지분(bps)", type: "number", required: true },
                { name: "performerRole", label: "연주자 역할", type: "select", options: opts(["FEATURED", "NON_FEATURED"]) },
                { name: "roleDetail", label: "역할 상세", type: "text" },
                { name: "status", label: "상태", type: "select", required: true, options: opts(RECORD_STATUSES), initial: currentApp() === "portal" ? "ASSERTED" : "VERIFIED" },
                { name: "validFrom", label: "유효 시작(UTC)", type: "datetime", required: true },
                { name: "validTo", label: "유효 끝(UTC)", type: "datetime" },
                { name: "evidenceDocument", label: "근거 문서", type: "select", options: docs },
                { name: "visibility", label: "공개 범위", type: "select", options: opts(VISIBILITIES) },
                { name: "sourceRef", label: "출처 참조", type: "text" },
              ]}
              toBody={({ evidenceDocument, ...v }) => compact({ ...v, shareBps: Number(v.shareBps), validFrom: toIso(v.validFrom), validTo: toIso(v.validTo), evidenceDocuments: toEvidence(evidenceDocument) })} />
          </Section>
        </>
      )}
    </>
  );
}
