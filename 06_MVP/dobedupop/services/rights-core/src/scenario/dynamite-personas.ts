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
  rights: "usr_bh_rights", policy: "usr_bh_policy", approver: "usr_bh_approver", activator: "usr_bh_activator",
  member: (k: string) => `usr_member_${k}`, fan: (f: string) => `usr_fan_${f}`,
} as const;
const SCOPE = "fsc_dynamite", PACK = "pak_dynamite_fan", RECORDING = "rcd_dynamite", WORK = "wrk_dynamite";
const AUTHORS = ["pty_david_stewart", "pty_jessica_agombar"] as const;
const FANS = ["f1", "f2", "f3", "f4"] as const;
const PERIOD = { validFrom: "2026-01-01", validTo: "2027-01-01" };
const USAGE = { actions: FAN_ONLY.actions, territories: FAN_ONLY.territories, media: FAN_ONLY.media, audience: FAN_ONLY.audience };

export async function runDynamitePersonas(d: Driver, opts: PersonaOpts = {}) {
  const log = opts.log ?? (() => {});
  const must = async (what: string, r: Promise<Reply>, ok = [200, 201]): Promise<any> => {
    const x = await r;
    if (!ok.includes(x.status)) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.body)}`);
    return x.body;
  };
  const portal = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`portal ${method} ${path} as ${actor}`, d.call("portal", actor, method, path, body));
  const ops = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`ops ${method} ${path} as ${actor}`, d.call("ops", actor, method, path, body));
  const performer = (actor: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown) => must(`performer ${method} ${path} as ${actor}`, d.call("performer", actor, method, path, body));
  const pdf = (title: string) => new TextEncoder().encode(`%PDF-1.4\n% ${title} (가상 계약서 — Dynamite 데모)\n%%EOF\n`);

  // ── 0. 온보딩(2026-01-01, 운영): 빅히트 뮤직 테넌트(SPACE_OPS), 멤버·작가·팬 파티(플랫폼 온보딩 담당 = 플랫폼 RIGHTS_EDITOR), 계정 ──────────────────────────────
  await d.setClock("2026-01-01T09:00:00.000Z");
  log("0. 온보딩: 빅히트 뮤직 테넌트·계정");
  await ops(P.ops, "POST", "/tenants", { tenantId: TENANT, tenantType: "LABEL", name: "빅히트 뮤직" });
  for (const [userId, name, role] of [[P.rights, "빅히트 권리 편집", "RIGHTS_EDITOR"], [P.policy, "빅히트 정책 편집", "EDITOR"],
    [P.approver, "빅히트 승인", "WORK_APPROVER"], [P.activator, "빅히트 활성화", "ACTIVATOR"]] as const) {
    await d.provisionUser({ userId, displayName: name, roles: [role], tenantId: TENANT });
  }
  for (const m of MEMBERS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_${m.key}`, partyType: "MEMBER", displayName: m.name, tenantId: "tnt_platform_default" });
  for (const a of AUTHORS) await ops(P.onboard, "POST", "/parties", { partyId: a, partyType: "AUTHOR", displayName: NAMES[a] });
  for (const f of FANS) await ops(P.onboard, "POST", "/parties", { partyId: `pty_fan_${f}`, partyType: "FAN", displayName: `팬 ${f.toUpperCase()}`, tenantId: "tnt_platform_default" });
  for (const m of MEMBERS) await d.provisionUser({ userId: P.member(m.key), displayName: m.name, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_${m.key}` });
  for (const f of FANS) await d.provisionUser({ userId: P.fan(f), displayName: `팬 ${f.toUpperCase()}`, roles: [], tenantId: "tnt_platform_default", partyId: `pty_fan_${f}` });

  // ── 1. 권리 등록(1/2, 빅히트 권리 편집자, 포털) ──────────────────────────────────────────────────
  await d.setClock("2026-01-02T09:00:00.000Z");
  log("1. 권리 등록: 곡·녹음·슬롯·스템·보이스, 근거 문서");
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
  const upload = async (title: string, kind: string, parties: string[]) => {
    const q = new URLSearchParams({ kind, title, parties: parties.join(","), effectiveFrom: "2026-01-01T00:00:00.000Z" });
    return (await must(`upload ${title}`, d.upload("portal", P.rights, `/documents?${q}`, pdf(title), "application/pdf"))).documentId as string;
  };
  const masterDoc = await upload("Dynamite 녹음 계약서", "MASTER_CONTRACT", ["pty_bighit_label"]);
  const publishingDoc = await upload("Dynamite 작품 퍼블리싱 계약서", "PUBLISHING", [...AUTHORS]);

  // ── 2. 권리 주장(빅히트) → 상대 확인(D5) ───────────────────────────────────────────────────────
  log("2. 권리 주장과 상대 확인");
  const T0 = "2026-01-01T00:00:00.000Z";
  // 녹음 권리자는 빅히트 자신이라 바로 확정(VERIFIED)으로 쓸 수 있다.
  await portal(P.rights, "POST", "/claims", { claimId: "c_master", factsScopeId: SCOPE, sourceId: RECORDING, edge: "CONTROLLED_BY", targetId: "pty_bighit_label", shareBps: 10000,
    status: "VERIFIED", validFrom: T0, evidenceDocuments: [{ documentId: masterDoc, version: 1 }] });
  // 작가 지분: 작가가 플랫폼 밖이라 ASSERTED → 14일 뒤 운영이 원문 대조로 확인한다.
  for (const [id, a] of [["c_work_ds", AUTHORS[0]], ["c_work_ja", AUTHORS[1]]] as const) {
    await portal(P.rights, "POST", "/claims", { claimId: id, factsScopeId: SCOPE, sourceId: WORK, edge: "WRITTEN_BY", targetId: a, shareBps: 5000, roleDetail: "LYRICS_COMPOSITION",
      status: "ASSERTED", validFrom: T0, evidenceDocuments: [{ documentId: publishingDoc, version: 1 }] });
  }
  // 보이스 소유·스템 실연: 상대(멤버)가 실연자 앱에서 확인한다.
  for (const m of MEMBERS) {
    await portal(P.rights, "POST", "/claims", { claimId: `c_own_${m.key}`, factsScopeId: SCOPE, sourceId: `voc_${m.key}`, edge: "OWNED_BY", targetId: `pty_${m.key}`, shareBps: 10000, status: "ASSERTED", validFrom: T0 });
    for (const s of SLOTS) {
      await portal(P.rights, "POST", "/claims", { claimId: `c_perf_${m.key}_${s.owner}`, factsScopeId: SCOPE, sourceId: `stm_${m.key}_${s.owner}`, edge: "PERFORMED_BY",
        targetId: `voc_${m.key}`, shareBps: 10000, performerRole: "FEATURED", status: "ASSERTED", validFrom: T0 });
    }
  }

  // ── 3. 멤버(실연자 앱): 본인 인증 → 확인 요청 확인 → 이용 동의(동의서 원문 생성) ─────────────────────────
  await d.setClock("2026-01-05T09:00:00.000Z");
  log("3. 멤버 본인 인증·확인·동의");
  for (const m of MEMBERS) {
    const u = P.member(m.key);
    const ch = await performer(u, "POST", "/identity/start", {});
    await performer(u, "POST", "/identity/confirm", { challengeId: ch.challengeId, code: ch.devCode });
    const open = (await performer(u, "GET", "/confirmations")).filter((r: any) => r.status === "OPEN");
    for (const r of open) await performer(u, "POST", `/confirmations/${r.requestId}/confirm`, {});
    await performer(u, "POST", "/consents", { consentId: `cst_vocal_${m.key}`, factsScopeId: SCOPE, assetId: `voc_${m.key}`, scope: USAGE,
      validFrom: "2026-01-05T09:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z" });
  }

  // ── 4. 표준 계약(빅히트가 작성): 플랫폼 계약·녹음 이용허락(레이블 서명), 작품 이용허락(작가 = 공급자 서명), 실연 수령 위임(멤버·소속사 서명) ──
  log("4. 표준 계약과 전자서명");
  const contract = async (contractId: string, templateId: string, answers: Record<string, unknown>) =>
    portal(P.rights, "POST", "/contracts", { contractId, templateId, factsScopeId: SCOPE, answers });
  const complete = (id: string) => portal(P.rights, "POST", `/contracts/${id}/complete`, {});
  await contract("ctr_platform_label", "tpl_platform_contract", { holder: "pty_bighit_label", ...PERIOD });
  await portal(P.rights, "POST", "/contracts/ctr_platform_label/sign", {});
  await complete("ctr_platform_label");
  await contract("ctr_master_license", "tpl_master_license", { licensor: "pty_bighit_label", recording: RECORDING, ...USAGE, ...PERIOD });
  await portal(P.rights, "POST", "/contracts/ctr_master_license/sign", {});
  await complete("ctr_master_license");
  // 작품 이용허락은 이용자인 플랫폼(온보딩 담당)이 플랫폼 밖 작가와 맺는다: 작가는 전자서명 공급자 화면에서 서명한다.
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

  // ── 5. 운영: 지급 정보(계좌 토큰은 지급 실행자와 다른 담당), 작가 지분 원문 대조 확인(기한 뒤) ──────────────────
  await d.setClock("2026-01-20T09:00:00.000Z");
  log("5. 운영: 지급 정보, 작가 지분 플랫폼 확인");
  for (const p of ["pty_bighit_label", "pty_bighit_agency", ...AUTHORS]) {
    await ops(P.accounts, "PUT", `/parties/${p}/payout-profile`, { taxType: p.startsWith("pty_bighit") ? "DOMESTIC_CORP" : "FOREIGN", payoutAccountRef: `tok_${p}`, kycVerified: true });
  }
  const pending = (await ops(P.ops, "GET", "/confirmations?status=OPEN")) as any[];
  for (const r of pending.filter((x) => x.recordId === "c_work_ds" || x.recordId === "c_work_ja")) {
    await ops(P.ops, "POST", `/confirmations/${r.requestId}/platform-verify`, { reason: "퍼블리싱 계약서 원문 대조(작가 지분 각 50%)" });
  }

  // ── 6. 정합성 점검 → 분배 규칙 편집·승인·활성화 → 팩(빅히트, 세 사람) ─────────────────────────────────
  await d.setClock("2026-02-01T09:00:00.000Z");
  log("6. 정합성 점검, 정책 승인·활성화, 팩");
  const check = await portal(P.rights, "GET", `/scopes/${SCOPE}/validation`);
  const blocks = check.issues.filter((i: any) => i.status === "OPEN" && i.severity === "BLOCK");
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

  // ── 7. 가상 팬: 조합 발행(게이트 통과 즉시 봉인), 솔로 조합은 거부 ───────────────────────────────────────
  await d.setClock("2026-02-15T09:00:00.000Z");
  log("7. 가상 팬 조합 발행");
  const issued: string[] = [];
  for (const [k, cb] of COMBINATIONS.entries()) {
    const singers = SLOTS.map((s) => singerOf(cb, s.owner));
    const assignments = [...SLOTS.map((s, i) => ({ slotId: s.id, stemId: `stm_${singers[i]}_${s.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }];
    await must(`fan issue ${cb.vcId}`, d.call("fan", P.fan(FANS[k]!), "POST", "/combinations", { packId: PACK, vcId: cb.vcId, assignments, members: memberBps(singers) }));
    issued.push(cb.vcId);
  }
  const solo = await d.call("fan", P.fan("f1"), "POST", "/combinations", { packId: PACK, vcId: "vc_bts_solo",
    assignments: [...SLOTS.map((s) => ({ slotId: s.id, stemId: `stm_jungkook_${s.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }], members: { pty_jungkook: 10000 } });

  // ── 8. 3월 매출(수집 시스템) → 4/1 정산 실행(운영) → 독립 재계산 → 확정(다른 사람) → 4/10 환불 역분개 ─────────────
  await d.setClock("2026-04-01T09:00:00.000Z");
  log("8. 매출 수집, 정산 실행·검증·확정, 환불 역분개");
  let n = 0;
  for (const cb of COMBINATIONS) {
    const count = opts.purchases?.[cb.vcId] ?? cb.purchases;
    for (let i = 1; i <= count; i++, n++) {
      const id = `ev_${cb.vcId.replace("vc_bts_", "")}_${String(i).padStart(4, "0")}`;
      await ops(P.ingest, "POST", "/revenue-events", { eventId: id, sourceSystem: "fan_app", sourceEventId: id, eventType: "PURCHASE", vcId: cb.vcId, amountKrw: "3300", currency: "KRW",
        integrity: cb.vcId === "vc_bts_jin" && i === 1 ? "FLAGGED" : "CLEAR", occurredAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + n * 60_000).toISOString() });
    }
  }
  await d.drain();
  await ops(P.ops, "POST", "/batches", { batchId: "bat_bts_2026_03", periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
  await d.drain();
  const runs = (await ops(P.ops, "GET", "/batches/bat_bts_2026_03/runs?limit=200")).items as any[];
  await ops(P.settle, "POST", "/batches/bat_bts_2026_03/confirm", {});
  await d.drain();
  await d.setClock("2026-04-10T09:00:00.000Z");
  await ops(P.ingest, "POST", "/revenue-events", { eventId: "ev_rf_0001", sourceSystem: "fan_app", sourceEventId: "ev_rf_0001", eventType: "REFUND", relatedEventId: "ev_orig_0001",
    amountKrw: "3300", currency: "KRW", occurredAt: "2026-04-10T00:00:00.000Z" });
  await d.drain();

  // ── 9. 5/1 지급(운영) → 명세: 빅히트(포털, 레이블·소속사), 멤버(실연자 앱, 기여분) ─────────────────────────────
  await d.setClock("2026-05-01T09:00:00.000Z");
  log("9. 지급과 명세");
  const payout = await ops(P.settle, "POST", "/payout-runs", { payoutRunId: "pay-2026-05", asOf: "2026-05-01T09:00:00.000Z" });
  await d.drain();
  const statement = (party: string) => portal(P.rights, "GET", `/parties/${party}/statements?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z`);
  return {
    validationBlocksBeforeActivation: blocks.map((i: any) => `${i.rule} ${i.subjectId}`),
    issued, soloRejected: { status: solo.status, code: solo.body?.code },
    runs: runs.map((r) => `${r.runId} ${r.status}`),
    payout,
    statements: { label: await statement("pty_bighit_label"), agency: await statement("pty_bighit_agency") },
    contributions: await performer(P.member("jungkook"), "GET", "/contributions?from=2026-01-01T00:00:00.000Z&to=2026-05-02T00:00:00.000Z"),
  };
}
