import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Paged } from "../../../api/client.ts";
import { useGet } from "../../../api/hooks.ts";
import { createPack, setClaimants, type Declared } from "../../../api/issuance.ts";
import { compilePolicy } from "../../../api/policy.ts";
import { defaultForm, type PolicyForm } from "../../../api/policyForm.ts";
import type { PackDetailData, PackRow, PolicyRow, PolicyVersionDetail } from "../../../api/types.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { authorsPending, currentClaims, previewLines, slugId, sungSeconds } from "../model.ts";
import { useReadiness, useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

export const RELEASE_STEPS = ["① 정합성 점검", "② 팩(상품)", "③ 분배 규칙", "④ 승인", "⑤ 활성화", "⑥ 출시"] as const;
/** 출시 단계 칸(시안: 완료 = 초록, 지금 = 2px 주색, 남음 = 점선). */
export function ReleaseSteps({ now }: { now: number }) {
  return <ol className="p-steps" aria-label="출시 단계">{RELEASE_STEPS.map((s, i) => <li key={s} className={i < now ? "done" : i === now ? "now" : ""} aria-current={i === now ? "step" : undefined}>{s}</li>)}</ol>;
}

type Validation = { counts: { block: number; warn: number }; issues: { status: string; severity: string; rule: string; message: string }[] };
type PolicyTemplate = { templateId: string; version: number; title: string; status: string; form: Omit<PolicyForm, "packId"> };

/** 이 곡의 팩과 분배 규칙(팩이 여럿이면 활성 → 먼저 만든 순). */
export function usePackAndPolicy(scopeId: string) {
  const packs = useGet<Paged<PackRow>>(["work-packs"], "/packs?limit=200", { enabled: scopeId !== "" });
  const pack = (packs.data?.items ?? []).filter((p) => p.factsScopeId === scopeId).sort((a, b) => (a.status === "ACTIVE" ? -1 : b.status === "ACTIVE" ? 1 : a.createdAt < b.createdAt ? -1 : 1))[0];
  const detail = useGet<PackDetailData>(["work-packs", pack?.packId], `/packs/${encodeURIComponent(pack?.packId ?? "")}`, { enabled: !!pack });
  const policies = useGet<Paged<PolicyRow>>(["work-policies", pack?.packId], `/policies?pack=${encodeURIComponent(pack?.packId ?? "")}`, { enabled: !!pack });
  const policy = policies.data?.items[0];
  return { packs, pack, detail, policies, policy, error: packs.error ?? detail.error ?? policies.error };
}

/** 원곡 권리에서 청구권자 제안: 레이블 MASTER_OWNER, 실연 수령 위임을 받는 쪽 AGENCY, 멤버 PERFORMER_FEATURED, 작가 WORK_AUTHOR. */
export function proposeClaimants(ctx: WsCtx): Declared[] {
  const cur = currentClaims(ctx.facts.claims);
  const uniq = (xs: string[]) => [...new Set(xs)];
  const agencies = uniq(ctx.facts.mandates.filter((m) => m.supersededAt === null && m.rightKind === "PERFORMER").map((m) => m.toPartyId));
  return [
    ...uniq(cur.filter((c) => c.edge === "CONTROLLED_BY").map((c) => c.targetId)).map((party) => ({ role: "MASTER_OWNER", party })),
    ...agencies.map((party) => ({ role: "AGENCY", party })),
    ...uniq(cur.filter((c) => c.edge === "OWNED_BY").map((c) => c.targetId)).map((party) => ({ role: "PERFORMER_FEATURED", party })),
    ...uniq(cur.filter((c) => c.edge === "WRITTEN_BY").map((c) => c.targetId)).map((party) => ({ role: "WORK_AUTHOR", party })),
  ];
}
const claimantText = (xs: { role: string }[]) => {
  const n = (r: string) => xs.filter((x) => x.role === r).length;
  return [n("MASTER_OWNER") && "레이블(마스터)", n("AGENCY") && "소속사(수령 위임)", n("PERFORMER_FEATURED") && `멤버 ${n("PERFORMER_FEATURED")}(주 실연)`, n("WORK_AUTHOR") && `작가 ${n("WORK_AUTHOR")}(작품)`].filter(Boolean).join(" · ");
};

/** 멤버 순서(시안: 정국 · 지민 · 뷔 · 진 · RM · 제이홉 · 슈가)대로 다시 담는다. */
const ordered = (sung: Record<string, number>, order: string[]) => Object.fromEntries([...order.filter((k) => k in sung), ...Object.keys(sung).filter((k) => !order.includes(k))].map((k) => [k, sung[k]!]));

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr)", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--p-head-bg)", fontSize: 14 }}><span className="p-todo">{label}</span><div>{children}</div></div>;
}
function Pct({ label, bps, onChange }: { label: string; bps: number | undefined; onChange: (bps: number) => void }) {
  return <input aria-label={label} className="p-input sm" style={{ width: 64, textAlign: "right" }} value={bps === undefined ? "" : bps / 100} onChange={(e) => onChange(Math.round(Number(e.target.value) * 100))} />;
}
const sumOk = (n: number) => <span className={n === 10000 ? "p-ok" : "p-bad"}>합계 {n / 100}%</span>;

