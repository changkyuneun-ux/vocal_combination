import { useEffect, useState } from "react";
import { useActor } from "../../app/actor.ts";
import { useParams } from "react-router";
import { Section } from "../../components/Section.tsx";
import { Pager } from "../../components/Pager.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { StatusBadge } from "../../components/StatusBadge.tsx";
import { Diagnostics } from "../../components/Diagnostics.tsx";
import { Digest } from "../../components/Digest.tsx";
import { Instant } from "../../components/Instant.tsx";
import { ApiError } from "../../api/client.ts";
import { useAction, useGet, useList } from "../../api/hooks.ts";
import { activateVersion, approveVersion, compilePolicy, packExists, peekSyntheticSong, rebindPolicy } from "../../api/policy.ts";
import type { PolicyVersion, PolicyVersionDetail } from "../../api/types.ts";

const SEED_HINT = "개발 도구 > 데이터에서 합성 곡을 먼저 불러오세요";
const INV = ["versions", "policies", "version"];

function VersionRow({ policyId, v }: { policyId: string; v: PolicyVersion }) {
  const approve = useAction<void, unknown>(() => approveVersion(policyId, v.version), INV);
  const activate = useAction<void, unknown>(() => activateVersion(policyId, v.version), INV);
  const actor = useActor();
  const { reset: resetApprove } = approve;
  const { reset: resetActivate } = activate;
  useEffect(() => { resetApprove(); resetActivate(); }, [actor, resetApprove, resetActivate]);
  return (
    <li className="stack ver">
      <div className="row-actions">
        <strong>v{v.version}</strong> <StatusBadge status={v.status} />
        {v.rebindOfVersion !== null && <span className="muted">재고정(v{v.rebindOfVersion})</span>}
      </div>
      <dl className="kv">
        <dt>policy digest</dt><dd><Digest value={v.policyDigest} label={`v${v.version} policy`} /></dd>
        <dt>facts digest</dt><dd><Digest value={v.factsDigest} label={`v${v.version} facts`} /></dd>
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

/** 정책이 바뀌면 편집기 상태를 모두 버린다. */
export function PolicyDetail() {
  const { policyId = "" } = useParams();
  return <PolicyEditor key={policyId} policyId={policyId} />;
}

function PolicyEditor({ policyId }: { policyId: string }) {
  const versions = useList<PolicyVersion>("versions", `/policies/${encodeURIComponent(policyId)}/versions`);
  const latest = versions.pages[0];
  const latestDetail = useGet<PolicyVersionDetail>(["version", policyId, latest?.version ?? 0], `/policies/${encodeURIComponent(policyId)}/versions/${latest?.version ?? 0}`, { enabled: latest !== undefined });
  const actor = useActor();
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

  const { reset: resetCompile } = compile;
  const { reset: resetRebind } = rebind;
  useEffect(() => { resetCompile(); resetRebind(); }, [actor, resetCompile, resetRebind]);

  /** 읽기 전용 GET으로 원문을 채운다. 시드(POST)는 부르지 않는다. */
  const load = async () => {
    setHint("");
    try {
      const s = await peekSyntheticSong();
      setText(s.policyText);
      setPackId(s.packId);
      if (!(await packExists(s.packId))) setHint(SEED_HINT);
    } catch (e) {
      setHint(e instanceof Error ? e.message : String(e));
    }
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
