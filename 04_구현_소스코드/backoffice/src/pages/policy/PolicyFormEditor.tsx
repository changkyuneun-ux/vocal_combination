import { useEffect, useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { defaultForm, formDiff, pct, toBps, type PolicyForm, type Preview } from "../../api/policyForm.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Section } from "../../components/Section.tsx";

const num = (bps: number | undefined) => (bps === undefined ? "" : String(bps / 100));

function PctInput({ label, value, onChange }: { label: string; value: number | undefined; onChange: (bps: number | undefined) => void }) {
  return (
    <label className="field small"><span>{label}</span>
      <input type="number" step="0.01" min="0" max="100" aria-label={label} value={num(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : toBps(e.target.value))} />
    </label>
  );
}

/**
 * 분배 규칙 폼(원천 문서 설계 S2): 권리자가 MDRL 없이 분배 규칙을 만든다. 바꿀 때마다 엔진이 대표 조합의 매출 한 건을 계산해 보여 주고,
 * 쉬운 말 설명과 활성 버전 대비 바뀐 점을 함께 보여 준다. "MDRL로 만들기"를 누르면 아래 편집기에 텍스트가 들어가고, 컴파일은 기존 절차대로 한다.
 */
export function PolicyFormEditor({ packId, text, baseText, onText }: { packId: string; text: string; baseText: string | undefined; onText: (t: string) => void }) {
  const [form, setForm] = useState<PolicyForm>(() => defaultForm(packId));
  const [amount, setAmount] = useState("3300");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [base, setBase] = useState<PolicyForm | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => { setForm((f) => ({ ...f, packId })); }, [packId]);
  useEffect(() => {
    if (!baseText) { setBase(null); return; }
    void api<{ form: PolicyForm | null }>("POST", "/policies/form/parse", { sourceText: baseText }).then((r) => setBase(r.form), () => setBase(null));
  }, [baseText]);
  useEffect(() => {
    if (!form.packId) return;
    const t = setTimeout(() => {
      void api<Preview>("POST", "/policies/preview", { packId: form.packId, form, amountKrw: amount }).then((p) => { setPreview(p); setErr(null); }, (e) => setErr(e as ApiError));
    }, 300);
    return () => clearTimeout(t);
  }, [form, amount]);

  const loadFromText = async () => {
    try {
      const r = await api<{ form: PolicyForm | null; reason?: string }>("POST", "/policies/form/parse", { sourceText: text });
      if (r.form) { setForm(r.form); setNote("편집기의 MDRL을 폼으로 불러왔습니다."); } else setNote(`폼으로 나타낼 수 없는 정책입니다(고급 모드): ${r.reason ?? ""}`);
      setErr(null);
    } catch (e) { setErr(e as ApiError); }
  };
  const toText = async () => {
    try { const r = await api<{ sourceText: string }>("POST", "/policies/form/text", { form }); onText(r.sourceText); setNote("MDRL을 편집기에 넣었습니다. 컴파일하세요."); setErr(null); } catch (e) { setErr(e as ApiError); }
  };
  const set = (patch: (f: PolicyForm) => void) => setForm((f) => { const n = structuredClone(f); patch(n); return n; });
  const p = form.performer;
  const changes = base ? formDiff(base, form) : null;

  return (
    <Section title="분배 규칙 폼" actions={<>
      <button type="button" className="btn" disabled={!text} onClick={() => void loadFromText()}>편집기에서 불러오기</button>
      <button type="button" className="btn primary" disabled={!form.packId} onClick={() => void toText()}>MDRL로 만들기</button>
    </>}>
      {note && <p className="muted" role="status">{note}</p>}
      <div className="inline-form">
        <span>대상 매출</span>
        {(["PRIMARY", "RESALE", "TRAFFIC"] as const).map((e) => (
          <label key={e} className="small"><input type="checkbox" aria-label={`대상 매출 ${e}`} checked={form.events.includes(e)}
            onChange={(x) => set((f) => { f.events = x.target.checked ? [...f.events, e] : f.events.filter((y) => y !== e); })} /> {{ PRIMARY: "구매", RESALE: "재판매", TRAFFIC: "감상" }[e]}</label>
        ))}
      </div>
      <div className="inline-form">
        <PctInput label="1차 플랫폼(%)" value={form.tier1.platformBps} onChange={(v) => set((f) => { f.tier1.platformBps = v ?? 0; })} />
        <PctInput label="1차 운영(%)" value={form.tier1.opsBps} onChange={(v) => set((f) => { f.tier1.opsBps = v ?? 0; })} />
        <PctInput label="1차 권리자(%)" value={form.tier1.rightsBps} onChange={(v) => set((f) => { f.tier1.rightsBps = v ?? 0; })} />
      </div>
      <div className="inline-form">
        <PctInput label="2차 녹음(%)" value={form.master.bps} onChange={(v) => set((f) => { f.master.bps = v ?? 0; })} />
        <PctInput label="2차 실연(%)" value={p.bps} onChange={(v) => set((f) => { f.performer.bps = v ?? 0; })} />
        <PctInput label="2차 작품(%)" value={form.work.bps} onChange={(v) => set((f) => { f.work.bps = v ?? 0; })} />
        <label className="small"><input type="checkbox" aria-label="작품 몫 위임 수령" checked={form.work.viaMandate} onChange={(e) => set((f) => { f.work.viaMandate = e.target.checked; })} /> 작품 몫은 위임받은 곳이 받음</label>
      </div>
      <div className="inline-form">
        <label className="field small"><span>실연 나누는 방식</span>
          <select aria-label="실연 나누는 방식" value={p.mode} onChange={(e) => set((f) => { f.performer.mode = e.target.value as PolicyForm["performer"]["mode"]; })}>
            <option value="HYBRID">고정 + 부른 시간 비례</option><option value="USAGE_WEIGHTED">부른 시간 비례</option>
            <option value="FIXED">참여 멤버 균등</option><option value="MEMBER_PCT">팬이 정한 멤버 비율</option>
          </select>
        </label>
        {p.mode === "HYBRID" && <>
          <PctInput label="실연 고정분(%)" value={p.fixedBps} onChange={(v) => set((f) => { f.performer.fixedBps = v; })} />
          <PctInput label="실연 시간 비례분(%)" value={p.usageBps} onChange={(v) => set((f) => { f.performer.usageBps = v; })} />
        </>}
        <PctInput label="주실연 가중(%)" value={p.featuredWeightBps} onChange={(v) => set((f) => { f.performer.featuredWeightBps = v; })} />
        <PctInput label="실연 1인 상한(%)" value={p.capBps} onChange={(v) => set((f) => { f.performer.capBps = v; })} />
        <label className="small"><input type="checkbox" aria-label="실연 몫 위임 수령" checked={p.viaMandate} onChange={(e) => set((f) => { f.performer.viaMandate = e.target.checked; })} /> 위임이 있으면 위임받은 쪽이 받음</label>
      </div>
      <ErrorPanel error={err} />
      {preview && <>
        {preview.diagnostics.length > 0 && (
          <ul className="bad" aria-label="폼 진단">{preview.diagnostics.map((d) => <li key={d.path + d.code}>{d.message}</li>)}</ul>
        )}
        {preview.explanation && <div aria-label="쉬운 말 설명">{preview.explanation.map((l) => <p key={l}>{l}</p>)}</div>}
        {preview.combination && preview.parties.length > 0 && (
          <div>
            <label className="field small"><span>예시 금액(원)</span><input aria-label="예시 금액" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} /></label>
            <p className="muted">
              {preview.combination.source === "ISSUED" ? `최근 발행 조합 ${preview.combination.vcId}` : "기본 조합(슬롯마다 다른 멤버)"}의 매출 {Number(preview.amountKrw).toLocaleString()}원 1건 ·{" "}
              {preview.pools.map((x) => `${x.bucket} ${Number(x.amount).toLocaleString()}`).join(" · ")}
            </p>
            <table className="data" aria-label="예시 계산">
              <thead><tr><th scope="col">받는 곳</th><th scope="col">역할</th><th scope="col">몫</th><th scope="col">금액(원)</th></tr></thead>
              <tbody>{preview.parties.map((x) => <tr key={`${x.partyId}${x.bucket}${x.role}`}><td>{x.name}</td><td>{x.role}</td><td>{x.bucket}</td><td>{Number(x.amount).toLocaleString()}</td></tr>)}
                {preview.holdings.map((h) => <tr key={`h${h.bucket}${h.reason}`}><td>보류</td><td>{h.reason}</td><td>{h.bucket}</td><td>{Number(h.amount).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </>}
      {changes && (
        <div aria-label="활성 버전과 비교">
          <h3>활성 버전과 비교</h3>
          {changes.length === 0 ? <p className="muted">바뀐 항목이 없습니다.</p>
            : <ul>{changes.map((c) => <li key={c.label}>{c.label}: {c.before} → {c.after}</li>)}</ul>}
        </div>
      )}
      <p className="muted small">비율 합계: 1차 {pct(form.tier1.platformBps + form.tier1.opsBps + form.tier1.rightsBps)}, 2차 {pct(form.master.bps + p.bps + form.work.bps + form.contracts.reduce((a, c) => a + c.bps, 0))}</p>
    </Section>
  );
}
