import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Paged } from "../../../api/client.ts";
import { useGet } from "../../../api/hooks.ts";
import { createPack, setClaimants, type Declared } from "../../../api/issuance.ts";
import { compilePolicy } from "../../../api/policy.ts";
import { defaultForm, type PolicyForm } from "../../../api/policyForm.ts";
import type { PackDetailData, PackRow, PolicyRow } from "../../../api/types.ts";
import { ErrorPanel } from "../../../components/ErrorPanel.tsx";
import { Section } from "../../../components/Section.tsx";
import { PolicyFormEditor } from "../../policy/PolicyFormEditor.tsx";
import { currentClaims, previewLines, slugId, sungSeconds } from "../model.ts";
import { useWrite } from "../data.tsx";
import type { WsCtx } from "../Workspace.tsx";

export const RELEASE_STEPS = ["① 정합성 점검", "② 팩(상품)", "③ 분배 규칙", "④ 승인", "⑤ 활성화", "⑥ 출시"] as const;
export function ReleaseSteps({ now }: { now: number }) {
  return <ol className="steps" aria-label="출시 단계">{RELEASE_STEPS.map((s, i) => <li key={s} className={i < now ? "done" : i === now ? "now" : ""} aria-current={i === now ? "step" : undefined}>{s}</li>)}</ol>;
}

type Validation = { counts: { block: number; warn: number }; issues: { status: string; severity: string; rule: string; message: string }[] };
type PolicyTemplate = { templateId: string; version: number; title: string; description: string; status: string; form: Omit<PolicyForm, "packId"> };

