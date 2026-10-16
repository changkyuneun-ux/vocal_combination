import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { useGet } from "../../api/hooks.ts";
import { RECORD_STATUSES, RIGHT_KINDS, VISIBILITIES, compact, opts, toIso } from "../../api/registry.ts";
import type { ScopeFacts } from "../../api/types.ts";
import { toEvidence, useDocumentOptions } from "../../api/documents.ts";
import { currentApp } from "../../app/apps.ts";

export function Mandates() {
  const docs = useDocumentOptions();
  const [scope, setScope] = useScopeParam();
  const facts = useGet<ScopeFacts>(["facts", scope], `/scopes/${encodeURIComponent(scope)}/facts`, { enabled: scope !== "" });
  return (
    <>
      <Section title="범위 선택">
        <ScopeSelect scope={scope} onChange={setScope} />
        {scope !== "" && <ErrorPanel error={facts.error} />}
      </Section>
      {scope !== "" && (
        <>
          <Section title="위임 표">
            <DataTable rows={facts.data?.mandates ?? []} empty="위임이 없습니다."
              columns={[
                { key: "mandateId", label: "위임 id" }, { key: "version", label: "버전" }, { key: "fromPartyId", label: "위임자" }, { key: "toPartyId", label: "수임자" },
                { key: "rightKind", label: "권리 종류" }, { key: "shareBps", label: "지분(bps)" },
                { key: "status", label: "상태", render: (r) => <StatusBadge status={r.status} /> },
                { key: "validFrom", label: "유효 시작(UTC)", render: (r) => <Instant iso={r.validFrom} /> },
                { key: "supersededAt", label: "대체됨", render: (r) => <Instant iso={r.supersededAt} /> },
              ]} />
          </Section>
          <Section title="위임 등록">
            <RegisterForm path="/mandates" submitLabel="위임 등록" invalidate={["facts", "scope", "disputes"]} key={`mandate-${scope}`}
              fields={[
                { name: "mandateId", label: "위임 id", type: "text", required: true },
                { name: "factsScopeId", label: "범위 id", type: "text", required: true, initial: scope },
                { name: "fromPartyId", label: "위임자 id", type: "text", required: true },
                { name: "toPartyId", label: "수임자 id", type: "text", required: true },
                { name: "rightKind", label: "권리 종류", type: "select", required: true, options: opts(RIGHT_KINDS) },
                { name: "shareBps", label: "지분(bps)", type: "number", required: true },
                { name: "status", label: "상태", type: "select", required: true, options: opts(RECORD_STATUSES), initial: currentApp() === "portal" ? "ASSERTED" : "VERIFIED" },
                { name: "validFrom", label: "유효 시작(UTC)", type: "datetime", required: true },
                { name: "validTo", label: "유효 끝(UTC)", type: "datetime" },
                { name: "visibility", label: "공개 범위", type: "select", options: opts(VISIBILITIES) },
                { name: "evidenceDocument", label: "근거 문서", type: "select", options: docs },
                { name: "sourceRef", label: "출처 참조", type: "text" },
              ]}
              toBody={({ evidenceDocument, ...v }) => compact({ ...v, shareBps: Number(v.shareBps), validFrom: toIso(v.validFrom), validTo: toIso(v.validTo), evidenceDocuments: toEvidence(evidenceDocument) })} />
          </Section>
        </>
      )}
    </>
  );
}
