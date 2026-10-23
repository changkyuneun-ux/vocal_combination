import { useState } from "react";
import { api, type ApiError } from "../../api/client.ts";
import { useGet } from "../../api/hooks.ts";
import { LINK_STATUS_LABEL, LINK_TYPE_LABEL, type AssetMapping, type LinkRow, type OrgRef } from "../../api/admin.ts";
import { DataTable } from "../../components/DataTable.tsx";
import { ErrorPanel } from "../../components/ErrorPanel.tsx";
import { Instant } from "../../components/Instant.tsx";
import { Section } from "../../components/Section.tsx";
import { currentApp } from "../../app/apps.ts";

/**
 * 연결(테넌트 정책 4절, 결정 TD10): 신탁 연결(작가 ↔ 신탁단체)과 유통 연결(권리 테넌트 ↔ 유통 파트너).
 * 한쪽이 제안하고 다른 쪽이 확인해야 활성이 된다. 누가 확인할 수 있는지는 코어가 정한다(NOT_THE_COUNTERPARTY).
 */
const LINK_TONE: Record<string, string> = { PROPOSED: "info", ACTIVE: "ok", DECLINED: "bad", ENDED: "muted" };
const newId = (p: string) => `${p}_${Date.now().toString(36)}`;
const dayIso = (d: string) => `${d}T00:00:00.000Z`;

export function LinksTable({ links, reload, side }: { links: LinkRow[]; reload: () => void; side: "RIGHTS" | "PARTICIPANT" | "PLATFORM" }) {
  const [err, setErr] = useState<ApiError | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); reload(); } catch (e) { setErr(e as ApiError); } };
  const ask = (label: string) => window.prompt(label)?.trim() ?? "";
  return (
    <>
      <ErrorPanel error={err} />
      <DataTable<LinkRow> rows={links} empty="연결이 없습니다." columns={[
        { key: "type", label: "종류", render: (l) => <>{LINK_TYPE_LABEL[l.linkType]}<div className="muted small"><code>{l.linkId}</code></div></> },
        { key: "who", label: "연결", render: (l) => (l.linkType === "TRUST"
          ? <>작가 <strong>{l.authorName ?? l.authorPartyId}</strong> → 신탁단체 <strong>{l.participantName}</strong>{l.memberRef && <div className="muted small">회원번호 {l.memberRef}</div>}</>
          : <>권리 테넌트 <strong>{l.rightsTenantName ?? l.rightsTenantId}</strong> ↔ 유통 파트너 <strong>{l.participantName}</strong></>) },
        { key: "period", label: "기간", render: (l) => <>{l.validFrom.slice(0, 10)} ~ {l.validTo ? l.validTo.slice(0, 10) : "계속"}</> },
        { key: "status", label: "상태", render: (l) => <><span className={`badge ${LINK_TONE[l.status] ?? "muted"}`}>{LINK_STATUS_LABEL[l.status] ?? l.status}</span>
          <div className="muted small">{l.proposedSide === "RIGHTS" ? "권리 쪽 제안" : "참여 기관 요청"} · <Instant iso={l.proposedAt} />{l.declineReason && <> · {l.declineReason}</>}{l.endReason && <> · {l.endReason}</>}</div></> },
        { key: "act", label: "", render: (l) => (
          <div className="row-actions">
            {l.status === "PROPOSED" && (side === "PLATFORM" || l.proposedSide !== side) && <>
              <button type="button" className="btn tiny primary" onClick={() => void act(() => api("POST", `/links/${l.linkId}/confirm`))}>확인</button>
              <button type="button" className="btn tiny" onClick={() => { const r = ask("거절 사유"); void act(() => api("POST", `/links/${l.linkId}/decline`, { reason: r })); }}>거절</button>
            </>}
            {(l.status === "ACTIVE" || l.status === "PROPOSED") && (
              <button type="button" className="btn tiny danger" onClick={() => { const r = ask("연결을 끝내는 사유(그 뒤 발행·정산부터 반영)"); if (r) void act(() => api("POST", `/links/${l.linkId}/end`, { reason: r })); }}>끝내기</button>
            )}
          </div>
        ) },
      ]} />
    </>
  );
}