/** 이 곡의 팩과 분배 규칙(팩이 여럿이면 활성 → 먼저 만든 순). */
export function usePackAndPolicy(scopeId: string) {
  const packs = useGet<Paged<PackRow>>(["work-packs"], "/packs?limit=200");
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
const ROLE_KO: Record<string, string> = { MASTER_OWNER: "마스터", AGENCY: "수령 위임", PERFORMER_FEATURED: "주 실연", WORK_AUTHOR: "작품" };

/**
 * 분배 규칙·팩 탭(시안 Song-Policy, P6): ① 정합성 점검 요약 ② 팩(청구권자는 원곡 권리에서 자동 제안) ③ 분배 규칙 폼(기존 폼, 엔진 미리보기 포함),
 * 오른쪽에 예시 조합 근사 미리보기와 컴파일(IR 생성) 확인. 컴파일하면 이 곡의 권리·스템이 facts로 고정되고 권리·스템 탭은 조회만 된다.
 */
export function PolicyTab({ ctx }: { ctx: WsCtx }) {
  const nav = useNavigate();
  const v = useGet<Validation>(["readiness", "validation", ctx.scopeId], `/scopes/${encodeURIComponent(ctx.scopeId)}/validation`);
  const templates = useGet<PolicyTemplate[]>(["policy-templates"], "/policy-templates?status=APPROVED");
  const { pack, detail, policy, error } = usePackAndPolicy(ctx.scopeId);
  const w = useWrite();
  const slug = ctx.scopeId.replace(/^fsc_/, "");
  const [packForm, setPackForm] = useState({ code: slug.toUpperCase().replace(/_/g, "-").slice(0, 24) + "-FAN", title: `${ctx.work.title} 팬앱 전용 보컬 조합` });
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const [tpl, setTpl] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [example, setExample] = useState(0);
  const proposed = proposeClaimants(ctx);
  const declared = detail.data?.claimants ?? [];
  const policyId = policy?.policyId ?? `pol_${slug}`;
  const blocks = v.data?.counts.block ?? 0, warns = v.data?.counts.warn ?? 0;
  // 예시 조합: 원곡 배치, 그리고 보컬 파트가 둘 이상인 첫 슬롯의 파트 2를 다른 멤버가(근사).
  const vocal = ctx.rows.filter((r) => r.kind === "VOCAL");
  const swapRow = vocal.find((r) => r.partNo === 2) ?? vocal[0];
  const swapTo = ctx.members.find((m) => m.partyId !== swapRow?.original && !vocal.some((r) => r.slotId === swapRow?.slotId && r.original === m.partyId))?.partyId;
  const examples = [{ label: "원곡 배치", singer: (r: typeof vocal[number]) => r.original },
    ...(swapRow && swapTo ? [{ label: `${swapRow.section} ${ctx.name(swapRow.original!)} 파트를 ${ctx.name(swapTo)}이`, singer: (r: typeof vocal[number]) => (r === swapRow ? swapTo : r.original) }] : [])];
  const lines = useMemo(() => {
    const sung = sungSeconds(ctx.rows, examples[example]?.singer);
    const authors = currentClaims(ctx.facts.claims).filter((c) => c.edge === "WRITTEN_BY").length;
    return previewLines({ ...defaultForm(pack?.packId ?? ""), packId: pack?.packId ?? "" }, 3300, sung, authors, Object.fromEntries(ctx.members.map((m) => [m.partyId, m.name])));
  }, [ctx, example, pack?.packId]);
  const step = blocks > 0 ? 0 : !pack ? 1 : !ctx.sealed ? 2 : 3;
  return (
    <>
      <ReleaseSteps now={step} />
      <div className="ws-grid">
        <div>
          <Section title="① 정합성 점검">
            <ErrorPanel error={v.error} />
            <p><span className={blocks > 0 ? "mark-bad" : "mark-ok"}>차단 {blocks}</span> · <span className={warns > 0 ? "mark-warn" : "mark-ok"}>경고 {warns}</span></p>
            <ul className="plain small">{(v.data?.issues ?? []).filter((i) => i.status === "OPEN" && i.severity === "BLOCK").slice(0, 5).map((i, k) => <li key={k}><span className="mark-bad">✕</span> {i.message}</li>)}</ul>
            <Link to={`/validation?scope=${encodeURIComponent(ctx.scopeId)}`}>점검 결과 전체</Link>
          </Section>
          <Section title="② 팩(상품)" actions={pack && <span className={`badge ${pack.status === "ACTIVE" ? "ok" : "info"}`}>{pack.status === "ACTIVE" ? "활성" : pack.status === "PAUSED" ? "일시정지" : "초안"}</span>}>
            <ErrorPanel error={error ?? w.err} />
            {w.notice && <p role="status" className="muted">{w.notice}</p>}
            {!pack ? (ctx.can("pack.edit") ? (
              <div className="inline-form" aria-label="팩 만들기">
                <label className="field"><span>팩 코드</span><input value={packForm.code} maxLength={32} onChange={(e) => setPackForm({ ...packForm, code: e.target.value })} /></label>
                <label className="field"><span>팩 이름</span><input value={packForm.title} onChange={(e) => setPackForm({ ...packForm, title: e.target.value })} /></label>
                <button type="button" className="btn primary" disabled={w.busy || packForm.code.trim() === ""} onClick={() => void w.run(async () => {
                  const packId = slugId("pak", `${slug}_fan`);
                  await createPack({ packId, packCode: packForm.code.trim(), title: packForm.title, factsScopeId: ctx.scopeId });
                  await setClaimants(packId, proposed);
                }, "팩을 만들고 청구권자를 원곡 권리대로 선언했습니다")}>팩 만들기</button>
              </div>
            ) : <p className="muted">팩이 없습니다(팩 편집 권한 필요).</p>) : (
              <dl className="kv">
                <dt>팩 코드 · 이름</dt><dd><code>{pack.packCode}</code> · {pack.title}</dd>
                <dt>이용 범위</dt><dd>팬앱 조합·구매·감상(멤버 이용 동의 범위와 같아야 한다)</dd>
                <dt>청구권자</dt><dd>{declared.length === 0 ? "선언 전" : declared.map((c) => `${ctx.name(c.partyId)}(${ROLE_KO[c.claimantRole] ?? c.claimantRole})`).join(" · ")}
                  {ctx.can("pack.edit") && !ctx.sealed && <> · <button type="button" className="btn tiny" onClick={() => void w.run(() => setClaimants(pack.packId, proposed), "청구권자를 원곡 권리대로 다시 선언했습니다")}>원곡 권리대로 다시 선언</button></>}</dd>
              </dl>
            )}
          </Section>
          {pack && (
            <Section title="③ 분배 규칙 — 팬앱 매출" actions={<>
              <select aria-label="표준 템플릿" value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="">표준 템플릿 고르기</option>{(templates.data ?? []).map((t) => <option key={t.templateId} value={t.templateId}>{t.title}</option>)}
              </select>
              <button type="button" className="btn" disabled={tpl === ""} onClick={() => void w.run(async () => {
                const t = templates.data!.find((x) => x.templateId === tpl)!;
                const r = await api<{ sourceText: string }>("POST", "/policies/form/text", { form: { ...t.form, packId: pack.packId } });
                setText(r.sourceText); setShowText(true);
              }, "표준 템플릿을 규칙 텍스트로 넣었습니다(폼에 반영하려면 \"편집기에서 불러오기\")")}>표준 템플릿으로</button>
              <button type="button" className="btn" aria-pressed={showText} onClick={() => setShowText(!showText)}>텍스트로 보기</button>
            </>}>
              <PolicyFormEditor packId={pack.packId} text={text} baseText={undefined} onText={setText} />
              {showText && <label className="field"><span>MDRL</span><textarea className="mdrl" aria-label="분배 규칙 MDRL" value={text} onChange={(e) => setText(e.target.value)} /></label>}
            </Section>
          )}
        </div>
        <aside aria-label="미리보기와 컴파일">
          <Section title="미리보기 · 구매 1건 3,300원">
            <label className="field"><span>예시 조합</span>
              <select value={example} onChange={(e) => setExample(Number(e.target.value))}>{examples.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}</select>
            </label>
            <div className="lines" aria-label="미리보기 근사">{lines.map((l) => (
              <div key={l.label} className={l.level === 1 ? "sub" : ""}><span>{l.label}</span><span>{l.won.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}원</span></div>
            ))}</div>
            <p className="muted small">근사값 — 표준 비율(권리자 70 · 녹음 40 · 실연 45 · 작품 15, 실연 고정 40 + 부른 시간 60)과 파트 길이로 계산. 실제 원 단위 배분과 반올림은 왼쪽 폼의 엔진 미리보기가 계산한다.</p>
          </Section>
          {pack && !ctx.sealed && ctx.can("policy.edit") && (
            <div className="note-box warn">
              <span><b>컴파일하면 IR이 생성된다.</b> 이 곡의 권리·스템 정보가 facts로 고정되고, 원곡 권리·스템 탭은 조회만 된다(바로잡기는 새 버전).</span>
              {!confirming ? (
                <button type="button" className="btn primary" disabled={text === ""} title={text === "" ? "폼에서 \"MDRL로 만들기\"를 누르거나 표준 템플릿을 고른다" : undefined} onClick={() => setConfirming(true)}>컴파일(IR 생성) → 승인으로</button>
              ) : (
                <div role="alertdialog" aria-label="컴파일 확인" className="stack">
                  <span>정말 컴파일할까요? 되돌릴 수 없습니다.</span>
                  <div className="row-actions">
                    <button type="button" className="btn primary" disabled={w.busy} onClick={() => void w.run(async () => { await compilePolicy(policyId, pack.packId, text); setConfirming(false); nav(`/works/${encodeURIComponent(ctx.work.workId)}/release`); }, "컴파일했습니다 — IR 생성")}>컴파일</button>
                    <button type="button" className="btn" onClick={() => setConfirming(false)}>취소</button>
                  </div>
                </div>
              )}
              {text === "" && <span className="small">규칙 텍스트가 비었다 — 폼의 "MDRL로 만들기" 또는 표준 템플릿</span>}
            </div>
          )}
          {ctx.sealed && <div className="note-box"><span>IR 생성됨 — 승인·출시 탭에서 승인·활성화·출시한다.</span><Link to={`/works/${encodeURIComponent(ctx.work.workId)}/release`}>승인·출시로 →</Link></div>}
        </aside>
      </div>
    </>
  );
}
