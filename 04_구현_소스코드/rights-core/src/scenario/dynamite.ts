import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { applyActorScope, createUser, ensureSystemIdentities, loadActor, type Actor } from "../platform/actor.ts";
import { fixedClock, type Clock } from "../platform/clock.ts";
import { createDb, type Db, type Tx } from "../platform/db.ts";
import { ADMIN_URL, createFreshDatabase } from "../platform/dbadmin.ts";
import { startBossJobs, JOB_NAMES, type JobHandler, type JobName } from "../platform/jobs.ts";
import { createBridgeCtx } from "../engine-bridge/context.ts";
import { createFsBlobStore } from "../engine-bridge/blob-fs.ts";
import { simulateEvents } from "../engine-bridge/simulate.ts";
import { decideGrant, loadGrantRules, type GrantRule, type Requirement } from "../engine-bridge/grant.ts";
import { signConsent } from "../registry/consents.ts";
import { markIdentityVerified } from "../performer/identity.ts";
import * as reg from "../registry/service.ts";
import * as policy from "../policy/service.ts";
import * as issuance from "../issuance/service.ts";
import { ingestRevenue, type RevenueInput } from "../revenue/service.ts";
import { confirmBatch, createBatch, refundHook, revisionHook } from "../settlement/service.ts";
import { jobHandlers } from "../settlement/handlers.ts";
import { audioJobHandlers } from "../audio/handlers.ts";
import { fakeProvider } from "../payout/fake-provider.ts";
import { payoutJobHandlers, recordWebhook } from "../payout/handlers.ts";
import { createPayoutRun, setPayoutProfile } from "../payout/service.ts";
import { partyStatement } from "../ledger/statements.ts";

/**
 * 가상 시나리오: BTS "Dynamite"(2020)의 보컬 재배치 2차 이용(팬앱 전용)을 권리 등록부터 지급·명세까지 실제 코어로 돌린다.
 * 설명용 가상 사례다. 실제 정보로 쓴 것은 곡 크레딧(작사·작곡 David Stewart·Jessica Agombar), 재생 시간 3:19, 멤버 7명과
 * 멤버별 총 가창 시간(팬 집계 근사치)뿐이다. 지분·분배율·가격·판매량·계약 관계, 멤버 전원이 모든 파트를 녹음했다는 설정,
 * 파트를 멤버별 묶음으로 나눈 슬롯 구성은 모두 가정이며 실제 권리관계·계약·정산과 무관하다.
 *
 *   npm run scenario:dynamite -w rights-core -- --out <디렉터리>   (docker compose up -d 필요)
 */

const T0 = "2026-01-01T00:00:00.000Z";
const SCOPE = "fsc_dynamite";
const PACK = "pak_dynamite_fan";
const RECORDING = "rcd_dynamite";
const PRICE = 3300n;
const BATCH = "bat_bts_2026_03";

/** 멤버와 원곡 총 가창 시간(ms, 팬 집계 근사치). 슬롯 하나 = 그 멤버가 원곡에서 부른 파트 묶음(연속 구간이 아니다). */
export const MEMBERS = [
  { key: "jungkook", name: "정국", ms: 71890 },
  { key: "jimin", name: "지민", ms: 40820 },
  { key: "v", name: "뷔", ms: 26240 },
  { key: "jin", name: "진", ms: 22970 },
  { key: "rm", name: "RM", ms: 18080 },
  { key: "jhope", name: "제이홉", ms: 6550 },
  { key: "suga", name: "슈가", ms: 6240 },
] as const;
type MemberKey = (typeof MEMBERS)[number]["key"];
const SLOTS = (() => {
  let at = 0;
  return MEMBERS.map((m) => {
    const s = { id: `slt_part_${m.key}`, owner: m.key, label: `${m.name} 파트`, startMs: at, endMs: at + m.ms };
    at += m.ms;
    return s;
  });
})();

export const NAMES: Record<string, string> = {
  pty_bighit_label: "빅히트 뮤직 — 레이블(마스터 보유, 가정)",
  pty_bighit_agency: "빅히트 뮤직 — 소속사(멤버 실연 몫 수령, 가정)",
  pty_david_stewart: "David Stewart(작사·작곡, 지분 가정 50%)",
  pty_jessica_agombar: "Jessica Agombar(작사·작곡, 지분 가정 50%)",
  ...Object.fromEntries(MEMBERS.map((m) => [`pty_${m.key}`, m.name])),
};

