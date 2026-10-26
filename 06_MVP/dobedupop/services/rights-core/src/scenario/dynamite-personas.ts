import { COMBINATIONS, FAN_ONLY, MEMBERS, NAMES, POLICY_TEXT, SLOTS, SOLO_ASSIGNMENTS, VOCAL_PARTS, combinationAssignments, memberBps, singersFor, slotPartInput, stemId } from "./dynamite.ts";

/**
 * Dynamite 2차 이용을 페르소나별 로그인으로 끝까지 돌리는 시나리오(MVP 진행계획 M4 시드의 바탕, 2026-10-16 점검; 2026-10-23 플랫폼 위탁 폐지 WD1~WD4).
 * 모든 단계가 그 사람의 채널 API로 간다 — 빅히트 뮤직 테넌트(권리 편집·정책 편집·승인·활성화)는 권리자 포털, 멤버 7명은 실연자 앱,
 * 플랫폼 운영(온보딩·정산·지급)은 운영 백오피스, 가상 팬은 팬 채널. 작가 2명은 계정 없는 해외 작가로 빅히트가 관리하는 당사자다 —
 * 빅히트가 보낸 계약(작품 이용허락·권리 확인서)을 전자서명 공급자 링크로 서명한다(공급자 통지). 플랫폼은 권리를 확정하지 않는다. 권리 기록은 확인 절차(D5)와 정합성 점검(D7·D8, 빅히트 테넌트는 적용)을 그대로 통과해야 한다.
 *
 * Driver가 채널 호출과 시계·작업을 맡는다(시험은 inject, 데모 시드는 게이트웨이 HTTP). 사용자 계정 발급과 플랫폼 밖 서명 통지만
 * 아직 API가 없거나(사용자 관리 — M3) 외부 공급자 몫이라 Driver가 대신한다.
 */
