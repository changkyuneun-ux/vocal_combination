import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { toAnswers, usableTemplates, type FormValue, type Template, type TemplateVar } from "../../api/contracts.ts";
import { useGet } from "../../api/hooks.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";

export type PartyChoice = { partyId: string; displayName: string };

function Field({ v, value, onChange, parties, multi }: { v: TemplateVar; value: FormValue | undefined; onChange: (x: FormValue) => void; parties?: PartyChoice[]; multi: boolean }) {
  if (v.type === "multi" || (multi && parties)) {
    const opts: [string, string][] = v.type === "multi" ? v.options ?? [] : parties!.map((p) => [p.partyId, p.displayName]);
    const cur = (value as string[] | undefined) ?? [];
    return (
      <fieldset className="field"><legend>{v.label}{multi ? " — 한 사람씩 계약" : ""}</legend>
        {opts.map(([code, label]) => (
          <label key={code} className="check"><input type="checkbox" checked={cur.includes(code)}
            onChange={(e) => onChange(e.target.checked ? [...cur, code] : cur.filter((c) => c !== code))} />{label}</label>
        ))}
      </fieldset>
    );
  }
  if (v.type === "party" && parties) {
    return (
      <label className="field"><span>{v.label}</span>
        <select aria-label={v.label} value={(value as string | undefined) ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">명부에서 고르기</option>{parties.map((p) => <option key={p.partyId} value={p.partyId}>{p.displayName}</option>)}
        </select>
      </label>
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
 * 표준 계약 만들기(원천 문서 설계 S4): 템플릿 → 질문(당사자는 명부에서) → 미리보기 → 서명 요청.
 * 표준 계약 화면과 곡 워크스페이스 문서·계약 탭이 같이 쓴다. fixedScope를 주면 곡을 고르지 않는다.
 * 실연자 변수(performer)는 여러 명을 고를 수 있고, 고른 사람마다 계약을 하나씩 만든다(수령 위임 여러 건).
 */
export function ContractWizard({ fixedScope, parties, defaults = {}, onDone }: { fixedScope?: string; parties?: PartyChoice[]; defaults?: Record<string, FormValue>; onDone?: (msg: string) => void }) {
  const templates = useGet<Template[]>(["contract-templates"], "/contract-templates");
  const usable = usableTemplates(templates.data ?? []);
  const [tid, setTid] = useState("");
  const t = usable.find((x) => x.templateId === tid);
  const [scope, setScope] = useState(fixedScope ?? "");
  const [contractId, setContractId] = useState("");
  const [form, setForm] = useState<Record<string, FormValue>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const multiVar = parties && t?.variables.some((v) => v.name === "performer" && v.type === "party") ? "performer" : null;
  const picked = multiVar ? ((form[multiVar] as string[] | undefined) ?? []) : [];
  const answersFor = (who?: string) => toAnswers(t?.variables ?? [], multiVar ? { ...form, [multiVar]: who ?? picked[0] ?? "" } : form);
  const draft = (who?: string) => ({ templateId: tid, factsScopeId: scope, answers: answersFor(who) });
  const baseId = contractId || (scope ? `ctr_${tid.replace(/^tpl_/, "")}_${scope.replace(/^fsc_/, "")}` : "");
  const create = async () => {
    try {
      if (multiVar) {
        for (const p of picked) await api("POST", "/contracts", { ...draft(p), contractId: `${baseId}_${p.replace(/^pty_/, "")}` });
      } else await api("POST", "/contracts", { ...draft(), contractId: baseId });
      const msg = multiVar ? `서명 요청 ${picked.length}건을 보냈습니다` : "서명을 요청했습니다";
      setErr(null); setNotice(msg); setPreview(null); onDone?.(msg);
    } catch (e) { setErr(e as ApiError); setNotice(""); }
  };
  return (
    <div className="stack" aria-label="계약 만들기">
      <div className="inline-form">
        <label className="field"><span>템플릿</span>
          <select aria-label="계약 종류" value={tid} onChange={(e) => { setTid(e.target.value); setForm({ ...defaults }); setPreview(null); }}>
            <option value="">계약 종류 선택</option>
            {usable.map((x) => <option key={x.templateId} value={x.templateId}>{x.title} (v{x.version})</option>)}
          </select>
        </label>
        {fixedScope === undefined && <input aria-label="곡(facts scope)" placeholder="fsc_…" value={scope} onChange={(e) => setScope(e.target.value)} />}
        <input aria-label="계약 id" placeholder={baseId || "ctr_…"} value={contractId} onChange={(e) => setContractId(e.target.value)} />
      </div>
      {t && <div className="form-grid">{t.variables.map((v) => (
        <Field key={v.name} v={v} value={form[v.name]} parties={v.type === "party" ? parties : undefined} multi={v.name === multiVar}
          onChange={(x) => setForm({ ...form, [v.name]: x })} />
      ))}</div>}
      <div className="inline-form">
        <button type="button" className="btn" disabled={!t || scope === "" || (multiVar !== null && picked.length === 0)} onClick={() => void (async () => {
          try { setPreview(await api<Preview>("POST", "/contracts/preview", draft())); setErr(null); } catch (e) { setErr(e as ApiError); setPreview(null); }
        })()}>미리보기</button>
        <button type="button" className="btn primary" disabled={!preview || baseId === ""} onClick={() => void create()}>
          {multiVar && picked.length > 1 ? `서명 요청 ${picked.length}건 보내기` : "서명 요청"}
        </button>
      </div>
      <ErrorPanel error={templates.error ?? err} />
      {notice && <p role="status">{notice}</p>}
      {preview && <>
        <p aria-label="서명할 당사자">서명할 당사자: {preview.signers.join(", ")} · 서명하면 만들어질 기록: {preview.records.length === 0 ? "없음(문서만)" : preview.records.map((r) => `${r.type} ${r.rightType ?? r.rightKind ?? ""}`).join(", ")}{multiVar && picked.length > 1 ? ` · 첫 사람 기준 미리보기, ${picked.length}건 만든다` : ""}</p>
        <iframe title="계약서 미리보기" sandbox="" srcDoc={preview.html} style={{ width: "100%", height: 420, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }} />
      </>}
    </div>
  );
}
