import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "../../components/Section.tsx";
import { DataTable } from "../../components/DataTable.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { Digest } from "../../components/Digest.tsx";
import { Instant } from "../../components/Instant.tsx";
import { ApiError } from "../../api/client.ts";
import { useAction, useGet, useList } from "../../api/hooks.ts";
import { activateVersion, approveVersion, compilePolicy, rebindPolicy, seedSyntheticSong } from "../../api/policy.ts";
import type { PolicyVersion, PolicyVersionDetail, SeedResult } from "../../api/types.ts";

const SEED_KEY = ["dev", "seed"] as const;
const SEED_HINT = "데이터 화면에서 합성 곡을 먼저 불러오세요 / 이미 불러온 경우 초기화 후 다시";
const INV = ["versions", "policies", "version"];

function Diagnostics({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || error.diagnostics.length === 0) return null;
  const rows = error.diagnostics.map((d) => (d ?? {}) as Record<string, unknown>);
  const str = (v: unknown) => (v === undefined || v === null ? "—" : typeof v === "string" ? v : JSON.stringify(v));
  return (
    <DataTable rows={rows}
      columns={[
        { key: "code", label: "코드", render: (r) => str(r.code) },
        { key: "message", label: "메시지", render: (r) => str(r.message) },
        { key: "path", label: "위치", render: (r) => str(r.path ?? r.line ?? r.location) },
      ]} />
  );
}

function VersionRow({ policyId, v }: { policyId: string; v: PolicyVersion }) {
  const approve = useAction<void, unknown>(() => approveVersion(policyId, v.version), INV);
  const activate = useAction<void, unknown>(() => activateVersion(policyId, v.version), INV);
  return (
    <li className="stack ver">
      <div className="row-actions">
        <strong>v{v.version}</strong> <StatusBadge status={v.status} />
        {v.rebindOfVersion !== null && <span className="muted">재고정(v{v.rebindOfVersion})</span>}
      </div>
      <dl className="kv">
        <dt>policy digest</dt><dd><Digest value={v.policyDigest} /></dd>
        <dt>facts digest</dt><dd><Digest value={v.factsDigest} /></dd>
        <dt>승인자</dt><dd>{v.approvedBy ?? <span className="muted">미승인</span>}</dd>
        <dt>작성</dt><dd>{v.createdBy} <Instant iso={v.createdAt} /></dd>
      </dl>
      <div className="row-actions">
        <button type="button" className="btn" aria-label={`${policyId} 버전 ${v.version} 승인`} disabled={approve.isPending} onClick={() => approve.mutate()}>승인</button>
        <button type="button" className="btn" aria-label={`${policyId} 버전 ${v.version} 활성화`} disabled={activate.isPending} onClick={() => activate.mutate()}>활성화</button>
      </div>
      <ErrorPanel error={approve.error} />
      <ErrorPanel error={activate.error} />
    </li>
  );
}

export function PolicyDetail() {
  const { policyId = "" } = useParams();
  const qc = useQueryClient();
  const versions = useList<PolicyVersion>("versions", `/policies/${encodeURIComponent(policyId)}/versions`);
  const latest = versions.pages[0];
  const latestDetail = useGet<PolicyVersionDetail>(["version", policyId, latest?.version ?? 0], `/policies/${encodeURIComponent(policyId)}/versions/${latest?.version ?? 0}`, { enabled: latest !== undefined });
  const seed = useQuery<SeedResult | null>({ queryKey: SEED_KEY, queryFn: () => null, enabled: false, gcTime: Infinity, staleTime: Infinity });
  const [text, setText] = useState("");
  const [packId, setPackId] = useState("");
  const [hint, setHint] = useState("");

  // 이 정책의 최신 버전이 있으면 그 팩·원문으로 채운다(처음 한 번).
  const [filled, setFilled] = useState("");
  useEffect(() => {
    if (latest && latestDetail.data && filled !== policyId) {
      setFilled(policyId);
      setText(latestDetail.data.sourceText);
      setPackId(latestDetail.data.packId);
    }
  }, [latest, latestDetail.data, filled, policyId]);

  const compile = useAction<void, unknown>(() => compilePolicy(policyId, packId, text), INV);
  const rebind = useAction<void, unknown>(() => rebindPolicy(policyId), INV);

  const load = async () => {
    setHint("");
    let s = seed.data ?? undefined;
    if (!s) {
      try {
        s = await seedSyntheticSong();
        qc.setQueryData(SEED_KEY, s);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) setHint(SEED_HINT);
        else setHint(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setText(s.policyText);
    setPackId(s.packId);
  };

  const versionsError = versions.error instanceof ApiError && versions.error.status === 404 ? null : versions.error;
  return (
    <>
      <Section title={`정책 ${policyId}`} actions={
        <button type="button" className="btn" disabled={rebind.isPending || !latest} onClick={() => rebind.mutate()}>재고정</button>
      }>
        <ErrorPanel error={rebind.error} />
        {latest && <p className="muted">최신 v{latest.version}</p>}
      </Section>
      <div className="split">
        <Section title="VCRL 편집기" actions={<button type="button" className="btn" onClick={() => void load()}>합성 곡 정책 불러오기</button>}>
          <div className="stack">
            {hint && <p className="muted" role="status">{hint}</p>}
            <label className="field"><span>팩 id</span><input value={packId} onChange={(e) => setPackId(e.target.value)} placeholder="pak_nova_summer" /></label>
            <label className="field"><span>정책 원문(VCRL)</span>
              <textarea className="vcrl" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div><button type="button" className="btn primary" disabled={compile.isPending || !packId || !text} onClick={() => compile.mutate()}>컴파일</button></div>
            <ErrorPanel error={compile.error} />
            <Diagnostics error={compile.error} />
          </div>
        </Section>
        <Section title="버전">
          <ErrorPanel error={versionsError} />
          {versions.pages.length === 0 ? <p className="muted">버전이 없습니다. 컴파일하면 첫 버전이 생깁니다.</p> : (
            <ul className="stack versions">
              {versions.pages.map((v) => <VersionRow key={v.version} policyId={policyId} v={v} />)}
            </ul>
          )}
          <Pager next={versions.next} loadMore={versions.loadMore} />
        </Section>
      </div>
    </>
  );
}
