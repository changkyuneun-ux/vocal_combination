import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

type Counts = { ACCEPTED: number; DUPLICATE: number; REJECTED: number };
type FileSummary = {
  fileId: string; tenantId: string; format: string; fileName: string; sha256: string; byteSize: number; status: "APPLIED" | "REJECTED";
  fileErrors: { code: string; message: string }[]; receivedAt: string; counts: Counts;
};
type FileDetail = FileSummary & {
  records: { line: number; raw: string; status: "ACCEPTED" | "DUPLICATE" | "REJECTED"; attempts: number; rejectCode?: string; rejectMessage?: string; retriable?: boolean; eventId?: string }[];
};
type Asset = { tenantId: string; externalId: string; vcId: string; createdAt: string };
const TONE = { ACCEPTED: "ok", DUPLICATE: "muted", REJECTED: "bad", APPLIED: "ok" } as const;

function FilePanel({ fileId }: { fileId: string }) {
  const q = useGet<FileDetail>(["hub-file", fileId], `/hub/files/${encodeURIComponent(fileId)}`);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState("");
  const retry = async () => {
    try {
      const r = await api<{ retried: number; fixed: number }>("POST", `/hub/files/${encodeURIComponent(fileId)}/retry`);
      setErr(null); setMsg(`재처리 ${r.retried}줄 중 ${r.fixed}줄 적용`); void q.refetch();
    } catch (e) { setErr(e as ApiError); }
  };
  const f = q.data;
  return (
    <Section title={`파일 ${fileId}`}>
      <ErrorPanel error={q.error ?? err} />
      {f && <>
        <p className="muted">{f.tenantId} · {f.format} · {f.fileName} · {f.byteSize} bytes · 원본 sha256 <code>{f.sha256}</code></p>
        {f.fileErrors.map((e) => <p key={e.code} className="bad">파일 거부 {e.code}: {e.message}</p>)}
        <button type="button" className="btn" disabled={!f.records.some((r) => r.retriable)} onClick={() => void retry()}>고칠 수 있는 거부 줄 재처리</button>
        {msg && <span className="muted"> {msg}</span>}
        <DataTable rows={f.records} empty="적용할 줄이 없습니다." columns={[
          { key: "line", label: "줄" },
          { key: "status", label: "결과", render: (r) => <span className={`badge ${TONE[r.status]}`}>{r.status}</span> },
          { key: "why", label: "거부 사유", render: (r) => (r.rejectCode ? <>{r.rejectCode}{r.retriable ? " (재처리 가능)" : ""}<div className="muted">{r.rejectMessage}</div></> : "—") },
          { key: "event", label: "매출 이벤트", render: (r) => (r.eventId ? <code>{r.eventId}</code> : "—") },
          { key: "attempts", label: "시도" },
          { key: "raw", label: "원본 줄", render: (r) => <code className="muted">{r.raw}</code> },
        ]} />
      </>}
    </Section>
  );
}

/** 연동 허브(운영): 파트너 리포트 파일과 줄별 결과(거부 큐), 자산 대응 등록, 고칠 수 있는 거부 줄 재처리. */
export function HubPage() {
  const files = useGet<FileSummary[]>(["hub-files"], "/hub/files", { refetchInterval: 5000 });
  const assets = useGet<Asset[]>(["hub-assets"], "/hub/assets");
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ tenantId: "", externalId: "", vcId: "" });
  const [err, setErr] = useState<ApiError | null>(null);
  const map = async () => {
    try { await api("POST", "/hub/assets", form); setErr(null); setForm({ ...form, externalId: "", vcId: "" }); void assets.refetch(); } catch (e) { setErr(e as ApiError); }
  };
  return (
    <>
      <Section title="연동 허브 수신 파일">
        <p className="muted">파트너가 보낸 유통사 CSV·DDEX DSR 파일. 원본은 그대로 보관하고, 줄마다 적용(ACCEPTED)·중복(DUPLICATE)·거부(REJECTED)를 남긴다.
          파일 단위 오류(머리글 없음, 건수 불일치)가 있으면 아무 줄도 적용하지 않는다.</p>
        <ErrorPanel error={files.error} />
        <DataTable rows={files.data ?? []} empty="받은 파일이 없습니다." columns={[
          { key: "fileId", label: "파일", render: (r) => <button type="button" className="btn tiny" onClick={() => setOpen(r.fileId)}>{r.fileId}</button> },
          { key: "tenantId", label: "파트너" },
          { key: "format", label: "형식" },
          { key: "status", label: "상태", render: (r) => <span className={`badge ${TONE[r.status] ?? "bad"}`}>{r.status}</span> },
          { key: "counts", label: "적용·중복·거부", render: (r) => `${r.counts.ACCEPTED} · ${r.counts.DUPLICATE} · ${r.counts.REJECTED}` },
          { key: "receivedAt", label: "수신", render: (r) => <Instant iso={r.receivedAt} /> },
        ]} />
      </Section>
      {open && <FilePanel key={open} fileId={open} />}
      <Section title="자산 대응(파트너 자산 id → 조합)">
        <div className="inline-form">
          <input aria-label="파트너 테넌트" placeholder="tnt_…" value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} />
          <input aria-label="파트너 자산 id" placeholder="ISRC·상품 코드" value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })} />
          <input aria-label="조합 id" placeholder="vc_…" value={form.vcId} onChange={(e) => setForm({ ...form, vcId: e.target.value })} />
          <button type="button" className="btn" disabled={Object.values(form).some((v) => v.trim() === "")} onClick={() => void map()}>등록</button>
        </div>
        <ErrorPanel error={assets.error ?? err} />
        <DataTable rows={assets.data ?? []} empty="등록된 대응이 없습니다." columns={[
          { key: "tenantId", label: "파트너" }, { key: "externalId", label: "자산 id" }, { key: "vcId", label: "조합" },
          { key: "createdAt", label: "등록", render: (r) => <Instant iso={r.createdAt} /> },
        ]} />
      </Section>
    </>
  );
}