/** 신탁 연결 제안·요청: 권리 테넌트·플랫폼은 작가와 신탁단체를, 신탁단체는 작가를 고른다. */
export function TrustForm({ side, onDone }: { side: "RIGHTS" | "PARTICIPANT" | "PLATFORM"; onDone: () => void }) {
  const authors = useGet<{ items: { partyId: string; displayName: string; tenantId: string }[] }>(["parties", "AUTHOR"], `/parties?type=AUTHOR&limit=200${side === "PLATFORM" ? "&tenant=tnt_platform" : ""}`);
  const cmos = useGet<OrgRef[]>(["participants"], "/participants", { enabled: side !== "PARTICIPANT" });
  const [f, setF] = useState({ author: "", cmo: "", memberRef: "", from: "2026-01-01" });
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api<LinkRow>("POST", "/links", { linkId: newId("lnk_trust"), linkType: "TRUST", authorPartyId: f.author, ...(side !== "PARTICIPANT" && { participantTenantId: f.cmo }),
        ...(f.memberRef.trim() && { memberRef: f.memberRef.trim() }), validFrom: dayIso(f.from) });
      setErr(null); setDone(r.linkId); onDone();
    } catch (e) { setErr(e as ApiError); setDone(null); }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="form-grid">
        <label className="field"><span>작가</span>
          <select aria-label="작가" value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })}>
            <option value="">선택…</option>{(authors.data?.items ?? []).map((a) => <option key={a.partyId} value={a.partyId}>{a.displayName} ({a.partyId})</option>)}
          </select></label>
        {side !== "PARTICIPANT" && <label className="field"><span>신탁단체</span>
          <select aria-label="신탁단체" value={f.cmo} onChange={(e) => setF({ ...f, cmo: e.target.value })}>
            <option value="">선택…</option>{(cmos.data ?? []).filter((c) => c.tenantType === "CMO").map((c) => <option key={c.tenantId} value={c.tenantId}>{c.name}</option>)}
          </select></label>}
        <label className="field"><span>회원번호·IPI(선택)</span><input aria-label="회원번호" value={f.memberRef} onChange={(e) => setF({ ...f, memberRef: e.target.value })} /></label>
        <label className="field"><span>신탁 시작일</span><input type="date" aria-label="신탁 시작일" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
      </div>
      <div><button type="submit" className="btn primary" disabled={f.author === "" || (side !== "PARTICIPANT" && f.cmo === "")}>{side === "PARTICIPANT" ? "신탁 연결 요청" : "신탁 연결 제안"}</button></div>
      <p className="muted small">{side === "PARTICIPANT" ? "작가의 관리 주체(권리 테넌트·본인)가 확인하면 활성이 됩니다." : "신탁단체가 확인하면 활성이 되고, 그 작가의 작품 몫은 신탁단체가 받도록 위임이 자동으로 기록됩니다(정책이 작품 몫을 위임대로 보내야 합니다)."}</p>
      <ErrorPanel error={err} />
      {done && <p role="status">연결 <code>{done}</code>을(를) 만들었습니다. 상대가 확인하면 활성이 됩니다.</p>}
    </form>
  );
}

/** 유통 연결 제안: 권리 테넌트는 유통 파트너를, 유통 파트너는 권리 테넌트를 고른다. */
export function DistributionForm({ side, onDone }: { side: "RIGHTS" | "PARTICIPANT"; onDone: () => void }) {
  const others = useGet<OrgRef[]>([side === "RIGHTS" ? "participants" : "rights-tenants"], side === "RIGHTS" ? "/participants" : "/rights-tenants");
  const [f, setF] = useState({ other: "", from: "2026-01-01" });
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async () => {
    try {
      const r = await api<LinkRow>("POST", "/links", { linkId: newId("lnk_dist"), linkType: "DISTRIBUTION", ...(side === "RIGHTS" ? { participantTenantId: f.other } : { rightsTenantId: f.other }), validFrom: dayIso(f.from) });
      setErr(null); setDone(r.linkId); onDone();
    } catch (e) { setErr(e as ApiError); setDone(null); }
  };
  const list = (others.data ?? []).filter((o) => side === "PARTICIPANT" || o.tenantType === "B2B_PARTNER");
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="form-grid">
        <label className="field"><span>{side === "RIGHTS" ? "유통 파트너" : "권리 테넌트"}</span>
          <select aria-label="상대 조직" value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })}>
            <option value="">선택…</option>{list.map((o) => <option key={o.tenantId} value={o.tenantId}>{o.name}</option>)}
          </select></label>
        <label className="field"><span>유통 계약 시작일</span><input type="date" aria-label="유통 계약 시작일" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
      </div>
      <div><button type="submit" className="btn primary" disabled={f.other === ""}>유통 연결 제안</button></div>
      <ErrorPanel error={err} />
      {done && <p role="status">연결 <code>{done}</code>을(를) 만들었습니다. 상대가 확인하면 활성이 됩니다.</p>}
    </form>
  );
}

