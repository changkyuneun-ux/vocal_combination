import { COMBINATIONS, FAN_ONLY, MEMBERS, NAMES, POLICY_TEXT, SLOTS, memberBps, singerOf } from "./dynamite.ts";

/**
 * Dynamite 2차 이용을 페르소나별 로그인으로 끝까지 돌리는 시나리오(MVP 진행계획 M4 시드의 바탕, 2026-10-16 점검).
 * 모든 단계가 그 사람의 채널 API로 간다 — 빅히트 뮤직 테넌트(권리 편집·정책 편집·승인·활성화)는 권리자 포털, 멤버 7명은 실연자 앱,
 * 플랫폼 운영(온보딩·확인·정산·지급)은 운영 백오피스, 가상 팬은 팬 채널. 작가 2명은 플랫폼 밖 당사자(해외)로, 전자서명 공급자 통지와
 * 기한 뒤 플랫폼 원문 대조 확인으로 들어온다. 권리 기록은 확인 절차(D5)와 정합성 점검(D7·D8, 빅히트 테넌트는 적용)을 그대로 통과해야 한다.
 *
 * Driver가 채널 호출과 시계·작업을 맡는다(시험은 inject, 데모 시드는 게이트웨이 HTTP). 사용자 계정 발급과 플랫폼 밖 서명 통지만
 * 아직 API가 없거나(사용자 관리 — M3) 외부 공급자 몫이라 Driver가 대신한다.
 */