export type Channel = "ops" | "portal" | "performer" | "fan" | "partner";
export type Reply = { status: number; body: any };
export type Driver = {
  call(channel: Channel, actor: string | null, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Reply>;
  upload(channel: Channel, actor: string, path: string, bytes: Uint8Array, contentType: string): Promise<Reply>;
  /** 가상 시계를 그 시각으로 옮긴다(앞으로만). */
  setClock(at: string): Promise<void>;
  /** 쌓인 작업(정산·검증·원장·지급)이 끝날 때까지 기다린다. */
  drain(): Promise<void>;
  provisionUser(u: { userId: string; displayName: string; roles: string[]; tenantId: string; partyId?: string }): Promise<void>;
  /** 총괄 계정(플랫폼 + 권리 테넌트 RIGHTS_ALL, 결정 RD6). 드라이버가 지원하면 온보딩 뒤 만든다. */
  provisionSuperAdmin?(a: { userId: string; displayName: string; tenantIds: string[] }): Promise<void>;
  /** 전자서명 공급자의 "플랫폼 밖 당사자가 서명했다" 통지. */
  providerSigned(contractId: string, partyId: string): Promise<void>;
};

export type PersonaOpts = {
  purchases?: Partial<Record<string, number>>; log?: (s: string) => void;
  /** 작가용 권리 확인서를 표준 계약 단계에서 보내지 않는다 — 계약서 불러오기로 보낼 때(E2E·시험). 작가 지분 확인 요청이 열린 채로 남는다. */
  authorsConfirmLater?: boolean;
};

export const TENANT = "tnt_bighit";
export const P = {
  ops: "usr_ops", onboard: "usr_rights", settle: "usr_settle", confirmer: "usr_settle2", accounts: "usr_accounts", ingest: "sys_ingest",
  admin: "usr_bh_admin", rights: "usr_bh_rights", policy: "usr_bh_policy", approver: "usr_bh_approver", activator: "usr_bh_activator",
  member: (k: string) => `usr_member_${k}`, fan: (f: string) => `usr_fan_${f}`, cmoAdmin: "usr_cmo_admin",
} as const;
/** 참여 기관 예시(테넌트 정책 2·4절): 가상 신탁단체. 연결은 제안 상태로만 둔다(확인하면 작품 몫 위임이 생긴다 — 데모 금액은 그대로). */
export const DEMO_CMO = { tenantId: "tnt_demo_cmo", partyId: "pty_demo_cmo", name: "가상 신탁단체(데모)" } as const;
const SCOPE = "fsc_dynamite", PACK = "pak_dynamite_fan", RECORDING = "rcd_dynamite", WORK = "wrk_dynamite";
const AUTHORS = ["pty_david_stewart", "pty_jessica_agombar"] as const;
const FANS = ["f1", "f2", "f3", "f4"] as const;
const PERIOD = { validFrom: "2026-01-01", validTo: "2027-01-01" };
const USAGE = { actions: FAN_ONLY.actions, territories: FAN_ONLY.territories, media: FAN_ONLY.media, audience: FAN_ONLY.audience };

/** 단계 사이에 넘기는 값(보고용). 단계는 고정 id를 써서 이전 단계의 메모리 값 없이도 이어서 돌 수 있다. */
export type State = { blocks?: string[]; issued?: string[]; solo?: { status: number; code?: string }; runs?: string[]; payout?: any };
export type Step = { id: string; title: string; persona: string; app: "portal" | "artist" | "ops" | "fan"; detail: string; run(d: Driver, s: State, o: PersonaOpts): Promise<void> };

const MASTER_DOC = "doc_dynamite_master", PUBLISHING_DOC = "doc_dynamite_publishing";

function helpers(d: Driver) {
  const must = async (what: string, r: Promise<Reply>, ok = [200, 201]): Promise<any> => {
    const x = await r;
    if (!ok.includes(x.status)) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.body)}`);
    return x.body;
  };
  const portal = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`portal ${method} ${path} as ${actor}`, d.call("portal", actor, method, path, body));
  const ops = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`ops ${method} ${path} as ${actor}`, d.call("ops", actor, method, path, body));
  const performer = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`performer ${method} ${path} as ${actor}`, d.call("performer", actor, method, path, body));
  return { must, portal, ops, performer };
}
const pdf = (title: string) => new TextEncoder().encode(`%PDF-1.4\n% ${title} (가상 계약서 — Dynamite 데모)\n%%EOF\n`);
const T0 = "2026-01-01T00:00:00.000Z";

export const STEPS: Step[] = [
  {
    id: "onboard", title: "온보딩: 빅히트 뮤직 테넌트(신청 → 확인됨)와 관리자·담당자 계정", persona: "플랫폼 온보딩 담당(usr_rights)·빅히트 관리자(usr_bh_admin)", app: "ops",
    detail: "온보딩 담당이 빅히트 뮤직을 권리 테넌트로 등록하고(신청) 사업자·대표자·플랫폼 계약을 확인해 확인됨으로 올린 뒤 첫 관리자 계정을 발급한다. 빅히트 관리자가 담당자 4명(권리 편집·정책 편집·승인·활성화)을 초대한다. 온보딩 담당은 멤버 7명·가상 팬(개인 당사자)을 등록한다.",
    async run(d) {
      const { ops, must } = helpers(d);
      await d.setClock("2026-01-01T09:00:00.000Z");
      // 플랫폼 쪽 페르소나: 온보딩 담당(조직 확인·개인 당사자 등록), 계좌 담당(기관 지급 정보 — 지급 실행자와 다른 사람).
      await d.provisionUser({ userId: P.onboard, displayName: "플랫폼 온보딩 담당", roles: ["ONBOARDING"], tenantId: "tnt_platform" });
      await d.provisionUser({ userId: P.accounts, displayName: "플랫폼 계좌 담당", roles: ["SPACE_SETTLE"], tenantId: "tnt_platform" });
      // 권리 테넌트 수명주기(테넌트 정책 7절): 신청 → 확인됨(사업자·대표자·플랫폼 계약). 활성은 권리 보유 증빙(계약서 원문)을 본 뒤.
      await ops(P.onboard, "POST", "/tenants", { tenantId: TENANT, tenantType: "LABEL", name: "빅히트 뮤직", businessNo: "BRN-DEMO-BIGHIT", country: "KR", representative: "대표 (가상)" });
      for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT"]) await ops(P.onboard, "PUT", `/tenants/${TENANT}/checks/${item}`, { checked: true, note: "데모: 서류 확인" });
      await ops(P.onboard, "POST", `/tenants/${TENANT}/status`, { status: "VERIFIED" });
      // 운영은 첫 관리자만 발급하고(결정 TD4), 담당자는 빅히트 관리자가 권리자 포털에서 초대한다.
      await d.provisionUser({ userId: P.admin, displayName: "빅히트 관리자", roles: ["TENANT_ADMIN"], tenantId: TENANT });
      for (const [userId, name, role] of [[P.rights, "빅히트 권리 편집", "RIGHTS_EDITOR"], [P.policy, "빅히트 정책 편집", "EDITOR"],
        [P.approver, "빅히트 승인", "WORK_APPROVER"], [P.activator, "빅히트 활성화", "ACTIVATOR"]] as const) {
        await must(`invite ${userId}`, d.call("portal", P.admin, "POST", "/users", { userId, displayName: name, roles: [role] }), [201, 409]);
      }
      // 총괄 usr_admin(플랫폼 + 빅히트 RIGHTS_ALL): 한 사람으로 새 곡부터 판매 중까지(결정 RD6 — 직무 분리를 지금 적용하지 않음).
      // 조직 첫 관리자 발급(TENANT_HAS_ADMIN 규칙) 뒤에 만든다.
      await d.provisionSuperAdmin?.({ userId: "usr_admin", displayName: "총괄", tenantIds: [TENANT] });
      // 참여 기관: 가상 신탁단체(활성, 수령 당사자 하나, 첫 관리자). 권리를 만들지 않고 연결로만 닿는다.
      await ops(P.onboard, "POST", "/tenants", { tenantId: DEMO_CMO.tenantId, tenantType: "CMO", name: DEMO_CMO.name, businessNo: "BRN-DEMO-CMO", country: "KR", representative: "대표 (가상)" });
      for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT", "TRUST_LICENSE"]) await ops(P.onboard, "PUT", `/tenants/${DEMO_CMO.tenantId}/checks/${item}`, { checked: true, note: "데모: 서류 확인" });
      await ops(P.onboard, "POST", `/tenants/${DEMO_CMO.tenantId}/status`, { status: "VERIFIED" });
      await ops(P.onboard, "POST", `/tenants/${DEMO_CMO.tenantId}/status`, { status: "ACTIVE" });
      await ops(P.onboard, "POST", "/parties", { partyId: DEMO_CMO.partyId, partyType: "CMO", displayName: DEMO_CMO.name, tenantId: DEMO_CMO.tenantId });
      await d.provisionUser({ userId: P.cmoAdmin, displayName: "신탁단체 관리자", roles: ["TENANT_ADMIN"], tenantId: DEMO_CMO.tenantId });
      for (const m of MEMBERS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_${m.key}`, partyType: "MEMBER", displayName: m.name, tenantId: "tnt_platform_default" });
      for (const f of FANS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_fan_${f}`, partyType: "FAN", displayName: `팬 ${f.toUpperCase()}`, tenantId: "tnt_platform_default" });
      for (const m of MEMBERS) await d.provisionUser({ userId: P.member(m.key), displayName: m.name, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_${m.key}` });
      for (const f of FANS) await d.provisionUser({ userId: P.fan(f), displayName: `팬 ${f.toUpperCase()}`, roles: [], tenantId: "tnt_platform_default", partyId: `pty_fan_${f}` });
    },
  },
  {
    id: "register", title: "권리 등록: 곡·녹음·슬롯·파트·스템(실연 주장 함께), 계약서 원문", persona: "빅히트 권리 편집(usr_bh_rights)", app: "portal",
    detail: "빅히트가 레이블·소속사·작가(빅히트 관리) 파티, Dynamite 작품·녹음, 원곡 흐름 슬롯 12개(보컬 파트 20·그룹 파트 2·반주 파트 12), 스템 154개(보컬 파트 × 멤버 7 = 140, 그룹·반주 원곡 14)를 등록하고 녹음·퍼블리싱 계약서 원문을 올린다. 보컬 스템은 권리 주장을 함께 만들어 멤버 보이스·소유 주장과 실연 주장이 확인 요청으로 간다.",
    async run(d) {
      const { portal, must } = helpers(d);
      await d.setClock("2026-01-02T09:00:00.000Z");
      await portal(P.rights, "POST", "/parties", { partyId: "pty_bighit_label", partyType: "LABEL", displayName: NAMES.pty_bighit_label });
      await portal(P.rights, "POST", "/parties", { partyId: "pty_bighit_agency", partyType: "AGENCY", displayName: NAMES.pty_bighit_agency });
      // 해외 작가 2명: 계정 없는 빅히트 관리 당사자(결정 WD1). 확인·서명은 빅히트가 보낸 전자서명 링크로 본인이 한다(WD2).
      for (const a of AUTHORS) await portal(P.rights, "POST", "/parties", { partyId: a, partyType: "AUTHOR", displayName: NAMES[a] });
      await portal(P.rights, "POST", "/works", { workId: WORK, title: "Dynamite" });
      await portal(P.rights, "POST", "/scopes", { factsScopeId: SCOPE, workId: WORK });
      await portal(P.rights, "POST", "/recordings", { recordingId: RECORDING, workId: WORK, masterOwnerPartyId: "pty_bighit_label", versionTitle: "Vocal Recombination" });
      for (const s of SLOTS) {
        await portal(P.rights, "POST", "/slots", { slotId: s.id, recordingId: RECORDING, startMs: s.startMs, endMs: s.endMs, sortOrder: s.no, sectionLabel: s.label, parts: s.parts.map(slotPartInput) });
        // 그룹·반주 파트는 원곡 스템 하나, 권리 부담 없음(SL6·SL7).
        for (const p of s.parts.filter((x) => x.kind !== "VOCAL")) {
          await portal(P.rights, "POST", "/stems", { stemId: stemId(p), slotId: s.id, partNo: p.partNo, recordingId: RECORDING, rightsBearing: false });
        }
      }
      // 보컬 파트 × 멤버 7: 권리 주장 함께 만들기(결정 ID3) — 멤버의 첫 스템에서 보이스와 소유 주장, 스템마다 실연 주장(모두 확인 요청).
      for (const m of MEMBERS) {
        for (const p of VOCAL_PARTS) {
          // 기존 곡 Dynamite는 옛 보이스 id(voc_<멤버>)를 그대로 쓴다 — 봉인된 IR digest가 바뀌지 않게(새 곡은 곡 단위 voc_<곡>_<멤버>).
          await portal(P.rights, "POST", "/stems", { stemId: stemId(p, m.key), slotId: p.slotId, partNo: p.partNo, recordingId: RECORDING, performerPartyId: `pty_${m.key}`, rightsBearing: true, withClaims: true, voiceId: `voc_${m.key}` });
        }
      }
      for (const [id, title, kind, parties] of [[MASTER_DOC, "Dynamite 녹음 계약서", "MASTER_CONTRACT", ["pty_bighit_label"]], [PUBLISHING_DOC, "Dynamite 작품 퍼블리싱 계약서", "PUBLISHING", [...AUTHORS]]] as const) {
        const q = new URLSearchParams({ documentId: id, kind, title, parties: parties.join(","), effectiveFrom: T0, scope: SCOPE }); // 이 곡의 원본 계약서(0048)
        await must(`upload ${title}`, d.upload("portal", P.rights, `/documents?${q}`, pdf(title), "application/pdf"));
      }
    },
  },
  {
    id: "claims", title: "권리 주장: 녹음 확정, 작가 지분은 상대 확인 요청", persona: "빅히트 권리 편집(usr_bh_rights)", app: "portal",
    detail: "녹음 권리는 빅히트 자신이라 바로 확정한다. 작가 지분은 작가 본인 확인이 필요해 확인 요청으로 두고, 작가가 빅히트가 보낸 권리 확인서에 전자서명하면 확정된다. 보이스 소유·스템 실연 147건(스템 등록 때 함께 만든 주장)은 멤버가 실연자 앱에서 확인한다.",
    async run(d) {
      const { portal } = helpers(d);
      await portal(P.rights, "POST", "/claims", { claimId: "c_master", factsScopeId: SCOPE, sourceId: RECORDING, edge: "CONTROLLED_BY", targetId: "pty_bighit_label", shareBps: 10000,
        status: "VERIFIED", validFrom: T0, evidenceDocuments: [{ documentId: MASTER_DOC, version: 1 }] });
      for (const [id, a] of [["c_work_ds", AUTHORS[0]], ["c_work_ja", AUTHORS[1]]] as const) {
        await portal(P.rights, "POST", "/claims", { claimId: id, factsScopeId: SCOPE, sourceId: WORK, edge: "WRITTEN_BY", targetId: a, shareBps: 5000, roleDetail: "LYRICS_COMPOSITION",
          status: "ASSERTED", validFrom: T0, evidenceDocuments: [{ documentId: PUBLISHING_DOC, version: 1 }] });
      }
    },
  },
  {
    id: "members", title: "멤버: 본인 인증, 권리 확인, 이용 동의", persona: "멤버 7명(usr_member_*)", app: "artist",
    detail: "멤버마다 실연자 앱에서 본인 인증을 하고, 빅히트가 보낸 확인 요청(보이스 소유·내가 부른 파트 스템 20건의 실연)을 모두 확인하고, 팬앱 이용에 동의한다(동의서 원문이 남는다).",
    async run(d) {
      const { performer } = helpers(d);
      await d.setClock("2026-01-05T09:00:00.000Z");
      for (const m of MEMBERS) {
        const u = P.member(m.key);
        const ch = await performer(u, "POST", "/identity/start", {});
        await performer(u, "POST", "/identity/confirm", { challengeId: ch.challengeId, code: ch.devCode });
        const open = (await performer(u, "GET", "/confirmations")).filter((r: any) => r.status === "OPEN");
        for (const r of open) await performer(u, "POST", `/confirmations/${r.requestId}/confirm`, {});
        await performer(u, "POST", "/consents", { consentId: `cst_vocal_${m.key}`, factsScopeId: SCOPE, assetId: `voc_${m.key}`, scope: USAGE,
          validFrom: "2026-01-05T09:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z" });
      }
    },
  },
  {
    id: "contracts", title: "표준 계약과 전자서명: 플랫폼 계약·녹음/작품 이용허락·권리 확인서·실연 수령 위임", persona: "빅히트 권리 편집·멤버·작가(전자서명 링크)", app: "portal",
    detail: "빅히트가 플랫폼 계약·녹음 이용허락에 서명하고, 멤버별 수익 수령 위임계약을 멤버(실연자 앱)·소속사가 서명한다. 해외 작가에게는 빅히트가 작품 이용허락과 작가용 권리 확인서를 보내고 작가가 전자서명 링크로 서명한다. 반영하면 서명본이 원천 문서가 되고 작가 지분·이용 동의가 확정된다(작가 확인 요청이 닫힌다).",
    async run(d, _s, o) {
      const { portal, ops, performer } = helpers(d);
      const contract = (contractId: string, templateId: string, answers: Record<string, unknown>) => portal(P.rights, "POST", "/contracts", { contractId, templateId, factsScopeId: SCOPE, answers });
      const complete = (id: string) => portal(P.rights, "POST", `/contracts/${id}/complete`, {});
      await contract("ctr_platform_label", "tpl_platform_contract", { holder: "pty_bighit_label", ...PERIOD });
      await portal(P.rights, "POST", "/contracts/ctr_platform_label/sign", {});
      await complete("ctr_platform_label");
      await contract("ctr_master_license", "tpl_master_license", { licensor: "pty_bighit_label", recording: RECORDING, ...USAGE, ...PERIOD });
      await portal(P.rights, "POST", "/contracts/ctr_master_license/sign", {});
      await complete("ctr_master_license");
      // 작가: 빅히트가 보낸 작품 이용허락에 전자서명 링크로 서명(공급자 통지) → 빅히트가 반영.
      for (const a of AUTHORS) {
        const id = `ctr_work_${a.slice(4)}`;
        await contract(id, "tpl_work_license", { licensor: a, ...USAGE, ...PERIOD });
        await d.providerSigned(id, a);
        await complete(id);
      }
      for (const m of MEMBERS) {
        const id = `ctr_mandate_${m.key}`;
        await contract(id, "tpl_performer_mandate", { performer: `pty_${m.key}`, agency: "pty_bighit_agency", shareBps: 10000, ...PERIOD });
        await performer(P.member(m.key), "POST", `/contracts/${id}/sign`, {});
        await portal(P.rights, "POST", `/contracts/${id}/sign`, {});
        await complete(id);
      }
      if (!o.authorsConfirmLater) {
        // 작가용 권리 확인서(결정 CT5): 작가 지분 표 전체에 작가 전원이 서명하면 작가 지분 주장이 서명본을 근거로 확정된다.
        await contract("ctr_claim_confirm_authors", "tpl_claim_confirm_author", {
          subject: "작품 「Dynamite」, 녹음 Vocal Recombination(빅히트 뮤직 — 레이블)",
          authors: AUTHORS.map((partyId) => ({ partyId, shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" })),
          usage: "이용 행위 미리듣기·조합 생성·개인 보관·링크 공유, 지역 대한민국, 매체 팬앱, 공개 대상 팬 커뮤니티", period: "2026-01-01 ~ 2027-01-01",
          source: "Dynamite 작품 퍼블리싱 계약서 v1(doc_dynamite_publishing)", ...USAGE, ...PERIOD,
        });
        for (const a of AUTHORS) await d.providerSigned("ctr_claim_confirm_authors", a);
        await complete("ctr_claim_confirm_authors");
      }
    },
  },
  {
    id: "ops-verify", title: "지급 정보, 빅히트 활성", persona: "운영 계좌 담당(usr_accounts)·빅히트 관리자(usr_bh_admin)·온보딩 담당(usr_rights)", app: "ops",
    detail: "운영이 레이블·소속사의 지급 정보(계좌 토큰은 지급 실행자와 다른 담당)를 등록하고, 빅히트가 자기가 관리하는 작가 2명의 지급 정보를 등록한다(결정 WD4). 온보딩 담당이 권리 보유 증빙(녹음 계약서 원문)을 확인해 빅히트를 활성으로 올린다.",
    async run(d) {
      const { ops, portal, must } = helpers(d);
      await d.setClock("2026-01-20T09:00:00.000Z");
      for (const p of ["pty_bighit_label", "pty_bighit_agency"]) {
        await ops(P.accounts, "PUT", `/parties/${p}/payout-profile`, { taxType: "DOMESTIC_CORP", payoutAccountRef: `tok_${p}`, kycVerified: true });
      }
      for (const p of AUTHORS) await portal(P.admin, "PUT", `/parties/${p}/payout-profile`, { taxType: "FOREIGN", payoutAccountRef: `tok_${p}`, kycVerified: true });
      // 권리 보유 증빙(녹음 계약서 원문)을 확인하고 빅히트를 활성으로 올린다 — 이제 팩·정책을 활성화하고 판매할 수 있다.
      await ops(P.onboard, "PUT", `/tenants/${TENANT}/checks/RIGHTS_EVIDENCE`, { checked: true, documentId: MASTER_DOC, note: "Dynamite 녹음 계약서 원문" });
      await ops(P.onboard, "POST", `/tenants/${TENANT}/status`, { status: "ACTIVE" });
      // 신탁 연결 제안(작가를 관리하는 빅히트가): 신탁단체가 참여 기관 화면에서 확인하면 활성이 된다. 데모는 제안 상태로 둔다.
      await must("trust link proposal", d.call("portal", P.admin, "POST", "/links", { linkId: "lnk_trust_demo", linkType: "TRUST", participantTenantId: DEMO_CMO.tenantId,
        authorPartyId: AUTHORS[0], memberRef: "IPI-DEMO-0001", validFrom: "2026-01-01T00:00:00.000Z" }), [201, 409]);
    },
  },
  {
    id: "policy", title: "정합성 점검 → 분배 규칙 편집·승인·활성화, 팩 활성화", persona: "빅히트 정책 편집 ≠ 승인 ≠ 활성화", app: "portal",
    detail: "근거 문서·동의·확인이 갖춰져 차단 이슈가 없다. 정책 편집자가 분배 규칙을 만들고, 다른 사람이 승인하고, 또 다른 사람이 활성화한다. 팩을 만들고 활성화하면 팬이 조합할 수 있다.",
    async run(d, s) {
      const { portal } = helpers(d);
      await d.setClock("2026-02-01T09:00:00.000Z");
      const check = await portal(P.rights, "GET", `/scopes/${SCOPE}/validation`);
      s.blocks = check.issues.filter((i: any) => i.status === "OPEN" && i.severity === "BLOCK").map((i: any) => `${i.rule} ${i.subjectId}`);
      await portal(P.rights, "POST", "/packs", { packId: PACK, packCode: "DYNAMITE-FAN", title: "Dynamite 팬앱 전용 보컬 조합", factsScopeId: SCOPE });
      await portal(P.rights, "PUT", `/packs/${PACK}/claimants`, [
        { role: "AGENCY", party: "pty_bighit_agency" }, { role: "MASTER_OWNER", party: "pty_bighit_label" },
        ...MEMBERS.map((m) => ({ role: "PERFORMER_FEATURED", party: `pty_${m.key}` })),
        ...AUTHORS.map((a) => ({ role: "WORK_AUTHOR", party: a })),
      ]);
      const compiled = await portal(P.policy, "POST", "/policies/pol_dynamite_fan/compile", { packId: PACK, sourceText: POLICY_TEXT });
      await portal(P.approver, "POST", `/policies/pol_dynamite_fan/versions/${compiled.version}/approve`, {});
      await portal(P.activator, "POST", `/policies/pol_dynamite_fan/versions/${compiled.version}/activate`, {});
      await portal(P.activator, "POST", `/packs/${PACK}/activate`, {});
    },
  },
  {
    id: "fans", title: "가상 팬: 조합 발행(게이트 통과 즉시 봉인), 솔로 조합 거부", persona: "가상 팬 F1~F4", app: "fan",
    detail: "팬 4명이 원곡 배치·정국↔지민 맞바꾸기·랩 파트를 보컬 멤버가·진이 정국·지민 파트까지 조합을 발행한다. 정국 혼자 모든 보컬 파트를 부르는 조합은 정산 사전 검사에서 거부된다.",
    async run(d, s) {
      const { must } = helpers(d);
      await d.setClock("2026-02-15T09:00:00.000Z");
      s.issued = [];
      for (const [k, cb] of COMBINATIONS.entries()) {
        await must(`fan issue ${cb.vcId}`, d.call("fan", P.fan(FANS[k]!), "POST", "/combinations", { packId: PACK, vcId: cb.vcId, assignments: combinationAssignments(cb), members: memberBps(singersFor(cb)) }));
        s.issued.push(cb.vcId);
      }
      const solo = await d.call("fan", P.fan("f1"), "POST", "/combinations", { packId: PACK, vcId: "vc_bts_solo",
        assignments: SOLO_ASSIGNMENTS, members: { pty_jungkook: 10000 } });
      s.solo = { status: solo.status, code: solo.body?.code };
    },
  },
  {
    id: "settle", title: "3월 매출 → 정산 실행·독립 재계산·확정 → 환불 역분개", persona: "수집 시스템·운영(실행) ≠ 정산 담당(확정)", app: "ops",
    detail: "3월 구매 매출(가격 3,300원)이 들어오고 1건은 이상거래 의심으로 보류된다. 4/1 운영이 정산을 실행하면 검증 워커가 다시 계산해 맞춰 보고, 다른 담당이 확정한다. 4/10 환불 1건은 역분개된다.",
    async run(d, s, o) {
      const { ops } = helpers(d);
      await d.setClock("2026-04-01T09:00:00.000Z");
      let n = 0;
      for (const cb of COMBINATIONS) {
        const count = o.purchases?.[cb.vcId] ?? cb.purchases;
        for (let i = 1; i <= count; i++, n++) {
          const id = `ev_${cb.vcId.replace("vc_bts_", "")}_${String(i).padStart(4, "0")}`;
          await ops(P.ingest, "POST", "/revenue-events", { eventId: id, sourceSystem: "fan_app", sourceEventId: id, eventType: "PURCHASE", vcId: cb.vcId, amountKrw: "3300", currency: "KRW",
            integrity: cb.vcId === "vc_bts_jin" && i === 1 ? "FLAGGED" : "CLEAR", occurredAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + n * 60_000).toISOString() });
        }
      }
      await d.drain();
      await ops(P.ops, "POST", "/batches", { batchId: "bat_bts_2026_03", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
      await d.drain();
      s.runs = ((await ops(P.ops, "GET", "/batches/bat_bts_2026_03/runs?limit=200")).items as any[]).map((r) => `${r.runId} ${r.status}`);
      await ops(P.settle, "POST", "/batches/bat_bts_2026_03/confirm", {});
      await d.drain();
      await d.setClock("2026-04-10T09:00:00.000Z");
      await ops(P.ingest, "POST", "/revenue-events", { eventId: "ev_rf_0001", sourceSystem: "fan_app", sourceEventId: "ev_rf_0001", eventType: "REFUND", relatedEventId: "ev_orig_0001",
        amountKrw: "3300", currency: "KRW", occurredAt: "2026-04-10T00:00:00.000Z" });
      await d.drain();
    },
  },
  {
    id: "payout", title: "5/1 지급 → 명세(빅히트 포털·멤버 실연자 앱)", persona: "정산 담당(usr_settle)", app: "ops",
    detail: "운영이 지급을 실행하면 가상 PSP가 처리한다(작가는 해외 원천징수). 빅히트는 포털에서 레이블·소속사 명세를, 멤버는 실연자 앱에서 위임 전 자기 기여분을 본다.",
    async run(d, s) {
      const { ops } = helpers(d);
      await d.setClock("2026-05-01T09:00:00.000Z");
      s.payout = await ops(P.settle, "POST", "/payout-runs", { payoutRunId: "pay-2026-05", asOf: "2026-05-01T09:00:00.000Z" });
      await d.drain();
    },
  },
];

/** 처음부터 끝까지(시험·한 번에 채우기). */
export async function runDynamitePersonas(d: Driver, opts: PersonaOpts = {}) {
  const s: State = {};
  for (const st of STEPS) { opts.log?.(st.title); await st.run(d, s, opts); }
  const { portal, performer, ops } = helpers(d);
  const statement = (party: string) => portal(P.rights, "GET", `/parties/${party}/statements?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z`);
  return {
    validationBlocksBeforeActivation: s.blocks ?? [], issued: s.issued ?? [], soloRejected: s.solo!, runs: s.runs ?? [],
    payout: { instructions: ((r: any) => r.items ?? r)(await ops(P.settle, "GET", "/payout-runs/pay-2026-05/instructions?limit=200")) },
    statements: { label: await statement("pty_bighit_label"), agency: await statement("pty_bighit_agency") },
    contributions: await performer(P.member("jungkook"), "GET", "/contributions?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z"),
  };
}
