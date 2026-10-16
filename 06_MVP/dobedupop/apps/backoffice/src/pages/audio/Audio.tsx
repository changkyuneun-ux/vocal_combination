import { useState } from "react";
import { api, apiUpload, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import type { ScopeFacts } from "../../api/types.ts";
import { currentApp } from "../../app/apps.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { ScopeSelect, useScopeParam } from "../../components/ScopeSelect.tsx";
import { Section } from "../../components/Section.tsx";

type StemAudio = {
  stemId: string; status: "PENDING" | "READY" | "QC_FAILED" | "REVIEW" | "BLOCKED"; fileSha256: string; byteSize: number; uploadedAt: string; durationMs: number | null;
  qcFailCode: string | null; sourceResult: string | null; source: { findings: { check: string; result: string; detail: string }[]; notChecked: string[] } | null;
  checkedAt: string | null; review?: { by: string; at: string; reason: string };
};
const TONE: Record<StemAudio["status"], string> = { PENDING: "muted", READY: "ok", QC_FAILED: "bad", REVIEW: "warn", BLOCKED: "bad" };

function StemRow({ stemId }: { stemId: string }) {
  const q = useGet<StemAudio>(["stem-audio", stemId], `/stems/${encodeURIComponent(stemId)}/audio`, { refetchInterval: (d) => (d?.status === "PENDING" ? 2000 : false) });
  const [err, setErr] = useState<ApiError | null>(null);
  const none = q.error?.status === 404;
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try { await apiUpload("PUT", `/stems/${encodeURIComponent(stemId)}/audio`, f); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); }
  };
  const a = q.data;
  return (
    <tr>
      <td><code>{stemId}</code></td>
      <td>{none ? <span className="muted">오디오 없음(메타데이터만)</span> : a ? <span className={`badge ${TONE[a.status]}`}>{a.status}</span> : "…"}</td>
      <td>{a?.qcFailCode ?? (a?.status === "QC_FAILED" ? "?" : "—")}</td>
      <td>{a?.source ? <>{a.sourceResult}{a.source.findings.map((f) => <div key={f.check + f.detail} className="muted">{f.check}: {f.detail}</div>)}</> : "—"}</td>
      <td>{a?.checkedAt ? <Instant iso={a.checkedAt} /> : "—"}</td>
      <td>
        <input type="file" accept="audio/*" aria-label={`스템[${stemId}] 오디오 파일`} onChange={(e) => void upload(e.target.files?.[0])} />
        <ErrorPanel error={err} />
      </td>
    </tr>
  );
}

/** 스템 오디오(권리자 포털·운영): 곡을 골라 스템마다 오디오를 올리고 검수·출처 결과를 본다. READY 스템만 발행된다. */
export function StemAudioPage() {
  const [scope, setScope] = useScopeParam();
  const facts = useGet<ScopeFacts>(["facts", scope], `/scopes/${encodeURIComponent(scope)}/facts`, { enabled: scope !== "" });
  return (
    <>
      <Section title="스템 오디오">
        <ScopeSelect scope={scope} onChange={setScope} />
        <p className="muted">오디오를 올리면 오디오 처리 서비스가 기술 검수(포맷·무음·클리핑·라우드니스)와 소스 출처 검사(상용 음원 대조·같은 파일 재사용·길이)를 하고,
          코어가 READY·QC_FAILED·REVIEW·BLOCKED를 정한다. READY가 아닌 스템은 발행되지 않는다. AI 생성 판별과 등록 가창자 음성 대조는 아직 없다.</p>
        <ErrorPanel error={facts.error} />
        {facts.data && (
          <table className="data" aria-label="스템 오디오 상태">
            <thead><tr><th scope="col">스템</th><th scope="col">상태</th><th scope="col">QC 실패</th><th scope="col">출처 검사</th><th scope="col">검사 시각</th><th scope="col">올리기</th></tr></thead>
            <tbody>{facts.data.stems.map((s) => <StemRow key={s.stemId} stemId={s.stemId} />)}</tbody>
          </table>
        )}
      </Section>
      {currentApp() === "ops" && <AudioQueue />}
    </>
  );
}

/** 운영 백오피스 ⑤ 오디오 검수 큐: READY가 아닌 스템, 출처 검토(REVIEW) 판단, 상용 참조 음원 등록. */
function AudioQueue() {
  const q = useGet<StemAudio[]>(["audio-queue"], "/audio/queue", { refetchInterval: 5000 });
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [ref, setRef] = useState({ referenceId: "", title: "", ownerPartyId: "" });
  const decide = async (stemId: string, decision: "READY" | "BLOCKED") => {
    try { await api("POST", `/stems/${encodeURIComponent(stemId)}/audio/review`, { decision, reason }); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); }
  };
  const addRef = async (f: File | undefined) => {
    if (!f) return;
    const qs = new URLSearchParams({ referenceId: ref.referenceId, title: ref.title, ...(ref.ownerPartyId && { ownerPartyId: ref.ownerPartyId }) });
    try { await apiUpload("POST", `/reference-audio?${qs}`, f); setErr(null); } catch (e) { setErr(e as ApiError); }
  };
  return (
    <>
      <Section title="⑤ 오디오 검수 큐">
        <label className="field"><span>판단 사유(검토 결정에 기록)</span><input aria-label="검토 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <ErrorPanel error={q.error ?? err} />
        <DataTable rows={q.data ?? []} empty="검수 대기 스템이 없습니다." columns={[
          { key: "stemId", label: "스템", render: (r) => <code>{r.stemId}</code> },
          { key: "status", label: "상태", render: (r) => <span className={`badge ${TONE[r.status]}`}>{r.status}</span> },
          { key: "why", label: "사유", render: (r) => r.qcFailCode ?? r.source?.findings.map((f) => f.detail).join(" · ") ?? "—" },
          { key: "act", label: "검토", render: (r) => (r.status === "REVIEW" ? <>
            <button type="button" className="btn tiny" disabled={reason.trim() === ""} onClick={() => void decide(r.stemId, "READY")}>사용 허용</button>
            <button type="button" className="btn tiny" disabled={reason.trim() === ""} onClick={() => void decide(r.stemId, "BLOCKED")}>차단</button>
          </> : "—") },
        ]} />
      </Section>
      <Section title="상용 참조 음원(음향 지문)">
        <div className="inline-form">
          <input aria-label="참조 음원 id" placeholder="ref_…" value={ref.referenceId} onChange={(e) => setRef({ ...ref, referenceId: e.target.value })} />
          <input aria-label="참조 음원 제목" placeholder="제목" value={ref.title} onChange={(e) => setRef({ ...ref, title: e.target.value })} />
          <input aria-label="참조 음원 권리자 파티" placeholder="권리자 파티(선택)" value={ref.ownerPartyId} onChange={(e) => setRef({ ...ref, ownerPartyId: e.target.value })} />
          <input type="file" accept="audio/*" aria-label="참조 음원 파일" disabled={ref.referenceId === "" || ref.title === ""} onChange={(e) => void addRef(e.target.files?.[0])} />
        </div>
      </Section>
    </>
  );
}
