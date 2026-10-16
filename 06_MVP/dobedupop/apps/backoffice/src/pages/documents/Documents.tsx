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

const CLAUSE_TYPE: Record<string, string> = { SHARE: "지분", RIGHT_HOLDER: "권리자", MANDATE: "위임", SCOPE: "이용 범위", PERIOD: "기간", SPLIT_RATE: "분배율", OTHER: "기타" };

/** 조항 표시와 기록 연결(원천 문서 설계 S3): 왼쪽 원문을 보며 근거 문장을 옮겨 적고, 그 조항을 권리 주장·위임·동의에 연결한다. */
function Clauses({ id, v }: { id: string; v: DocumentDetail["versions"][number] }) {
  const [c, setC] = useState({ page: "", quote: "", clauseType: "SHARE", note: "" });
  const [link, setLink] = useState<Record<string, { recordType: string; recordId: string }>>({});
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); setErr(null); setMsg(done); } catch (e) { setErr(e as ApiError); } };
  return (
    <div className="stack" aria-label="조항">
      <h3>조항(근거 위치)</h3>
      <div className="inline-form">
        <input aria-label="쪽" placeholder="쪽" value={c.page} onChange={(e) => setC({ ...c, page: e.target.value.replace(/\D/g, "") })} />
        <select aria-label="조항 종류" value={c.clauseType} onChange={(e) => setC({ ...c, clauseType: e.target.value })}>
          {Object.entries(CLAUSE_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <textarea aria-label="조항 원문" placeholder="원문에서 근거 문장을 옮겨 적는다" value={c.quote} onChange={(e) => setC({ ...c, quote: e.target.value })} />
        <button type="button" className="btn" disabled={c.quote.trim() === "" || v.status === "REJECTED"} onClick={() => void act(
          () => api("POST", `/documents/${encodeURIComponent(id)}/versions/${v.version}/clauses`, { quote: c.quote, clauseType: c.clauseType, ...(c.page && { page: Number(c.page) }), ...(c.note && { note: c.note }) }),
          "조항을 표시했습니다. 새로 고치면 목록에 보입니다.")}>조항 표시</button>
      </div>
      {msg && <p className="muted" role="status">{msg}</p>}
      <ErrorPanel error={err} />
      {v.clauses.length === 0 ? <p className="muted">표시한 조항이 없습니다.</p> : v.clauses.map((k) => (
        <div key={k.clauseId} className="card" data-clause={k.clauseId}>
          <p><span className="badge">{CLAUSE_TYPE[k.clauseType] ?? k.clauseType}</span> {k.page !== null && <span className="muted">p.{k.page}</span>} “{k.quote}”</p>
          <p className="small">근거로 삼은 기록: {k.records.length === 0 ? "없음" : k.records.map((r) => `${r.type} ${r.id} v${r.version}`).join(", ")}</p>
          <div className="inline-form">
            <select aria-label="연결할 기록 종류" value={link[k.clauseId]?.recordType ?? "CLAIM"} onChange={(e) => setLink({ ...link, [k.clauseId]: { recordType: e.target.value, recordId: link[k.clauseId]?.recordId ?? "" } })}>
              <option value="CLAIM">권리 주장</option><option value="MANDATE">위임</option><option value="CONSENT">동의</option>
            </select>
            <input aria-label="연결할 기록 id" placeholder="기록 id" value={link[k.clauseId]?.recordId ?? ""} onChange={(e) => setLink({ ...link, [k.clauseId]: { recordType: link[k.clauseId]?.recordType ?? "CLAIM", recordId: e.target.value } })} />
            <button type="button" className="btn tiny" disabled={!link[k.clauseId]?.recordId} onClick={() => void act(
              () => api("POST", `/clauses/${encodeURIComponent(k.clauseId)}/links`, { recordType: link[k.clauseId]?.recordType ?? "CLAIM", recordId: link[k.clauseId]!.recordId }),
              "기록에 연결했습니다. 기록이 이 문서를 아직 근거로 삼지 않았다면 근거를 더한 새 버전이 생깁니다.")}>기록에 연결</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const q = useGet<DocumentDetail>(["document", id], `/documents/${encodeURIComponent(id)}`);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); void q.refetch(); } catch (e) { setErr(e as ApiError); } };
  const d = q.data;
  const latest = d?.versions[0];
  const fileUrl = (v: number) => `/api/${currentApp() === "ops" ? "ops" : "portal"}/documents/${encodeURIComponent(id)}/versions/${v}/file`;
  return (
    <Section title={`문서 ${id}`}>
      <ErrorPanel error={q.error ?? err} />
      {d && latest && <>
        <div className="split">
          <div>{latest.disposedAt ? <p className="muted">원문이 폐기되었습니다(해시·기록은 남아 있다).</p>
            : <iframe title="원문" src={fileUrl(latest.version)} style={{ width: "100%", height: "32rem", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }} />}</div>
          <Clauses id={id} v={latest} />
        </div>
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
            {!v.disposedAt && <a className="btn tiny" href={fileUrl(v.version)} target="_blank" rel="noreferrer">원문 열기</a>}
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
