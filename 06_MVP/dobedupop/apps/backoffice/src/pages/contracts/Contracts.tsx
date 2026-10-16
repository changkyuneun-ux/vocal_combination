import { useState } from "react";
import { api, devApi, type ApiError } from "../../api/client.ts";
import { CONTRACT_STATUS, toAnswers, usableTemplates, type Contract, type FormValue, type Template, type TemplateVar } from "../../api/contracts.ts";
import { useGet } from "../../api/hooks.ts";
import { currentApp } from "../../app/apps.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";

function Field({ v, value, onChange }: { v: TemplateVar; value: FormValue | undefined; onChange: (x: FormValue) => void }) {
  if (v.type === "multi") {
    const cur = (value as string[] | undefined) ?? [];
    return (
      <fieldset className="field"><legend>{v.label}</legend>
        {(v.options ?? []).map(([code, label]) => (
          <label key={code} className="check"><input type="checkbox" checked={cur.includes(code)}
            onChange={(e) => onChange(e.target.checked ? [...cur, code] : cur.filter((c) => c !== code))} />{label}</label>
        ))}
      </fieldset>
    );
  }
  const hint = v.type === "party" ? "파티 id" : v.type === "recording" ? "녹음 id" : v.type === "voice" ? "보이스 id" : v.type === "bps" ? "%" : "";
  return (
    <label className="field"><span>{v.label}</span>
      <input aria-label={v.label} type={v.type === "date" ? "date" : v.type === "bps" ? "number" : "text"} placeholder={hint}
        value={(value as string | undefined) ?? ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

type Preview = { html: string; signers: string[]; records: Record<string, unknown>[] };

/**
 * 표준 계약 작성(원천 문서 설계 S4): 템플릿을 고르고 질문에 답하면 사람이 읽는 계약서가 만들어진다. 서명을 요청하고, 모두 서명하면
 * "기록 반영"으로 서명본이 원천 문서가 되고 답이 그대로 동의·위임 기록(VERIFIED)이 된다. 전자서명은 개발용 공급자다(결정 D1).
 */
export function ContractsPage() {
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const list = useGet<Contract[]>(["contracts"], "/contracts");
  const usable = usableTemplates(templates.data ?? []);
  const [tid, setTid] = useState("");
  const t = usable.find((x) => x.templateId === tid);
  const [scope, setScope] = useState("");
  const [contractId, setContractId] = useState("");
  const [form, setForm] = useState<Record<string, FormValue>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const draft = () => ({ templateId: tid, factsScopeId: scope, answers: toAnswers(t?.variables ?? [], form) });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); setErr(null); setNotice(msg); void list.refetch(); } catch (e) { setErr(e as ApiError); setNotice(""); }
  };
  return (
    <>
      <Section title="표준 계약 작성">
        <p className="muted">자체 계약서가 없으면 표준 계약으로 시작한다. 조항과 값이 템플릿에서 이미 대응되므로 서명이 끝나면 기록이 바로 확정된다.</p>
        <div className="inline-form">
          <select aria-label="계약 종류" value={tid} onChange={(e) => { setTid(e.target.value); setForm({}); setPreview(null); }}>
            <option value="">계약 종류 선택</option>
            {usable.map((x) => <option key={x.templateId} value={x.templateId}>{x.title} (v{x.version})</option>)}
          </select>
          <input aria-label="곡(facts scope)" placeholder="fsc_…" value={scope} onChange={(e) => setScope(e.target.value)} />
          <input aria-label="계약 id" placeholder="ctr_…" value={contractId} onChange={(e) => setContractId(e.target.value)} />
        </div>
        {t && <div className="form-grid">{t.variables.map((v) => <Field key={v.name} v={v} value={form[v.name]} onChange={(x) => setForm({ ...form, [v.name]: x })} />)}</div>}
        <div className="inline-form">
          <button type="button" className="btn" disabled={!t || scope === ""} onClick={() => void (async () => {
            try { setPreview(await api<Preview>("POST", "/contracts/preview", draft())); setErr(null); } catch (e) { setErr(e as ApiError); setPreview(null); }
          })()}>미리보기</button>
          <button type="button" className="btn primary" disabled={!preview || contractId === ""}
            onClick={() => void act(() => api("POST", "/contracts", { ...draft(), contractId }), "서명을 요청했습니다")}>서명 요청</button>
        </div>
        <ErrorPanel error={templates.error ?? err} />
        {notice && <p role="status">{notice}</p>}
        {preview && <>
          <p aria-label="서명할 당사자">서명할 당사자: {preview.signers.join(", ")} · 서명하면 만들어질 기록: {preview.records.length === 0 ? "없음(문서만)" : preview.records.map((r) => `${r.type} ${r.rightType ?? r.rightKind ?? ""}`).join(", ")}</p>
          <iframe title="계약서 미리보기" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 480, border: "1px solid var(--line, #ccc)" }} />
        </>}
      </Section>
      <Section title="계약">
        <ErrorPanel error={list.error} />
        <DataTable rows={list.data ?? []} empty="계약이 없습니다." columns={[
          { key: "contractId", label: "계약", render: (c) => <><code>{c.contractId}</code><div className="muted small">{c.title} · {c.templateId}@{c.templateVersion}</div></> },
          { key: "factsScopeId", label: "곡", render: (c) => <code>{c.factsScopeId}</code> },
          { key: "status", label: "상태", render: (c) => <span className={`badge ${CONTRACT_STATUS[c.status]?.[1] ?? "muted"}`}>{CONTRACT_STATUS[c.status]?.[0] ?? c.status}</span> },
          { key: "sig", label: "서명", render: (c) => <ul className="plain">{c.signatures.map((s) => (
            <li key={s.partyId}>{s.displayName} — {s.signedAt ? <>서명 <Instant iso={s.signedAt} /></> : <>대기
              {c.status === "SENT" && <button type="button" className="btn tiny" title="개발용 공급자: 플랫폼 밖 당사자의 서명 통지를 흉내 낸다"
                onClick={() => void act(() => devApi("POST", `/esign/${c.contractId}/sign`, { partyId: s.partyId }), `${s.displayName} 서명(공급자 통지)`)}>공급자 서명(개발)</button>}</>}</li>
          ))}</ul> },
          { key: "out", label: "결과", render: (c) => (c.document ? <><code>{c.document.documentId}</code><div className="muted small">{c.records.map((r) => `${r.type} ${r.id}`).join(", ") || "문서만"}</div></> : "—") },
          { key: "act", label: "", render: (c) => <>
            {c.status === "SENT" && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/contracts/${c.contractId}/sign`), "서명했습니다")}>내 몫 서명</button>}
            {c.status === "SIGNED" && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/contracts/${c.contractId}/complete`), "기록을 반영했습니다")}>기록 반영</button>}
            {(c.status === "SENT" || c.status === "SIGNED") && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/contracts/${c.contractId}/cancel`), "취소했습니다")}>취소</button>}
          </> },
        ]} />
      </Section>
      {currentApp() === "ops" && <TemplatesAdmin all={templates.data ?? []} reload={() => void templates.refetch()} />}
    </>
  );
}

/** 템플릿 관리(결정 D6): 법무가 새 버전을 쓰고, 다른 법무가 승인한다. 서명된 계약은 서명 당시 버전에 고정된다. */
function TemplatesAdmin({ all, reload }: { all: Template[]; reload: () => void }) {
  const [title, setTitle] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); reload(); } catch (e) { setErr(e as ApiError); } };
  return (
    <Section title="계약 템플릿(법무)">
      <label className="field"><span>새 버전 제목(비우면 그대로)</span><input aria-label="새 버전 제목" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <ErrorPanel error={err} />
      <DataTable rows={all} empty="템플릿이 없습니다." columns={[
        { key: "id", label: "템플릿", render: (t) => <><code>{t.templateId}@{t.version}</code><div className="muted small">{t.title}</div></> },
        { key: "status", label: "상태", render: (t) => <span className={`badge ${t.status === "APPROVED" ? "ok" : t.status === "DRAFT" ? "warn" : "muted"}`}>{t.status === "APPROVED" ? "사용 중" : t.status === "DRAFT" ? "승인 대기" : "이전 버전"}</span> },
        { key: "who", label: "작성·승인", render: (t) => `${t.authoredBy ?? "시드"} / ${t.approvedBy ?? (t.status === "DRAFT" ? "—" : "시드")}` },
        { key: "act", label: "", render: (t) => <>
          {t.status === "APPROVED" && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/contract-templates/${t.templateId}/versions`, title.trim() ? { title } : {}))}>새 버전 작성</button>}
          {t.status === "DRAFT" && <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/contract-templates/${t.templateId}/versions/${t.version}/approve`))}>승인</button>}
        </> },
      ]} />
    </Section>
  );
}
