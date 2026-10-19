import { useState } from "react";
import { useNavigate } from "react-router";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import type { Me } from "../../api/admin.ts";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Section } from "../../components/Section.tsx";

type Template = { templateId: string; version: number; title: string; description: string; status: string; seeded: boolean; explanation: string[] };

/**
 * 표준 분배 규칙 템플릿(테넌트 정책 결정 TD13). 법무가 승인한 템플릿을 값 그대로 써서 정책을 만든다.
 * 1인 테넌트(독립 아티스트)는 이렇게 만든 정책만 혼자 승인·활성화할 수 있다. 값을 바꾸려면 일반 편집기로 만들고 직무 분리를 따른다.
 */
export function PolicyTemplates() {
  const me = useGet<Me>(["me"], "/me");
  const list = useGet<Template[]>(["policy-templates"], "/policy-templates?status=APPROVED");
  const packs = useGet<{ items: { packId: string; title: string }[] }>(["packs", "template"], "/packs?limit=200");
  const [pick, setPick] = useState<{ templateId: string; packId: string; policyId: string }>({ templateId: "", packId: "", policyId: "pol_" });
  const [err, setErr] = useState<ApiError | null>(null);
  const nav = useNavigate();
  const indie = me.data?.tenantType === "INDEPENDENT_ARTIST";
  const create = async () => {
    try {
      const r = await api<{ policyId: string }>("POST", `/policies/${encodeURIComponent(pick.policyId)}/from-template`, { packId: pick.packId, templateId: pick.templateId });
      setErr(null); nav(`/policy/${encodeURIComponent(r.policyId)}`);
    } catch (e) { setErr(e as ApiError); }
  };
  return (
    <Section title="표준 템플릿으로 만들기">
      <p className="muted">{indie
        ? "1인 테넌트는 법무가 승인한 표준 템플릿을 값 그대로 쓰면 혼자 승인·활성화할 수 있습니다(템플릿 승인이 두 번째 확인입니다). 값을 바꾸면 다른 사람의 승인이 필요합니다."
        : "법무가 승인한 표준 분배 규칙입니다. 값 그대로 정책을 만들 수 있습니다. 편집·승인·활성화는 여전히 서로 다른 사람이 합니다."}</p>
      <ErrorPanel error={list.error ?? err} />
      <ul className="plain">
        {(list.data ?? []).map((t) => (
          <li key={`${t.templateId}@${t.version}`} className="card" style={{ marginBottom: 8, minWidth: 0 }}>
            <label className="check">
              <input type="radio" name="tpl" checked={pick.templateId === t.templateId} onChange={() => setPick({ ...pick, templateId: t.templateId })} />
              <strong style={{ fontSize: 15 }}>{t.title}</strong> <span className="muted small">{t.templateId} v{t.version}{t.seeded ? " · 법무 초안" : ""}</span>
            </label>
            <span className="small">{t.description}</span>
            <ul className="small">{t.explanation.map((x) => <li key={x}>{x}</li>)}</ul>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="field"><span>팩</span>
          <select aria-label="템플릿 팩" value={pick.packId} onChange={(e) => setPick({ ...pick, packId: e.target.value })}>
            <option value="">선택…</option>{(packs.data?.items ?? []).map((p) => <option key={p.packId} value={p.packId}>{p.title} ({p.packId})</option>)}
          </select></label>
        <label className="field"><span>새 정책 id</span><input aria-label="템플릿 정책 id" value={pick.policyId} onChange={(e) => setPick({ ...pick, policyId: e.target.value })} /></label>
        <button type="submit" className="btn primary" disabled={pick.templateId === "" || pick.packId === "" || pick.policyId.length < 5}>템플릿으로 정책 만들기</button>
      </form>
    </Section>
  );
}