/**
 * 분배 규칙·팩 탭(시안 Song-Policy.dc.html): 출시 단계 · ① 정합성 점검 · ② 팩(상품) · ③ 분배 규칙 — 팬앱 매출(폼), 오른쪽 미리보기(2px 주색)와 컴파일.
 */
export function PolicyTab({ ctx }: { ctx: WsCtx }) {
  const nav = useNavigate();
  const v = useGet<Validation>(["readiness", "validation", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/validation`);
  const ready = useReadiness(ctx.scopeId);
  const templates = useGet<PolicyTemplate[]>(["policy-templates"], "/policy-templates?status=APPROVED");
  const { pack, detail, policy, error } = usePackAndPolicy(ctx.scopeId);
  const latest = useGet<PolicyVersionDetail>(["policy-version", policy?.policyId, policy?.latestVersion], `/policies/${encodeURIComponent(policy?.policyId ?? "")}/versions/${policy?.latestVersion ?? 0}`, { enabled: !!policy });
  const w = useWrite();
  // 컴파일 조건(2026-10-26): 곡 진행 ①~④가 끝나야 한다(코어도 같은 조건으로 409 PROGRESS_INCOMPLETE).
  const progress = useGet<{ steps: { label: string; done: boolean }[] }>(["readiness", "progress", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/progress`);
  const blocker = progressBlocker(progress.data?.steps);
  const slug = ctx.scopeId.replace(/^fsc_/, "");
  const [packForm, setPackForm] = useState({ code: `${slug.toUpperCase().replace(/_/g, "-").slice(0, 24)}-FAN`, title: `${ctx.work.title} 팬앱 전용 보컬 조합` });
  const [form, setForm] = useState<PolicyForm>(() => ({ ...defaultForm(""), events: ["PRIMARY", "TRAFFIC"] }));
  const [text, setText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [example, setExample] = useState(0);
  // 컴파일한 규칙이 있으면 그 폼으로 연다.
  useEffect(() => {
    if (!latest.data?.sourceText) return;
    void api<{ form: PolicyForm | null }>("POST", "/policies/form/parse", { sourceText: latest.data.sourceText }).then((r) => { if (r.form) setForm(r.form); }, () => undefined);
  }, [latest.data?.sourceText]);
  const set = (patch: (f: PolicyForm) => void) => { setText(null); setForm((f) => { const n = structuredClone(f); patch(n); return n; }); };
  const proposed = proposeClaimants(ctx);
  const declared = (detail.data?.claimants ?? []).map((c) => ({ role: c.claimantRole }));
  const blocks = v.data?.counts.block ?? 0, warns = v.data?.counts.warn ?? 0;
  const item = (k: string) => ready.data?.items.find((i) => i.key === k);
  const authors = currentClaims(ctx.facts.claims).filter((c) => c.edge === "WRITTEN_BY").length;
  const masterName = currentClaims(ctx.facts.claims).filter((c) => c.edge === "CONTROLLED_BY").map((c) => ctx.name(c.targetId)).join(", ");
  const vocal = ctx.rows.filter((r) => r.kind === "VOCAL");
  const swapRow = vocal.find((r) => r.partNo === 2) ?? vocal[0];
  const swapTo = ctx.members.find((m) => !vocal.some((r) => r.slotId === swapRow?.slotId && r.original === m.partyId))?.partyId;
  const examples = [{ label: "원곡 배치", singer: (r: (typeof vocal)[number]) => r.original },
    ...(swapRow && swapTo ? [{ label: `${swapRow.section} ${ctx.name(swapRow.original!)} 파트를 ${ctx.name(swapTo)}이`, singer: (r: (typeof vocal)[number]) => (r === swapRow ? swapTo : r.original) }] : [])];
  const lines = useMemo(() => previewLines({ ...form, packId: pack?.packId ?? "" }, 3300, ordered(sungSeconds(ctx.rows, examples[example]?.singer), ctx.members.map((m) => m.partyId)), authors,
    Object.fromEntries(ctx.members.map((m) => [m.partyId, m.name]))), [form, example, ctx]); // eslint-disable-line
  const p = form.performer;
  const t1 = form.tier1.platformBps + form.tier1.opsBps + form.tier1.rightsBps;
  const t2 = form.master.bps + p.bps + form.work.bps;
  const step = blocks > 0 ? 0 : !pack ? 1 : !ctx.sealed ? 2 : 3;
  const std = (templates.data ?? []).find((x) => (x.form.performer?.bps ?? 0) > 0) ?? templates.data?.[0];
  const sourceFor = async () => text ?? (await api<{ sourceText: string }>("POST", "/policies/form/text", { form: { ...form, packId: pack!.packId } })).sourceText;
  const won = (n: number) => `${n.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}원`;
  return (
    <>
      <ReleaseSteps now={step} />
      <div className="p-cols">
        <div className="main" style={{ gap: 14 }}>
          <section className="p-card">
            <div className="p-card-head"><h2>① 정합성 점검</h2><span className={`p-badge sm ${blocks > 0 ? "bad" : warns > 0 ? "warn" : "ok"}`}>차단 {blocks} · 경고 {warns}</span></div>
            <ErrorPanel error={v.error} />
            <div className="p-row" style={{ padding: "10px 16px", fontSize: 14, gap: 16 }}>
              {(v.data?.issues ?? []).filter((i) => i.status === "OPEN" && i.severity === "BLOCK").slice(0, 2).map((i, k) => <span key={k} className="p-bad">차단: {i.message}</span>)}
              {item("confirmations")?.ok !== true && <span>경고: {authorsPending(ctx) > 0 ? `작가 지분 서명 남음 ${authorsPending(ctx)}(기한 전)` : item("confirmations")?.detail}</span>}
              <span>스템 오디오 {item("audio")?.detail}</span><span>멤버 이용 동의 {item("consents")?.detail.replace("보이스 ", "").replace(" 동의", "")}</span>
              <Link to={`/validation?scope=${encodeURIComponent(ctx.scopeId)}`} style={{ marginLeft: "auto" }}>점검 결과 전체</Link>
            </div>
          </section>
          <section className="p-card">
            <div className="p-card-head"><h2>② 팩(상품)</h2><span className={`p-badge sm ${pack?.status === "ACTIVE" ? "ok" : "muted"}`}>{!pack ? "만들기 전" : pack.status === "ACTIVE" ? "활성" : pack.status === "PAUSED" ? "일시정지" : "초안"}</span></div>
            <ErrorPanel error={error ?? w.err} />
            <div style={{ padding: "6px 16px 12px" }}>
              <Row label="팩 코드 · 이름">{pack ? <><span className="p-mono">{pack.packCode}</span> · {pack.title}</> : (
                <div className="p-row"><input aria-label="팩 코드" className="p-input sm p-mono" value={packForm.code} maxLength={32} onChange={(e) => setPackForm({ ...packForm, code: e.target.value })} />
                  <input aria-label="팩 이름" className="p-input sm" style={{ flex: "1 1 240px" }} value={packForm.title} onChange={(e) => setPackForm({ ...packForm, title: e.target.value })} />
                  <button type="button" className="p-btn sm primary" disabled={!ctx.can("pack.edit") || w.busy} title={ctx.can("pack.edit") ? undefined : "팩 편집 권한이 필요하다"} onClick={() => void w.run(async () => {
                    const packId = slugId("pak", `${slug}_fan`);
                    await createPack({ packId, packCode: packForm.code.trim(), title: packForm.title, factsScopeId: ctx.scopeId });
                    await setClaimants(packId, proposed);
                  }, "팩을 만들고 청구권자를 원곡 권리대로 선언했습니다")}>팩 만들기</button></div>
              )}</Row>
              <Row label="이용 범위">팬앱 조합·구매·감상(멤버 이용 동의 범위와 같아야 한다)</Row>
              <Row label="청구권자(원곡 권리에서 자동)">{claimantText(pack ? declared : proposed)} {pack && <button type="button" className="p-linkbtn" disabled={!ctx.can("pack.edit") || ctx.sealed} title={ctx.sealed ? "IR 생성 뒤에는 정책 재고정과 함께" : undefined}
                onClick={() => void w.run(() => setClaimants(pack.packId, proposed), "청구권자를 원곡 권리대로 다시 선언했습니다")}>고치기</button>}</Row>
            </div>
            {w.notice && <div className="p-card-foot" role="status">{w.notice}</div>}
          </section>
          <section className="p-card">
            <div className="p-card-head"><h2>③ 분배 규칙 — 팬앱 매출</h2><span style={{ marginLeft: "auto" }} />
              <button type="button" className="p-btn mid" disabled={!std || ctx.sealed} title={std ? `${std.title} 값으로 채운다` : "승인된 표준 템플릿이 없다"} onClick={() => std && set((f) => Object.assign(f, structuredClone(std.form), { packId: f.packId }))}>표준 템플릿으로</button>
              <button type="button" className="p-btn mid" aria-pressed={text !== null} disabled={!pack} onClick={() => void (text !== null ? setText(null) : sourceFor().then(setText, (e) => w.setErr(e)))}>텍스트로 보기</button></div>
            <div style={{ padding: "6px 16px 12px" }}>
              <Row label="매출 종류">{([["PRIMARY", "구매"], ["TRAFFIC", "감상(구독·광고 풀)"], ["RESALE", "재판매"]] as const).map(([e, l], i) => (
                <label key={e} style={{ marginLeft: i ? 12 : 0 }}><input type="checkbox" checked={form.events.includes(e)} onChange={(x) => set((f) => { f.events = x.target.checked ? [...f.events, e] : f.events.filter((y) => y !== e); })} /> {l}</label>))}</Row>
              <Row label="1단계">플랫폼 <Pct label="1단계 플랫폼" bps={form.tier1.platformBps} onChange={(b) => set((f) => { f.tier1.platformBps = b; })} /> % · 운영 <Pct label="1단계 운영" bps={form.tier1.opsBps} onChange={(b) => set((f) => { f.tier1.opsBps = b; })} /> % · 권리자 <Pct label="1단계 권리자" bps={form.tier1.rightsBps} onChange={(b) => set((f) => { f.tier1.rightsBps = b; })} /> % {sumOk(t1)}</Row>
              <Row label="2단계(권리자 몫 안)">녹음 <Pct label="2단계 녹음" bps={form.master.bps} onChange={(b) => set((f) => { f.master.bps = b; })} /> % · 실연 <Pct label="2단계 실연" bps={p.bps} onChange={(b) => set((f) => { f.performer.bps = b; })} /> % · 작품 <Pct label="2단계 작품" bps={form.work.bps} onChange={(b) => set((f) => { f.work.bps = b; })} /> % {sumOk(t2)}</Row>
              <Row label="녹음 몫">마스터 보유자대로({masterName || "—"})</Row>
              <Row label="실연 몫">혼합 — 참여 멤버 고정 <Pct label="실연 고정" bps={p.fixedBps} onChange={(b) => set((f) => { f.performer.mode = "HYBRID"; f.performer.fixedBps = b; })} /> % + 부른 시간 <Pct label="실연 부른 시간" bps={p.usageBps} onChange={(b) => set((f) => { f.performer.mode = "HYBRID"; f.performer.usageBps = b; })} /> % · 주 실연 가중 <Pct label="주 실연 가중" bps={p.featuredWeightBps} onChange={(b) => set((f) => { f.performer.featuredWeightBps = b; })} /> % · 1인 상한 <Pct label="1인 상한" bps={p.capBps} onChange={(b) => set((f) => { f.performer.capBps = b; })} /> % · <label><input type="checkbox" checked={p.viaMandate} onChange={(e) => set((f) => { f.performer.viaMandate = e.target.checked; })} /> 수령 위임대로</label></Row>
              <Row label="작품 몫">작가 지분대로 · <label><input type="checkbox" checked={form.work.viaMandate} onChange={(e) => set((f) => { f.work.viaMandate = e.target.checked; })} /> 수령 위임대로(신탁)</label></Row>
              {text !== null && <textarea aria-label="분배 규칙 MDRL" readOnly className="p-input p-mono" style={{ width: "100%", minHeight: 260, fontSize: 13, marginTop: 8 }} value={text} />}
            </div>
          </section>
        </div>
        <aside className="p-panel form" aria-labelledby="pv" style={{ flex: "1 1 400px", maxWidth: 470, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--p-line)" }}><h2 id="pv" style={{ margin: 0, fontSize: 18 }}>미리보기 · 구매 1건 3,300원</h2>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginTop: 8 }}>예시 조합<select className="p-select sm" value={example} onChange={(e) => setExample(Number(e.target.value))}>{examples.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}</select></label></div>
          <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }} aria-label="미리보기 근사">
            {lines.map((l, i) => <div key={l.label} style={{ display: "flex", justifyContent: "space-between", ...(i === 2 ? { fontWeight: 600, paddingTop: 6, borderTop: "1px solid var(--p-line)" } : l.level === 1 ? { color: "var(--p-fg-2)", fontSize: 13 } : {}) }}>
              <span>{l.level === 1 ? `　${l.label}` : l.label}</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{won(l.won)}</span></div>)}
            <div style={{ fontSize: 12, color: "var(--p-muted)", paddingTop: 6, borderTop: "1px solid var(--p-line)" }}>부른 시간은 MV 분석 슬롯·추정 파트 경계 기준. 실제 원 단위 배분과 반올림은 엔진 미리보기(/policies/preview)가 계산한다. 실연 몫은 수령 위임대로 소속사가 받는다.</div>
          </div>
          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--p-line)", display: "flex", flexDirection: "column", gap: 8 }}>
            {ctx.sealed ? (
              <div className="p-box info" style={{ padding: "10px 12px", borderRadius: 8, fontSize: 13 }}>IR 생성됨 — 승인·출시 탭에서 승인·활성화·출시한다. <Link to={`/works/${encodeURIComponent(ctx.work.workId)}/release`}>승인·출시로 →</Link></div>
            ) : <>
              <div className="p-box warn" style={{ padding: "10px 12px", borderRadius: 8, fontSize: 13 }}><span><b>컴파일하면 IR이 생성된다.</b> 이 곡의 권리·스템 정보가 facts로 고정되고, 원곡 권리·스템 탭은 조회만 된다(바로잡기는 새 버전).</span></div>
              {confirming ? (
                <div role="alertdialog" aria-label="컴파일 확인" className="p-row" style={{ justifyContent: "flex-end" }}>
                  <span className="p-sub" style={{ marginRight: "auto" }}>정말 컴파일할까요? 되돌릴 수 없습니다.</span>
                  <button type="button" className="p-btn mid" onClick={() => setConfirming(false)}>취소</button>
                  <button type="button" className="p-btn mid primary" disabled={w.busy} onClick={() => void w.run(async () => { await compilePolicy(policy?.policyId ?? `pol_${slug}`, pack!.packId, await sourceFor()); setConfirming(false); nav(`/works/${encodeURIComponent(ctx.work.workId)}/release`); }, "컴파일했습니다 — IR 생성")}>컴파일</button>
                </div>
              ) : (
                <div className="p-row" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="p-btn mid" disabled title="분배 규칙 초안 저장 API가 없다 — 컴파일하면 버전이 남는다">초안 저장</button>
                  <button type="button" className="p-btn mid primary" disabled={blocker !== null || !pack || !ctx.can("policy.edit") || t1 !== 10000 || t2 !== 10000} title={blocker !== null ? blocker : !pack ? "팩을 먼저 만든다" : !ctx.can("policy.edit") ? "분배 규칙 편집 권한이 필요하다" : t1 !== 10000 || t2 !== 10000 ? "단계마다 합계 100%여야 한다" : undefined} onClick={() => setConfirming(true)}>컴파일(IR 생성) → 승인으로</button>
                </div>
              )}
              {!confirming && blocker !== null && (
                <div role="status" aria-label="컴파일할 수 없는 이유" style={{ fontSize: 12.5, color: "var(--p-warn)", textAlign: "right" }}>{blocker} — 곡 진행 ①~④가 끝나야 컴파일한다</div>
              )}
            </>}
          </div>
        </aside>
      </div>
    </>
  );
}

const STEP_NO = ["①", "②", "③", "④"];
/** 받침이 있으면 "이", 없으면 "가". */
const iga = (w: string) => { const c = w.charCodeAt(w.length - 1); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? "이" : "가"; };
/** 곡 진행 ①~④ 중 끝나지 않은 첫 단계: "③ 권리 확정이 끝나지 않았다". 다 끝났으면 null(진행을 아직 모르면 '불러오는 중'). */
export function progressBlocker(steps: { label: string; done: boolean }[] | undefined): string | null {
  if (steps === undefined) return "곡 진행을 불러오는 중";
  const i = steps.slice(0, 4).findIndex((s) => !s.done);
  return i < 0 ? null : `${STEP_NO[i]} ${steps[i]!.label}${iga(steps[i]!.label)} 끝나지 않았다`;
}