/** 권리 생성 시 권리자가 정하는 분배 규칙(MDRL 정책). 분배율은 가정이다. */
export const POLICY_TEXT = `allocation "pol_dynamite_fan" version 1 {
  uses facts "${SCOPE}"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: ${PACK}; events: [PRIMARY, TRAFFIC]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) via mandate : 45%;
      work = graph(WORK_AUTHOR) : 15%;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
`;

/** 팬 조합 4개: 파트(슬롯)마다 부를 멤버를 고른다. 적지 않은 파트는 원곡 멤버가 부른다. */
export const COMBINATIONS: { vcId: string; fan: string; title: string; swap: Partial<Record<MemberKey, MemberKey>>; purchases: number }[] = [
  { vcId: "vc_bts_orig", fan: "팬 F1", title: "원곡 배치", swap: {}, purchases: 1200 },
  { vcId: "vc_bts_swap", fan: "팬 F2", title: "정국·지민 파트 맞바꾸기", swap: { jungkook: "jimin", jimin: "jungkook" }, purchases: 500 },
  { vcId: "vc_bts_vocal", fan: "팬 F3", title: "랩 파트를 보컬 멤버가", swap: { rm: "jin", suga: "v", jhope: "jimin" }, purchases: 300 },
  { vcId: "vc_bts_jin", fan: "팬 F4", title: "진이 정국·지민 파트까지", swap: { jungkook: "jin", jimin: "jin" }, purchases: 200 },
];
const singerOf = (c: (typeof COMBINATIONS)[number], slotOwner: MemberKey): MemberKey => c.swap[slotOwner] ?? slotOwner;

/** 멤버 비율(bps): 맡은 파트 수 비례, 합 10000이 되도록 최대잉여법. */
function memberBps(singers: MemberKey[]): Record<string, number> {
  const counts = new Map<MemberKey, number>();
  for (const s of singers) counts.set(s, (counts.get(s) ?? 0) + 1);
  const parts = [...counts].map(([k, n]) => ({ k, exact: (n * 10000) / singers.length }));
  const out = Object.fromEntries(parts.map((p) => [p.k, Math.floor(p.exact)]));
  let rest = 10000 - Object.values(out).reduce((a, b) => a + b, 0);
  for (const p of [...parts].sort((a, b) => (b.exact % 1) - (a.exact % 1) || (a.k < b.k ? -1 : 1))) {
    if (rest-- <= 0) break;
    out[p.k]! += 1;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`pty_${k}`, v]));
}

