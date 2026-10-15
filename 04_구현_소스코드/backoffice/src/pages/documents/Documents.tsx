import { useState } from "react";
import { api, apiUpload, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { DOCUMENT_KIND_LABEL, type DocumentDetail, type DocumentSummary } from "../../api/documents.ts";
import { currentApp } from "../../app/apps.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

const TONE: Record<string, string> = { UPLOADED: "muted", CONFIRMED: "ok", REJECTED: "bad" };
const isoOrEmpty = (d: string) => (d === "" ? "" : `${d}T00:00:00.000Z`);

function Upload({ onDone }: { onDone: (id: string) => void }) {
  const [m, setM] = useState({ kind: "MASTER_CONTRACT", title: "", parties: "", effectiveFrom: "", effectiveTo: "", confidentiality: "PARTIES" });
  const [file, setFile] = useState<File | undefined>();
  const [err, setErr] = useState<ApiError | null>(null);
  const send = async () => {
    if (!file) return;
    const q = new URLSearchParams({ kind: m.kind, title: m.title, parties: m.parties.replace(/\s/g, ""), confidentiality: m.confidentiality,
      ...(m.effectiveFrom && { effectiveFrom: isoOrEmpty(m.effectiveFrom) }), ...(m.effectiveTo && { effectiveTo: isoOrEmpty(m.effectiveTo) }) });
    try { const d = await apiUpload<DocumentDetail>("POST", `/documents?${q}`, file); setErr(null); onDone(d.documentId); } catch (e) { setErr(e as ApiError); }
  };
  return (
    <Section title="원천 문서 올리기">
      <p className="muted">계약서·동의서·위임장 원문(PDF, PNG, JPEG)을 올린다. 원문은 바뀌지 않게 보관되고, 고치려면 새 버전으로 올린다. 효력 종료 후 10년 동안 보관한다.</p>
      <div className="inline-form">
        <select aria-label="문서 종류" value={m.kind} onChange={(e) => setM({ ...m, kind: e.target.value })}>
          {Object.entries(DOCUMENT_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input aria-label="문서 제목" placeholder="제목" value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />
        <input aria-label="당사자" placeholder="당사자 파티 id(쉼표로)" value={m.parties} onChange={(e) => setM({ ...m, parties: e.target.value })} />
        <label className="small">효력 시작 <input type="date" aria-label="효력 시작" value={m.effectiveFrom} onChange={(e) => setM({ ...m, effectiveFrom: e.target.value })} /></label>
        <label className="small">효력 끝 <input type="date" aria-label="효력 끝" value={m.effectiveTo} onChange={(e) => setM({ ...m, effectiveTo: e.target.value })} /></label>
        <select aria-label="열람 범위" value={m.confidentiality} onChange={(e) => setM({ ...m, confidentiality: e.target.value })}>
          <option value="PARTIES">당사자도 열람</option><option value="OWNER">소유 테넌트만</option>
        </select>
        <input type="file" aria-label="원문 파일" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0])} />
        <button type="button" className="btn primary" disabled={!file || m.title.trim() === ""} onClick={() => void send()}>올리기</button>
      </div>
      <ErrorPanel error={err} />
    </Section>
  );
}

function Detail({ id }: { id: string }) {
  const q = useGet<DocumentDetail>(["document", id], `/documents/${encodeURIComponent(id)}`);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); } };
  const d = q.data;
  return (
    <Section title={`문서 ${id}`}>
      <ErrorPanel error={q.error ?? err} />
      {d && <>
        <label className="field"><span>거부 사유(잘못 올린 버전 표시)</span><input aria-label="거부 사유" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <DataTable rows={d.versions} columns={[
          { key: "version", label: "버전" },
          { key: "title", label: "제목" },
          { key: "status", label: "상태", render: (v) => <span className={`badge ${TONE[v.status] ?? "muted"}`}>{v.disposedAt ? "폐기됨" : v.status}</span> },
          { key: "sha256", label: "원문 sha256", render: (v) => <code title={v.sha256}>{v.sha256.slice(0, 12)}…</code> },
          { key: "period", label: "효력", render: (v) => `${v.effectiveFrom?.slice(0, 10) ?? "—"} ~ ${v.effectiveTo?.slice(0, 10) ?? "—"}` },
          { key: "retention", label: "보관 기한", render: (v) => v.retentionUntil?.slice(0, 10) ?? "효력 끝 미정" },
          { key: "records", label: "근거로 삼은 기록", render: (v) => (v.records.length === 0 ? "—" : v.records.map((r) => <div key={`${r.type}${r.id}${r.version}`}><code>{r.type} {r.id} v{r.version}</code></div>)) },
          { key: "act", label: "", render: (v) => <>
            {!v.disposedAt && <a className="btn tiny" href={`/api/${currentApp() === "ops" ? "ops" : "portal"}/documents/${encodeURIComponent(id)}/versions/${v.version}/file`} target="_blank" rel="noreferrer">원문 열기</a>}
            {v.status !== "REJECTED" && <button type="button" className="btn tiny" disabled={reason.trim() === ""}
              onClick={() => void act(() => api("POST", `/documents/${encodeURIComponent(id)}/versions/${v.version}/reject`, { reason }))}>거부</button>}
            {currentApp() === "ops" && !v.disposedAt && <button type="button" className="btn tiny"
              onClick={() => void act(() => api("POST", `/documents/${encodeURIComponent(id)}/versions/${v.version}/dispose`))}>폐기</button>}
          </> },
        ]} />
      </>}
    </Section>
  );
}

/** 원천 문서(원천 문서 설계 S1): 원문 보관·버전·근거 연결 현황. 권리 주장·위임·동의 등록 화면에서 이 문서를 근거로 고른다. */
export function DocumentsPage() {
  const q = useGet<DocumentSummary[]>(["documents"], "/documents");
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <Upload onDone={(id) => { setOpen(id); void q.refetch(); }} />
      <Section title="원천 문서">
        <ErrorPanel error={q.error} />
        <DataTable rows={q.data ?? []} empty="올린 문서가 없습니다." columns={[
          { key: "documentId", label: "문서", render: (d) => <button type="button" className="btn tiny" onClick={() => setOpen(d.documentId)}>{d.title}</button> },
          { key: "kind", label: "종류", render: (d) => DOCUMENT_KIND_LABEL[d.kind] ?? d.kind },
          { key: "version", label: "최신 버전" },
          { key: "parties", label: "당사자", render: (d) => d.parties.join(", ") || "—" },
          { key: "status", label: "상태", render: (d) => <span className={`badge ${TONE[d.status] ?? "muted"}`}>{d.disposedAt ? "폐기됨" : d.status}</span> },
          { key: "uploadedAt", label: "올린 시각", render: (d) => <Instant iso={d.uploadedAt} /> },
        ]} />
      </Section>
      {open && <Detail key={open} id={open} />}
    </>
  );
}