export type Channel = "ops" | "portal" | "performer" | "fan";
export type Reply = { status: number; body: any };
export type Driver = {
  call(channel: Channel, actor: string | null, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Reply>;
  upload(channel: Channel, actor: string, path: string, bytes: Uint8Array, contentType: string): Promise<Reply>;
  /** 가상 시계를 그 시각으로 옮긴다(앞으로만). */
  setClock(at: string): Promise<void>;
  /** 쌓인 작업(정산·검증·원장·지급)이 끝날 때까지 기다린다. */
  drain(): Promise<void>;
  provisionUser(u: { userId: string; displayName: string; roles: string[]; tenantId: string; partyId?: string }): Promise<void>;
  /** 전자서명 공급자의 "플랫폼 밖 당사자가 서명했다" 통지. */
  providerSigned(contractId: string, partyId: string): Promise<void>;
};

export type PersonaOpts = { purchases?: Partial<Record<string, number>>; log?: (s: string) => void };

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
    detail: "온보딩 담당이 빅히트 뮤직을 권리 테넌트로 등록하고(신청) 사업자·대표자·플랫폼 계약을 확인해 확인됨으로 올린 뒤 첫 관리자 계정을 발급한다. 빅히트 관리자가 담당자 4명(권리 편집·정책 편집·승인·활성화)을 초대한다. 온보딩 담당은 멤버 7명·해외 작가 2명·가상 팬 당사자를 등록한다.",
    async run(d) {
      const { ops, must } = helpers(d);
      await d.setClock("2026-01-01T09:00:00.000Z");
      // 플랫폼 쪽 페르소나: 온보딩 담당(조직·당사자 등록, 위탁 당사자 계약), 계좌 담당(지급 정보 — 지급 실행자와 다른 사람).
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
      // 참여 기관: 가상 신탁단체(활성, 수령 당사자 하나, 첫 관리자). 권리를 만들지 않고 연결로만 닿는다.
      await ops(P.onboard, "POST", "/tenants", { tenantId: DEMO_CMO.tenantId, tenantType: "CMO", name: DEMO_CMO.name, businessNo: "BRN-DEMO-CMO", country: "KR", representative: "대표 (가상)" });
      for (const item of ["BUSINESS_ID", "REPRESENTATIVE", "PLATFORM_AGREEMENT", "TRUST_LICENSE"]) await ops(P.onboard, "PUT", `/tenants/${DEMO_CMO.tenantId}/checks/${item}`, { checked: true, note: "데모: 서류 확인" });
      await ops(P.onboard, "POST", `/tenants/${DEMO_CMO.tenantId}/status`, { status: "VERIFIED" });
      await ops(P.onboard, "POST", `/tenants/${DEMO_CMO.tenantId}/status`, { status: "ACTIVE" });
      await ops(P.onboard, "POST", "/parties", { partyId: DEMO_CMO.partyId, partyType: "CMO", displayName: DEMO_CMO.name, tenantId: DEMO_CMO.tenantId });
      await d.provisionUser({ userId: P.cmoAdmin, displayName: "신탁단체 관리자", roles: ["TENANT_ADMIN"], tenantId: DEMO_CMO.tenantId });
      for (const m of MEMBERS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_${m.key}`, partyType: "MEMBER", displayName: m.name, tenantId: "tnt_platform_default" });
      for (const a of AUTHORS) await ops(P.onboard, "POST", "/parties", { partyId: a, partyType: "AUTHOR", displayName: NAMES[a] });
      for (const f of FANS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_fan_${f}`, partyType: "FAN", displayName: `팬 ${f.toUpperCase()}`, tenantId: "tnt_platform_default" });
      for (const m of MEMBERS) await d.provisionUser({ userId: P.member(m.key), displayName: m.name, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_${m.key}` });
      for (const f of FANS) await d.provisionUser({ userId: P.fan(f), displayName: `팬 ${f.toUpperCase()}`, roles: [], tenantId: "tnt_platform_default", partyId: `pty_fan_${f}` });
    },
  },
  {
    id: "register", title: "권리 등록: 곡·녹음·슬롯·스템·보이스, 계약서 원문", persona: "빅히트 권리 편집(usr_bh_rights)", app: "portal",
    detail: "빅히트가 레이블·소속사 파티, Dynamite 작품·녹음, 멤버별 파트 슬롯 7개와 MR, 멤버×파트 스템 49개, 보이스 7개를 등록하고 녹음·퍼블리싱 계약서 원문을 올린다.",
    async run(d) {
      const { portal, must } = helpers(d);
      await d.setClock("2026-01-02T09:00:00.000Z");
      await portal(P.rights, "POST", "/parties", { partyId: "pty_bighit_label", partyType: "LABEL", displayName: NAMES.pty_bighit_label });
      await portal(P.rights, "POST", "/parties", { partyId: "pty_bighit_agency", partyType: "AGENCY", displayName: NAMES.pty_bighit_agency });
      await portal(P.rights, "POST", "/works", { workId: WORK, title: "Dynamite" });
      await portal(P.rights, "POST", "/scopes", { factsScopeId: SCOPE, workId: WORK });
      await portal(P.rights, "POST", "/recordings", { recordingId: RECORDING, workId: WORK, masterOwnerPartyId: "pty_bighit_label", versionTitle: "Vocal Recombination" });
      let sort = 1;
      for (const s of SLOTS) await portal(P.rights, "POST", "/slots", { slotId: s.id, recordingId: RECORDING, startMs: s.startMs, endMs: s.endMs, sortOrder: sort++ });
      await portal(P.rights, "POST", "/slots", { slotId: "slt_mr", recordingId: RECORDING, startMs: 0, endMs: 199000, sortOrder: sort });
      await portal(P.rights, "POST", "/stems", { stemId: "stm_mr", slotId: "slt_mr", recordingId: RECORDING, rightsBearing: false });
      for (const m of MEMBERS) {
        await portal(P.rights, "POST", "/voices", { voiceId: `voc_${m.key}`, factsScopeId: SCOPE, kind: "HUMAN" });
        for (const s of SLOTS) await portal(P.rights, "POST", "/stems", { stemId: `stm_${m.key}_${s.owner}`, slotId: s.id, recordingId: RECORDING, performerPartyId: `pty_${m.key}`, rightsBearing: true });
      }
      for (const [id, title, kind, parties] of [[MASTER_DOC, "Dynamite 녹음 계약서", "MASTER_CONTRACT", ["pty_bighit_label"]], [PUBLISHING_DOC, "Dynamite 작품 퍼블리싱 계약서", "PUBLISHING", [...AUTHORS]]] as const) {
        const q = new URLSearchParams({ documentId: id, kind, title, parties: parties.join(","), effectiveFrom: T0 });
        await must(`upload ${title}`, d.upload("portal", P.rights, `/documents?${q}`, pdf(title), "application/pdf"));
      }
    },
  },
  {
    id: "claims", title: "권리 주장: 녹음 확정, 작가 지분·보이스·실연은 상대 확인 요청", persona: "빅히트 권리 편집(usr_bh_rights)", app: "portal",
    detail: "녹음 권리는 빅히트 자신이라 바로 확정한다. 작가 지분은 플랫폼 밖 작가라 기한 뒤 운영 원문 대조로, 보이스 소유·스템 실연 56건은 멤버가 실연자 앱에서 확인한다.",
    async run(d) {
      const { portal } = helpers(d);
      await portal(P.rights, "POST", "/claims", { claimId: "c_master", factsScopeId: SCOPE, sourceId: RECORDING, edge: "CONTROLLED_BY", targetId: "pty_bighit_label", shareBps: 10000,
        status: "VERIFIED", validFrom: T0, evidenceDocuments: [{ documentId: MASTER_DOC, version: 1 }] });
      for (const [id, a] of [["c_work_ds", AUTHORS[0]], ["c_work_ja", AUTHORS[1]]] as const) {
        await portal(P.rights, "POST", "/claims", { claimId: id, factsScopeId: SCOPE, sourceId: WORK, edge: "WRITTEN_BY", targetId: a, shareBps: 5000, roleDetail: "LYRICS_COMPOSITION",
          status: "ASSERTED", validFrom: T0, evidenceDocuments: [{ documentId: PUBLISHING_DOC, version: 1 }] });
      }
      for (const m of MEMBERS) {
        await portal(P.rights, "POST", "/claims", { claimId: `c_own_${m.key}`, factsScopeId: SCOPE, sourceId: `voc_${m.key}`, edge: "OWNED_BY", targetId: `pty_${m.key}`, shareBps: 10000, status: "ASSERTED", validFrom: T0 });
        for (const s of SLOTS) {
          await portal(P.rights, "POST", "/claims", { claimId: `c_perf_${m.key}_${s.owner}`, factsScopeId: SCOPE, sourceId: `stm_${m.key}_${s.owner}`, edge: "PERFORMED_BY",
            targetId: `voc_${m.key}`, shareBps: 10000, performerRole: "FEATURED", status: "ASSERTED", validFrom: T0 });
        }
      }
    },
  },
  {
    id: "members", title: "멤버: 본인 인증, 권리 확인, 이용 동의", persona: "멤버 7명(usr_member_*)", app: "artist",
    detail: "멤버마다 실연자 앱에서 본인 인증을 하고, 빅히트가 보낸 확인 요청(보이스 소유·내 파트 실연)을 확인하고, 팬앱 이용에 동의한다(동의서 원문이 남는다).",
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
    id: "contracts", title: "표준 계약과 전자서명: 플랫폼 계약·녹음/작품 이용허락·실연 수령 위임", persona: "빅히트 권리 편집·멤버·작가(공급자 서명)", app: "portal",
    detail: "빅히트가 플랫폼 계약·녹음 이용허락에 서명하고, 멤버별 수익 수령 위임계약을 멤버(실연자 앱)·소속사가 서명한다. 해외 작가와의 작품 이용허락은 플랫폼이 맺고 작가는 전자서명 공급자에서 서명한다. 반영하면 서명본이 원천 문서가 되고 기록이 확정된다.",
    async run(d) {
      const { portal, ops, performer } = helpers(d);
      const contract = (contractId: string, templateId: string, answers: Record<string, unknown>) => portal(P.rights, "POST", "/contracts", { contractId, templateId, factsScopeId: SCOPE, answers });
      const complete = (id: string) => portal(P.rights, "POST", `/contracts/${id}/complete`, {});
      await contract("ctr_platform_label", "tpl_platform_contract", { holder: "pty_bighit_label", ...PERIOD });
      await portal(P.rights, "POST", "/contracts/ctr_platform_label/sign", {});
      await complete("ctr_platform_label");
      await contract("ctr_master_license", "tpl_master_license", { licensor: "pty_bighit_label", recording: RECORDING, ...USAGE, ...PERIOD });
      await portal(P.rights, "POST", "/contracts/ctr_master_license/sign", {});
      await complete("ctr_master_license");
      for (const a of AUTHORS) {
        const id = `ctr_work_${a.slice(4)}`;
        await ops(P.onboard, "POST", "/contracts", { contractId: id, templateId: "tpl_work_license", factsScopeId: SCOPE, answers: { licensor: a, ...USAGE, ...PERIOD } });
        await d.providerSigned(id, a);
        await ops(P.onboard, "POST", `/contracts/${id}/complete`, {});
      }
      for (const m of MEMBERS) {
        const id = `ctr_mandate_${m.key}`;
        await contract(id, "tpl_performer_mandate", { performer: `pty_${m.key}`, agency: "pty_bighit_agency", shareBps: 10000, ...PERIOD });
        await performer(P.member(m.key), "POST", `/contracts/${id}/sign`, {});
        await portal(P.rights, "POST", `/contracts/${id}/sign`, {});
        await complete(id);
      }
    },
  },
  {
    id: "ops-verify", title: "운영: 지급 정보, 작가 지분 원문 대조 확인, 빅히트 활성", persona: "운영 계좌 담당(usr_accounts)·운영(usr_ops)·온보딩 담당(usr_rights)", app: "ops",
    detail: "운영이 레이블·소속사·작가의 지급 정보(계좌 토큰은 지급 실행자와 다른 담당)를 등록하고, 14일 기한이 지난 작가 지분 확인 요청을 퍼블리싱 계약서 원문과 대조해 확인한다. 온보딩 담당이 권리 보유 증빙(녹음 계약서 원문)을 확인해 빅히트를 활성으로 올린다.",
    async run(d) {
      const { ops, must } = helpers(d);
      await d.setClock("2026-01-20T09:00:00.000Z");
      for (const p of ["pty_bighit_label", "pty_bighit_agency", ...AUTHORS]) {
        await ops(P.accounts, "PUT", `/parties/${p}/payout-profile`, { taxType: p.startsWith("pty_bighit") ? "DOMESTIC_CORP" : "FOREIGN", payoutAccountRef: `tok_${p}`, kycVerified: true });
      }
      // 권리 보유 증빙(녹음 계약서 원문)을 확인하고 빅히트를 활성으로 올린다 — 이제 팩·정책을 활성화하고 판매할 수 있다.
      await ops(P.onboard, "PUT", `/tenants/${TENANT}/checks/RIGHTS_EVIDENCE`, { checked: true, documentId: MASTER_DOC, note: "Dynamite 녹음 계약서 원문" });
      await ops(P.onboard, "POST", `/tenants/${TENANT}/status`, { status: "ACTIVE" });
      // 신탁 연결 제안(플랫폼이 위탁 작가의 관리 주체로서): 신탁단체가 참여 기관 화면에서 확인하면 활성이 된다. 데모는 제안 상태로 둔다.
      await must("trust link proposal", d.call("ops", P.onboard, "POST", "/links", { linkId: "lnk_trust_demo", linkType: "TRUST", participantTenantId: DEMO_CMO.tenantId,
        authorPartyId: AUTHORS[0], memberRef: "IPI-DEMO-0001", validFrom: "2026-01-01T00:00:00.000Z" }), [201, 409]);
      const pending = (await ops(P.ops, "GET", "/confirmations?status=OPEN")) as any[];
      for (const r of pending.filter((x) => x.recordId === "c_work_ds" || x.recordId === "c_work_ja")) {
        await ops(P.ops, "POST", `/confirmations/${r.requestId}/platform-verify`, { reason: "퍼블리싱 계약서 원문 대조(작가 지분 각 50%)" });
      }
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
    detail: "팬 4명이 원곡 배치·정국↔지민 맞바꾸기·랩 파트를 보컬 멤버가·진이 정국·지민 파트까지 조합을 발행한다. 정국 혼자 모든 파트를 부르는 조합은 정산 사전 검사에서 거부된다.",
    async run(d, s) {
      const { must } = helpers(d);
      await d.setClock("2026-02-15T09:00:00.000Z");
      s.issued = [];
      for (const [k, cb] of COMBINATIONS.entries()) {
        const singers = SLOTS.map((sl) => singerOf(cb, sl.owner));
        const assignments = [...SLOTS.map((sl, i) => ({ slotId: sl.id, stemId: `stm_${singers[i]}_${sl.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }];
        await must(`fan issue ${cb.vcId}`, d.call("fan", P.fan(FANS[k]!), "POST", "/combinations", { packId: PACK, vcId: cb.vcId, assignments, members: memberBps(singers) }));
        s.issued.push(cb.vcId);
      }
      const solo = await d.call("fan", P.fan("f1"), "POST", "/combinations", { packId: PACK, vcId: "vc_bts_solo",
        assignments: [...SLOTS.map((sl) => ({ slotId: sl.id, stemId: `stm_jungkook_${sl.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }], members: { pty_jungkook: 10000 } });
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
