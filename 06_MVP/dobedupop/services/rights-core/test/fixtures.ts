import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../src/platform/clock.ts";
import type { Tx } from "../src/platform/db.ts";
import { createUser, loadActor, type Actor } from "../src/platform/actor.ts";
import * as reg from "../src/registry/service.ts";
import { recordContractConsents } from "../src/registry/consents.ts";
import { createBridgeCtx, type BridgeCtx } from "../src/engine-bridge/context.ts";
import { createFsBlobStore } from "../src/engine-bridge/blob-fs.ts";

export const T0 = "2026-01-01T00:00:00.000Z";
export const SCOPE = "fsc_nova";
export const PACK = "pak_nova";

export function tempBridge(): { ctx: BridgeCtx; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "rc-blobs-"));
  return { ctx: createBridgeCtx(createFsBlobStore(root)), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 사용자 5명: 권리 편집, 정책 편집, 승인, 활성화, 발행. */
export async function seedUsers(tx: Tx, clock: Clock): Promise<Record<"rights" | "editor" | "approver" | "activator" | "issuer", Actor>> {
  const spec = [["rights", "RIGHTS_EDITOR"], ["editor", "EDITOR"], ["approver", "WORK_APPROVER"], ["activator", "ACTIVATOR"], ["issuer", "ISSUER"]] as const;
  const out: Record<string, Actor> = {};
  for (const [name, role] of spec) {
    await createUser(tx, clock, { userId: `usr_${name}`, displayName: name, roles: [role] });
    out[name] = await loadActor(tx, `usr_${name}`);
  }
  return out as never;
}

/**
 * 작은 곡: 멤버 2명(a·b)이 각자 슬롯 1개를 부르고, MR 1개(정산 대상 아님).
 * 작사·작곡 60/40, 작가 b는 CMO에 위임, 멤버 a는 기획사에 위임, 레이블 마스터 100%.
 */
export async function seedSong(tx: Tx, clock: Clock): Promise<void> {
  const P: [string, reg.PartyType][] = [
    ["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"],
    ["pty_cmo", "CMO"], ["pty_member_a", "MEMBER"], ["pty_member_b", "MEMBER"],
  ];
  for (const [id, t] of P) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: id });
  await reg.registerWork(tx, clock, { workId: "wrk_nova", title: "Nova" });
  await reg.createScope(tx, clock, { factsScopeId: SCOPE, workId: "wrk_nova" });
  await reg.registerRecording(tx, clock, { recordingId: "rcd_nova", workId: "wrk_nova", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  await reg.registerSlot(tx, clock, { slotId: "slt_1", recordingId: "rcd_nova", startMs: 0, endMs: 30000, sortOrder: 1 });
  await reg.registerSlot(tx, clock, { slotId: "slt_2", recordingId: "rcd_nova", startMs: 30000, endMs: 90000, sortOrder: 2 });
  await reg.registerSlot(tx, clock, { slotId: "slt_mr", recordingId: "rcd_nova", startMs: 0, endMs: 90000, sortOrder: 3 });
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await reg.registerStem(tx, clock, { stemId: `stm_${m}${s}`, slotId: `slt_${s}`, recordingId: "rcd_nova", performerPartyId: `pty_member_${m}`, rightsBearing: true });
  }
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: "rcd_nova", rightsBearing: false });
  for (const m of ["a", "b"]) await reg.registerVoice(tx, clock, { voiceId: `vo_${m}`, factsScopeId: SCOPE, kind: "HUMAN" });
  const base = { factsScopeId: SCOPE, status: "VERIFIED" as const, validFrom: T0 };
  for (const m of ["a", "b"]) for (const s of ["1", "2"]) {
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${m}${s}`, sourceId: `stm_${m}${s}`, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" });
  }
  for (const m of ["a", "b"]) {
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: "rcd_nova", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_music", sourceId: "wrk_nova", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 });
}

/** 계약서로 옮겨 적는 팬앱 전용 허락 범위(발행 기본 이용 범위 COMBINE/KR/FAN_APP/FAN_COMMUNITY를 포함한다). */
export const CONTRACT_SCOPE = { actions: ["PREVIEW", "COMBINE", "PERSONAL_HOLD", "SHARE_LINK"], territories: ["KR"], media: ["FAN_APP"], audience: ["FAN_COMMUNITY"] };

/** 발행 게이트(다음 작업 3)를 통과하도록 범위의 모든 허락 주체(녹음·작품·보이스)의 동의를 계약서 근거로 기록한다. seedUsers 뒤에 부른다. */
export async function seedConsents(tx: Tx, clock: Clock, factsScopeId = SCOPE): Promise<string[]> {
  return recordContractConsents(tx, clock, await loadActor(tx, "usr_rights"), {
    factsScopeId, scope: CONTRACT_SCOPE, validFrom: T0, validTo: "2030-01-01T00:00:00.000Z", contractUri: "contract://test",
  });
}

/** seedSong의 청구권자 선언(적합성 001-basic과 같은 구조). */
export const DECLARED = [
  { role: "AGENCY", party: "pty_agency" }, { role: "CMO", party: "pty_cmo" }, { role: "MASTER_OWNER", party: "pty_label" },
  { role: "PERFORMER_FEATURED", party: "pty_member_a" }, { role: "PERFORMER_FEATURED", party: "pty_member_b" },
  { role: "WORK_AUTHOR", party: "pty_author_b" }, { role: "WORK_AUTHOR", party: "pty_author_c" },
];

/** seedSong용 정책. uses 줄의 digest는 자리표시이며 컴파일 시 현재 facts 봉인으로 덮어쓴다. */
export const POLICY_TEXT = `allocation "pol_nova" version 1 {
  uses facts "fsc_nova"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: pak_nova; events: [PRIMARY]; currency: KRW; }
  bind { time: ISSUE_TIME; }
  tier1 {
    platform = 25%;
    ops = 5%;
    rights = 70%;
  }
  tier2 rights {
    split {
      master = graph(MASTER_OWNER) : 40%;
      performer = performance_pool(HYBRID, fixed: 40%, usage: 60%, featured_weight: 70%) |> cap(50%) : 40%;
      work = graph(WORK_AUTHOR) via mandate : 10%;
      agency = contract(pty_agency) : 10% as AGENCY;
    }
  }
  rounding { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
`;

export async function actorOf(tx: Tx, userId: string): Promise<Actor> {
  return loadActor(tx, userId);
}
