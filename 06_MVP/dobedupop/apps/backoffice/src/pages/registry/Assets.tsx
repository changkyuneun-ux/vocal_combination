import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Digest } from "../../components/Digest.tsx";
import { RegisterForm } from "../../components/RegisterForm.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { useGet, useList } from "../../api/hooks.ts";
import { compact, opts } from "../../api/registry.ts";
import type { Scope, ScopeFacts, Work } from "../../api/types.ts";

export function Assets() {
  const [scope, setScope] = useScopeParam();
  const works = useList<Work>("works", "/works");
  const info = useGet<Scope>(["scope", scope], `/scopes/${encodeURIComponent(scope)}`, { enabled: scope !== "" });
  const facts = useGet<ScopeFacts>(["facts", scope], `/scopes/${encodeURIComponent(scope)}/facts`, { enabled: scope !== "" });
  const f = facts.data;
  const inv = ["facts", "scope"];
  return (
    <>
      <Section title="곡 목록">
        <ErrorPanel error={works.error} />
        <DataTable<Work> rows={works.pages} empty="곡이 없습니다."
          columns={[{ key: "workId", label: "곡 id" }, { key: "title", label: "제목" }, { key: "iswc", label: "ISWC", render: (r) => r.iswc ?? "—" },
            { key: "createdAt", label: "등록", render: (r) => <Instant iso={r.createdAt} /> }]} />
        <Pager next={works.next} loadMore={works.loadMore} />
      </Section>
      <div className="split">
        <Section title="곡 등록">
          <RegisterForm path="/works" submitLabel="곡 등록" invalidate={["works"]}
            fields={[{ name: "workId", label: "신규 곡 id", type: "text", required: true }, { name: "title", label: "제목", type: "text", required: true }, { name: "iswc", label: "ISWC", type: "text" }]}
            toBody={compact} />
        </Section>
        <Section title="facts 범위 생성">
          <RegisterForm path="/scopes" invalidate={["scope", "facts"]} submitLabel="범위 생성"
            fields={[{ name: "factsScopeId", label: "범위 id", type: "text", required: true }, { name: "workId", label: "범위 대상 곡 id", type: "text", required: true }]}
            toBody={compact} />
        </Section>
      </div>
      <Section title="facts 범위 선택">
        <ScopeSelect scope={scope} onChange={setScope} />
        {scope !== "" && <ErrorPanel error={info.error} />}
        {info.data && (
          <dl className="kv">
            <dt>곡</dt><dd>{info.data.workId}</dd>
            <dt>마지막 버전</dt><dd>{info.data.lastVersion}</dd>
            <dt>봉인 시각(sealedThrough)</dt><dd><Instant iso={info.data.sealedThrough} /></dd>
            <dt>최근 facts 봉인</dt><dd>{info.data.latestFactsSeal ? <Digest value={info.data.latestFactsSeal.digest} label="최근 facts 봉인" /> : <span className="muted">없음</span>}</dd>
          </dl>
        )}
      </Section>
      {scope !== "" && (
        <>
          <ErrorPanel error={facts.error} />
          <Section title="녹음">
            <DataTable rows={f?.recordings ?? []} empty="녹음이 없습니다."
              columns={[{ key: "recordingId", label: "녹음 id" }, { key: "versionTitle", label: "버전명" }, { key: "masterOwnerPartyId", label: "마스터 권리자" }, { key: "isrc", label: "ISRC", render: (r) => r.isrc ?? "—" }]} />
            <RegisterForm path="/recordings" submitLabel="녹음 등록" invalidate={inv} key={`rec-${info.data?.workId}`}
              fields={[
                { name: "recordingId", label: "녹음 id", type: "text", required: true },
                { name: "workId", label: "녹음 대상 곡 id", type: "text", required: true, initial: info.data?.workId ?? "" },
                { name: "masterOwnerPartyId", label: "마스터 권리자 id", type: "text", required: true },
                { name: "versionTitle", label: "버전명", type: "text", required: true }, { name: "isrc", label: "ISRC", type: "text" },
              ]} toBody={compact} />
          </Section>
          <Section title="슬롯">
            <DataTable rows={f?.slots ?? []} empty="슬롯이 없습니다."
              columns={[{ key: "slotId", label: "슬롯 id" }, { key: "recordingId", label: "녹음 id" }, { key: "startMs", label: "시작(ms)" }, { key: "endMs", label: "끝(ms)" }, { key: "durationMs", label: "길이(ms)" }, { key: "sortOrder", label: "순서" }]} />
            <RegisterForm path="/slots" submitLabel="슬롯 등록" invalidate={inv}
              fields={[
                { name: "slotId", label: "슬롯 id", type: "text", required: true }, { name: "recordingId", label: "녹음 id", type: "text", required: true },
                { name: "startMs", label: "시작(ms)", type: "number", required: true }, { name: "endMs", label: "끝(ms)", type: "number", required: true },
                { name: "sortOrder", label: "순서", type: "number", required: true },
              ]}
              toBody={(v) => ({ slotId: v.slotId, recordingId: v.recordingId, startMs: Number(v.startMs), endMs: Number(v.endMs), sortOrder: Number(v.sortOrder) })} />
          </Section>
          <Section title="스템">
            <DataTable rows={f?.stems ?? []} empty="스템이 없습니다."
              columns={[{ key: "stemId", label: "스템 id" }, { key: "slotId", label: "슬롯 id" }, { key: "recordingId", label: "녹음 id" }, { key: "performerPartyId", label: "연주자", render: (r) => r.performerPartyId ?? "—" }, { key: "rightsBearing", label: "권리 부담", render: (r) => (r.rightsBearing ? "예" : "아니오") }]} />
            <RegisterForm path="/stems" submitLabel="스템 등록" invalidate={inv}
              fields={[
                { name: "stemId", label: "스템 id", type: "text", required: true }, { name: "slotId", label: "슬롯 id", type: "text", required: true },
                { name: "recordingId", label: "녹음 id", type: "text", required: true }, { name: "performerPartyId", label: "연주자 id", type: "text" },
                { name: "rightsBearing", label: "권리 부담", type: "select", required: true, options: [{ value: "true", label: "예" }, { value: "false", label: "아니오" }] },
              ]}
              toBody={(v) => compact({ stemId: v.stemId, slotId: v.slotId, recordingId: v.recordingId, performerPartyId: v.performerPartyId, rightsBearing: v.rightsBearing === "true" })} />
          </Section>
          <Section title="보이스">
            <DataTable rows={f?.voices ?? []} empty="보이스가 없습니다."
              columns={[{ key: "voiceId", label: "보이스 id" }, { key: "kind", label: "종류" }, { key: "createdAt", label: "등록", render: (r) => <Instant iso={r.createdAt} /> }]} />
            <RegisterForm path="/voices" submitLabel="보이스 등록" invalidate={inv} key={`voice-${scope}`}
              fields={[
                { name: "voiceId", label: "보이스 id", type: "text", required: true },
                { name: "factsScopeId", label: "범위 id", type: "text", required: true, initial: scope },
                { name: "kind", label: "종류", type: "select", required: true, options: opts(["HUMAN", "AI"]) },
              ]} toBody={compact} />
          </Section>
        </>
      )}
    </>
  );
}