async function seed(tx: Tx, clock: Clock, rights: Actor): Promise<void> {
  const parties: [string, reg.PartyType][] = [
    ["pty_bighit_label", "LABEL"], ["pty_bighit_agency", "AGENCY"], ["pty_david_stewart", "AUTHOR"], ["pty_jessica_agombar", "AUTHOR"],
    ...MEMBERS.map((m): [string, reg.PartyType] => [`pty_${m.key}`, "MEMBER"]),
  ];
  for (const [id, t] of parties) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: NAMES[id]! });
  await reg.registerWork(tx, clock, { workId: "wrk_dynamite", title: "Dynamite" });
  await reg.createScope(tx, clock, { factsScopeId: SCOPE, workId: "wrk_dynamite" });
  await reg.registerRecording(tx, clock, { recordingId: RECORDING, workId: "wrk_dynamite", masterOwnerPartyId: "pty_bighit_label", versionTitle: "Vocal Recombination" });
  let sort = 1;
  for (const s of SLOTS) await reg.registerSlot(tx, { slotId: s.id, recordingId: RECORDING, startMs: s.startMs, endMs: s.endMs, sortOrder: sort++ });
  await reg.registerSlot(tx, { slotId: "slt_mr", recordingId: RECORDING, startMs: 0, endMs: 199000, sortOrder: sort });
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: RECORDING, rightsBearing: false });
  const base = { factsScopeId: SCOPE, status: "VERIFIED" as const, validFrom: T0 };
  for (const m of MEMBERS) {
    await reg.registerVoice(tx, clock, { voiceId: `voc_${m.key}`, factsScopeId: SCOPE, kind: "HUMAN" });
    for (const s of SLOTS) {
      const stemId = `stm_${m.key}_${s.owner}`;
      await reg.registerStem(tx, clock, { stemId, slotId: s.id, recordingId: RECORDING, performerPartyId: `pty_${m.key}`, rightsBearing: true });
      await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${m.key}_${s.owner}`, sourceId: stemId, edge: "PERFORMED_BY", targetId: `voc_${m.key}`, shareBps: 10000, performerRole: "FEATURED" });
    }
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${m.key}`, sourceId: `voc_${m.key}`, edge: "OWNED_BY", targetId: `pty_${m.key}`, shareBps: 10000 });
    await reg.recordMandate(tx, clock, { ...base, mandateId: `m_agency_${m.key}`, fromPartyId: `pty_${m.key}`, toPartyId: "pty_bighit_agency", rightKind: "PERFORMER", shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: RECORDING, edge: "CONTROLLED_BY", targetId: "pty_bighit_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_work_ds", sourceId: "wrk_dynamite", edge: "WRITTEN_BY", targetId: "pty_david_stewart", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_work_ja", sourceId: "wrk_dynamite", edge: "WRITTEN_BY", targetId: "pty_jessica_agombar", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" });
  await issuance.createPack(tx, clock, rights, { packId: PACK, packCode: "DYNAMITE-FAN", title: "Dynamite 팬앱 전용 보컬 조합", factsScopeId: SCOPE });
  await issuance.setPackClaimants(tx, clock, rights, PACK, [
    { role: "AGENCY", party: "pty_bighit_agency" }, { role: "MASTER_OWNER", party: "pty_bighit_label" },
    ...MEMBERS.map((m) => ({ role: "PERFORMER_FEATURED", party: `pty_${m.key}` })),
    { role: "WORK_AUTHOR", party: "pty_david_stewart" }, { role: "WORK_AUTHOR", party: "pty_jessica_agombar" },
  ]);
}