/** 상품 대응(유통): 파트너가 제안하고 권리 테넌트가 확인한다. 확인된 대응만 리포트 적용에 쓰인다. */
export function AssetMappings({ side }: { side: "RIGHTS" | "PARTICIPANT" | "PLATFORM" }) {
  const list = useGet<AssetMapping[]>(["asset-mappings"], "/asset-mappings");
  const [err, setErr] = useState<ApiError | null>(null);
  const [f, setF] = useState({ externalId: "", vcId: "" });
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); setErr(null); void list.refetch(); } catch (e) { setErr(e as ApiError); } };
  return (
    <>
      <ErrorPanel error={list.error ?? err} />
      <DataTable<AssetMapping> rows={list.data ?? []} empty="상품 대응이 없습니다." columns={[
        { key: "partner", label: "파트너", render: (a) => a.partnerName },
        { key: "ext", label: "파트너 상품 코드", render: (a) => <code>{a.externalId}</code> },
        { key: "vc", label: "조합", render: (a) => <code>{a.vcId}</code> },
        { key: "status", label: "상태", render: (a) => <span className={`badge ${a.status === "CONFIRMED" ? "ok" : a.status === "PROPOSED" ? "info" : "bad"}`}>{a.status === "CONFIRMED" ? "확인" : a.status === "PROPOSED" ? "확인 대기" : "거절"}</span> },
        { key: "at", label: "제안", render: (a) => <Instant iso={a.createdAt} /> },
        { key: "act", label: "", render: (a) => (side === "RIGHTS" && a.status === "PROPOSED" ? (
          <div className="row-actions">
            <button type="button" className="btn tiny primary" onClick={() => void act(() => api("POST", `/asset-mappings/${a.partnerTenantId}/${encodeURIComponent(a.externalId)}/confirm`))}>확인</button>
            <button type="button" className="btn tiny" onClick={() => void act(() => api("POST", `/asset-mappings/${a.partnerTenantId}/${encodeURIComponent(a.externalId)}/decline`))}>거절</button>
          </div>) : null) },
      ]} />
      {side === "PARTICIPANT" && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api("POST", "/asset-mappings", f); setF({ externalId: "", vcId: "" }); }); }}>
          <label className="field"><span>우리 상품 코드</span><input aria-label="상품 코드" value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} placeholder="SKU-0001" /></label>
          <label className="field"><span>조합 id</span><input aria-label="조합 id" value={f.vcId} onChange={(e) => setF({ ...f, vcId: e.target.value })} placeholder="vc_bts_orig" /></label>
          <button type="submit" className="btn primary" disabled={f.externalId.trim() === "" || f.vcId.trim() === ""}>대응 제안</button>
        </form>
      )}
    </>
  );
}

/** 연결 화면(포털·참여 기관·운영 공통). */
export function LinksPage() {
  const app = currentApp();
  const me = useGet<{ tenantType?: string; orgClass?: string }>(["me"], "/me");
  const links = useGet<LinkRow[]>(["links"], "/links");
  const side = app === "ops" ? "PLATFORM" : app === "partner" ? "PARTICIPANT" : "RIGHTS";
  const isCmo = me.data?.tenantType === "CMO";
  const isDist = me.data?.tenantType === "B2B_PARTNER";
  const reload = () => void links.refetch();
  return (
    <>
      <Section title="연결">
        <p className="muted">
          {side === "PARTICIPANT" ? "참여 기관은 권리를 만들지 않고, 양쪽이 확인한 연결로만 권리·정산에 닿습니다. 연결된 기록 중 위임받은 일에 필요한 항목만 보입니다."
            : side === "PLATFORM" ? "플랫폼은 연결의 쪽이 아닙니다. 신탁 연결은 작가를 관리하는 권리 테넌트(또는 본인)와 신탁단체가 제안·확인합니다."
            : "신탁단체·유통 파트너와의 연결입니다. 한쪽이 제안하고 다른 쪽이 확인해야 활성이 됩니다. 끊으면 그 뒤 발행·정산부터 반영됩니다."}
        </p>
        <ErrorPanel error={links.error} />
        <LinksTable links={links.data ?? []} reload={reload} side={side} />
      </Section>
      {(side === "RIGHTS" || side === "PLATFORM" || isCmo) && (
        <Section title={isCmo ? "신탁 연결 요청" : "신탁 연결 제안"}><TrustForm side={side} onDone={reload} /></Section>
      )}
      {(side === "RIGHTS" || isDist) && <Section title="유통 연결 제안"><DistributionForm side={side === "RIGHTS" ? "RIGHTS" : "PARTICIPANT"} onDone={reload} /></Section>}
      {(side === "RIGHTS" || isDist || side === "PLATFORM") && <Section title="상품 대응(유통)"><AssetMappings side={side} /></Section>}
    </>
  );
}