const FAN_ONLY = { actions: ["PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] };

/**
 * 팬앱 전용 이용허락 동의(가정)를 코어에 저장한다(다음 작업 2). 멤버 7명은 실연자 앱 계정(본인 파티)으로 자기 보이스에 서명하고,
 * 레이블(녹음)·작가(작품) 허락은 플랫폼이 계약서를 근거로 옮겨 적는다.
 */
async function signConsents(tx: Tx, clock: Clock, rights: Actor): Promise<void> {
  const base = { factsScopeId: SCOPE, scope: FAN_ONLY, validFrom: T0, validTo: "2027-01-01T00:00:00.000Z" };
  const contract = (id: string) => ({ sourceContractUri: `contract://dynamite-fan/${id}` });
  await signConsent(tx, clock, rights, { ...base, consentId: "cst_master", partyId: "pty_bighit_label", rightType: "MASTER", assetId: RECORDING, ...contract("master") });
  for (const w of ["pty_david_stewart", "pty_jessica_agombar"]) {
    await signConsent(tx, clock, rights, { ...base, consentId: `cst_work_${w.slice(4)}`, partyId: w, rightType: "WORK", assetId: "wrk_dynamite", ...contract(w.slice(4)) });
  }
  for (const m of MEMBERS) {
    await createUser(tx, clock, { userId: `usr_member_${m.key}`, displayName: m.name, roles: ["PERFORMER"], tenantId: "tnt_platform_default", partyId: `pty_${m.key}` });
    await markIdentityVerified(tx, clock, `usr_member_${m.key}`, "SCENARIO"); // 실연자 앱에서 본인 인증을 마쳤다고 가정
    const self = await loadActor(tx, `usr_member_${m.key}`);
    await applyActorScope(tx, self);
    await signConsent(tx, clock, self, { ...base, consentId: `cst_vocal_${m.key}`, partyId: `pty_${m.key}`, rightType: "PERFORMER", assetId: `voc_${m.key}` });
    await tx.query("SELECT set_config('rc.scope', 'system', true)");
  }
}

/** 세 가지 이용 요청의 판정. 허락은 코어에 저장된 동의를 판정 시점(known_at)으로 읽은 것이다. */
function grantDemo(grants: GrantRule[]) {
  const scope = (actions: string[], media: string[], audience: string[]) =>
    ({ actions, territories: ["KR"], media, audience, period: { from: T0, to: "2027-01-01T00:00:00.000Z" } });
  const reqs = (c: (typeof COMBINATIONS)[number], s: ReturnType<typeof scope>): Requirement[] => [
    { id: "r_master", asset: RECORDING, right_type: "MASTER", scope: s },
    { id: "r_work", asset: "wrk_dynamite", right_type: "WORK", scope: s },
    ...[...new Set(SLOTS.map((sl) => singerOf(c, sl.owner)))].map((k) => ({ id: `r_vocal_${k}`, asset: `voc_${k}`, right_type: "PERFORMER", scope: s })),
  ];
  const at = { as_of: "2026-03-10T00:00:00.000Z", known_at: "2026-03-10T00:00:00.000Z" };
  const listen = scope(["PREVIEW", "COMBINE"], ["FAN_APP"], ["FAN_COMMUNITY"]);
  const download = scope(["DOWNLOAD"], ["EXTERNAL_SNS"], ["PUBLIC"]);
  const show = (case_: string, d: ReturnType<typeof decideGrant>) => ({ case: case_, result: d.result, reasons: [...d.reason_codes] });
  const orig = COMBINATIONS[0]!;
  return [
    show("팬앱에서 원곡 배치 조합 감상", decideGrant({ requirements: reqs(orig, listen), grants, ...at })),
    show("같은 조합을 내려받아 외부 SNS에 게시", decideGrant({ requirements: reqs(orig, download), grants, ...at })),
    show("멤버 한 명의 동의가 철회된 뒤(가정) 같은 조합 감상",
      decideGrant({ requirements: reqs(orig, listen), grants: grants.map((g) => (g.id === "cst_vocal_v" ? { ...g, status: "REVOKED" as const } : g)), ...at })),
  ];
}

async function waitQueue(db: Db, name: JobName, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = (await db.pool.query("SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state = ANY('{created,retry,active}'::pgboss.job_state[])", [name])).rows[0].n as number;
    if (n === 0) return;
    if (Date.now() > deadline) throw new Error(`${name} did not drain`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

const rows = async (db: Db, sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
const evId = (vcId: string, n: number) => `ev_${vcId.replace("vc_bts_", "")}_${String(n).padStart(4, "0")}`;

export async function runDynamite(db: Db, appUrl: string, blobRoot: string) {
  const ctx = createBridgeCtx(createFsBlobStore(blobRoot));
  const c0 = fixedClock(T0, 0);
  const u = await db.tx(async (tx) => {
    const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"],
      ["ops", "SPACE_OPS"], ["settle", "SPACE_SETTLE"], ["accounts", "SPACE_SETTLE"]] as const;
    const out: Record<string, Actor> = {};
    for (const [name, role] of spec) {
      await createUser(tx, c0, { userId: `usr_${name}`, displayName: name, roles: [role] });
      out[name] = await loadActor(tx, `usr_${name}`);
    }
    await ensureSystemIdentities(tx, c0);
    out.ingest = await loadActor(tx, "sys_ingest");
    return out;
  });

  // 1. 권리 생성: 곡·녹음·파트 슬롯 7개·보컬 스템 49개·권리 주장·멤버→소속사 실연 위임, 팬앱 전용 팩.
  await db.tx((tx) => seed(tx, c0, u.rights!));
  // 2. 권리자 승인: 정책 작성(EDITOR) → 승인(WORK_APPROVER) → 활성화(ACTIVATOR), 팩 활성화.
  const c1 = fixedClock("2026-02-01T00:00:00.000Z", 1);
  const compiled = await db.tx((tx) => policy.compilePolicy(ctx, tx, c1, u.editor!, { policyId: "pol_dynamite_fan", packId: PACK, sourceText: POLICY_TEXT }));
  await db.tx((tx) => policy.approvePolicy(ctx, tx, c1, u.approver!, compiled));
  await db.tx((tx) => policy.activatePolicy(ctx, tx, c1, u.activator!, compiled));
  await db.tx((tx) => issuance.activatePack(ctx, tx, c1, u.activator!, PACK));
  const active = (await db.tx((tx) => policy.activePolicyForPack(tx, PACK)))!;

  // 3. 이용허락: 동의 저장(멤버 본인 서명, 레이블·작가 계약) → 판정 시점 기준으로 읽어 세 요청을 판정.
  await db.tx((tx) => signConsents(tx, fixedClock("2026-01-20T00:00:00.000Z", 1), u.rights!));
  const grants = grantDemo(await db.tx((tx) => loadGrantRules(tx, SCOPE, "2026-03-10T00:00:00.000Z")));

  // 4. 팬 조합 발행: 게이트 통과 → 스냅샷 동결·발행 봉인.
  const c2 = fixedClock("2026-02-15T00:00:00.000Z", 1);
  const seals: { vcId: string; fan: string; title: string; singers: Record<string, string>; members: Record<string, number>; snapshotId: string; projectionDigest: string; membersDigest: string }[] = [];
  for (const cb of COMBINATIONS) {
    const singers = SLOTS.map((s) => singerOf(cb, s.owner));
    const members = memberBps(singers);
    const seal = await db.tx((tx) => issuance.issue(ctx, tx, c2, u.issuer!, {
      packId: PACK, vcId: cb.vcId, members,
      assignments: [...SLOTS.map((s, k) => ({ slotId: s.id, stemId: `stm_${singers[k]}_${s.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
    }));
    seals.push({
      vcId: cb.vcId, fan: cb.fan, title: cb.title, singers: Object.fromEntries(SLOTS.map((s, k) => [s.owner, singers[k]!])), members,
      snapshotId: seal.snapshotId, projectionDigest: seal.projectionDigest, membersDigest: seal.membersDigest,
    });
  }
  const rejected = await db.tx((tx) => issuance.issue(ctx, tx, c2, u.issuer!, {
    packId: PACK, vcId: "vc_bts_solo", members: { pty_jungkook: 10000 },
    assignments: [...SLOTS.map((s) => ({ slotId: s.id, stemId: `stm_jungkook_${s.owner}` })), { slotId: "slt_mr", stemId: "stm_mr" }],
  })).then(() => "ISSUED", (e: unknown) => (e as { code?: string }).code ?? String(e));

  // 5. 매출(3월): 조합 소장 구매(PRIMARY). vc_bts_jin의 1건은 이상거래 의심(FLAGGED).
  const settleClock = fixedClock("2026-04-01T00:00:00.000Z", 1);
  const jobs = await startBossJobs(appUrl, { batchSize: 20, localConcurrency: 4 });
  const provider = fakeProvider({ outcome: () => "PAID" });
  try {
    const d = { db, ctx, clock: settleClock, jobs };
    const handlers = { ...jobHandlers(d), ...payoutJobHandlers({ db, clock: settleClock, jobs, provider, pollDelaySeconds: 1 }), ...audioJobHandlers({ db, clock: settleClock }) };
    for (const n of JOB_NAMES) if (handlers[n] === undefined) throw new Error(`missing job handler: ${n}`);
    await jobs.work(handlers as Record<JobName, JobHandler>);
    const onRefund = refundHook(jobs), onRevision = revisionHook(jobs);
    const ingest = (i: RevenueInput) => db.tx((tx) => ingestRevenue(tx, settleClock, u.ingest!, i, onRefund, onRevision));
    let k = 0;
    for (const cb of COMBINATIONS) {
      for (let i = 1; i <= cb.purchases; i++, k++) {
        const id = evId(cb.vcId, i);
        await ingest({
          eventId: id, sourceSystem: "fan_app", sourceEventId: id, eventType: "PURCHASE", vcId: cb.vcId, amountKrw: PRICE.toString(), currency: "KRW",
          integrity: cb.vcId === "vc_bts_jin" && i === 1 ? "FLAGGED" : "CLEAR",
          occurredAt: new Date(Date.parse("2026-03-01T00:00:00.000Z") + k * 60_000).toISOString(),
        });
      }
    }
    await jobs.drainIdle(600_000);

    // 6. 정산: 배치 생성(SPACE_OPS) → 엔진 평가·봉인 → 독립 재계산 검증 → 확정(SPACE_SETTLE) → 원장 반영.
    await createBatch(d, u.ops!, { batchId: BATCH, periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-04-01T00:00:00.000Z" });
    await jobs.drainIdle(600_000);
    const runStatus = await rows(db, "SELECT status, count(*)::int AS n FROM settlement_run WHERE batch_id = $1 GROUP BY status", [BATCH]);
    await confirmBatch(d, u.settle!, BATCH);
    await jobs.drainIdle(600_000);

    // 7. 확정 후 환불: 원곡 배치 조합의 첫 구매를 전액 환불 → 역분개.
    const firstEvent = evId("vc_bts_orig", 1);
    await ingest({ eventId: "ev_rf_0001", sourceSystem: "fan_app", sourceEventId: "ev_rf_0001", eventType: "REFUND", relatedEventId: firstEvent,
      amountKrw: PRICE.toString(), currency: "KRW", occurredAt: "2026-04-10T00:00:00.000Z" });
    await jobs.drainIdle(600_000);

    // 8. 지급: 권리자 프로필(1월 등록, 계좌 토큰은 지급 실행자와 다른 사용자가 등록) → 지급 실행 → PSP webhook.
    const payClock = fixedClock("2026-05-01T00:00:00.000Z", 1);
    const payees = (await rows(db, "SELECT party_id FROM ledger_account WHERE kind = 'PARTY_PAYABLE' ORDER BY party_id")).map((r) => r.party_id as string);
    await db.tx(async (tx) => {
      for (const p of payees) {
        const taxType = p.startsWith("pty_bighit") ? "DOMESTIC_CORP" : p === "pty_david_stewart" || p === "pty_jessica_agombar" ? "FOREIGN" : "DOMESTIC_INDIVIDUAL";
        await setPayoutProfile(tx, c0, u.accounts!, { partyId: p, taxType, payoutAccountRef: `tok_${p}`, kycVerified: true });
      }
    });
    await jobs.stop();
    const jobs2 = await startBossJobs(appUrl, { batchSize: 20, localConcurrency: 4 });
    try {
      const h2 = { ...jobHandlers({ db, ctx, clock: payClock, jobs: jobs2 }), ...payoutJobHandlers({ db, clock: payClock, jobs: jobs2, provider, pollDelaySeconds: 1 }) };
      await jobs2.work(h2 as Record<JobName, JobHandler>);
      const run = await createPayoutRun({ db, clock: payClock, jobs: jobs2 } as never, u.settle!, { payoutRunId: "pay-2026-05", asOf: payClock.now() });
      await waitQueue(db, "submit-payout", 600_000);
      for (const r of await rows(db, "SELECT idempotency_key FROM payout_instruction WHERE payout_run_id = 'pay-2026-05' AND submit_attempted_at IS NOT NULL ORDER BY instruction_id")) {
        await db.tx((tx) => recordWebhook(tx, payClock, jobs2, { ...provider.webhook(r.idempotency_key as string), payload: { source: "dynamite" } }));
      }
      await jobs2.drainIdle(600_000);

      // 9. 시뮬레이션(봉인·원장 없음): (a) 조합별 구매 1건의 멤버별 실연 기여분 — 소속사 라우팅 전, (b) 감상 매출(TRAFFIC).
      const noRouting = (p: Parameters<NonNullable<Parameters<typeof simulateEvents>[2]["variant"]>>[0]) => {
        for (const b of p.body.tier2.split) delete b.via_mandate;
        return p;
      };
      const contributions = await db.tx(async (tx) => {
        const out: Record<string, { party: string; amount: string }[]> = {};
        for (const s of seals) {
          const r = await simulateEvents(ctx, tx, { snapshotId: s.snapshotId, runId: `sim_contrib_${s.vcId}`, variant: noRouting,
            events: [{ id: "ev_sim_one", type: "PRIMARY", amount: PRICE.toString(), currency: "KRW", integrity: "CLEAR" }] });
          if (!r.ok) throw new Error(JSON.stringify(r.errors));
          out[s.vcId] = r.value.lines.filter((l) => l.bucket === "performer").map((l) => ({ party: l.party, amount: l.amount }));
        }
        return out;
      });
      const traffic = await db.tx((tx) => simulateEvents(ctx, tx, { snapshotId: seals[0]!.snapshotId, runId: "sim_traffic_2026_03",
        events: [{ id: "ev_traffic_2026_03_orig", type: "TRAFFIC", amount: "50000", currency: "KRW", integrity: "CLEAR" }] }));

      // 10. 보고서.
      return {
        assumptions: { price: PRICE.toString(), slots: SLOTS, names: NAMES, policyText: POLICY_TEXT, combinations: COMBINATIONS },
        policy: { policyId: active.policyId, version: active.version, factsDigest: active.factsDigest, policyDigest: active.policyDigest },
        grants,
        issued: seals, rejectedSolo: rejected,
        revenue: await rows(db, "SELECT vc_id, event_type, integrity_status, count(*)::int AS n, sum(net_amount_krw)::text AS krw FROM revenue_event GROUP BY 1,2,3 ORDER BY 1,2,3"),
        runStatus,
        runs: await rows(db, "SELECT r.run_id, rs.vc_id, r.status, r.result_digest FROM settlement_run r JOIN rights_snapshot rs ON rs.snapshot_id = r.snapshot_id WHERE r.batch_id = $1 ORDER BY rs.vc_id", [BATCH]),
        firstEvent: {
          eventId: firstEvent,
          pool: await rows(db, "SELECT bucket, amount_krw::text AS krw FROM pool_line WHERE event_id = $1 AND line_seq = 1 ORDER BY amount_krw DESC, bucket", [firstEvent]),
          lines: await rows(db, "SELECT party_id, role, bucket, amount_krw::text AS krw FROM allocation_line WHERE event_id = $1 AND line_seq = 1 ORDER BY amount_krw DESC, party_id", [firstEvent]),
        },
        contributions,
        byParty: await rows(db, `SELECT l.party_id, l.role, sum(l.amount_krw) FILTER (WHERE l.line_seq = 1)::text AS settled_krw, COALESCE(sum(l.amount_krw) FILTER (WHERE l.line_seq > 1), 0)::text AS reversed_krw
                                 FROM allocation_line l JOIN settlement_run r USING (run_id) WHERE r.batch_id = $1 GROUP BY 1,2 ORDER BY sum(l.amount_krw) FILTER (WHERE l.line_seq = 1) DESC, l.party_id`, [BATCH]),
        pools: await rows(db, `SELECT p.bucket, sum(p.amount_krw)::text AS krw FROM pool_line p JOIN settlement_run r USING (run_id) WHERE r.batch_id = $1 GROUP BY 1 ORDER BY sum(p.amount_krw) DESC, p.bucket`, [BATCH]),
        holdings: await rows(db, "SELECT event_id, bucket, reason, amount_krw::text AS krw FROM unallocated_holding ORDER BY event_id, line_seq"),
        reversals: await rows(db, "SELECT reversal_id, original_run_id, event_id, refund_event_id, result_digest FROM reversal_run ORDER BY reversal_id"),
        journal: await rows(db, "SELECT kind, count(*)::int AS n FROM journal_entry GROUP BY kind ORDER BY kind"),
        payout: { counts: run.counts, instructions: await rows(db, "SELECT party_id, status, gross_krw::text, withholding_krw::text, net_krw::text, hold_reason FROM payout_instruction ORDER BY gross_krw::bigint DESC, party_id") },
        // 한 트랜잭션의 쿼리는 차례로 보낸다(한 연결에서 동시 쿼리는 pg 9에서 제거된다).
        statements: await db.tx(async (tx) => { const out = []; for (const p of payees) out.push(await partyStatement(tx, p, T0, payClock.now())); return out; }),
        traffic: traffic.ok
          ? { ok: true, pool: traffic.value.pool_lines, lines: traffic.value.lines, holdings: traffic.value.holdings, resultDigest: traffic.value.result_digest }
          : { ok: false, errors: traffic.errors },
      };
    } finally {
      await jobs2.stop();
    }
  } finally {
    await jobs.stop().catch(() => {});
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const fresh = await createFreshDatabase(ADMIN_URL);
  const db = createDb(fresh.appUrl);
  const blobRoot = mkdtempSync(join(tmpdir(), "rc-dynamite-"));
  try {
    const report = await runDynamite(db, fresh.appUrl, blobRoot);
    const json = JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    if (values.out !== undefined) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, "dynamite-report.json"), json + "\n");
    }
    console.log(json);
  } finally {
    await db.close();
    await fresh.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  }
}
