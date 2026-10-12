import type { Actor } from "../platform/actor.ts";
import type { Clock } from "../platform/clock.ts";
import type { Tx } from "../platform/db.ts";
import * as reg from "../registry/service.ts";
import * as issuance from "../issuance/service.ts";

const T0 = "2026-01-01T00:00:00.000Z";

/**
 * 합성 곡(통합 설계 9.1): nova-debut-01을 확장한 곡 1개. 멤버 3명(a·b·c)이 슬롯 4개를 각자 녹음(스템 12개), MR 1개.
 * 작사·작곡 60/40(작가 b는 CMO 위임), 멤버 a는 기획사 위임, 레이블 마스터 100%.
 */
export const SONG = {
  scope: "fsc_nova_summer",
  pack: "pak_nova_summer",
  members: ["a", "b", "c"],
  slots: [
    { id: "slt_1", startMs: 0, endMs: 30000 },
    { id: "slt_2", startMs: 30000, endMs: 75000 },
    { id: "slt_3", startMs: 75000, endMs: 150000 },
    { id: "slt_4", startMs: 150000, endMs: 180000 },
  ],
  declared: [
    { role: "AGENCY", party: "pty_agency" }, { role: "CMO", party: "pty_cmo" }, { role: "MASTER_OWNER", party: "pty_label" },
    { role: "PERFORMER_FEATURED", party: "pty_member_a" }, { role: "PERFORMER_FEATURED", party: "pty_member_b" },
    { role: "PERFORMER_FEATURED", party: "pty_member_c" },
    { role: "WORK_AUTHOR", party: "pty_author_b" }, { role: "WORK_AUTHOR", party: "pty_author_c" },
  ],
  policyText: `allocation "pol_nova_summer" version 1 {
  uses facts "fsc_nova_summer"@1 digest "mdrl:sha256:${"0".repeat(64)}";
  scope { pack: pak_nova_summer; events: [PRIMARY]; currency: KRW; }
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
`,
};

export async function seedSyntheticSong(tx: Tx, clock: Clock, rights: Actor): Promise<void> {
  const parties: [string, reg.PartyType][] = [
    ["pty_label", "LABEL"], ["pty_agency", "AGENCY"], ["pty_author_b", "AUTHOR"], ["pty_author_c", "AUTHOR"], ["pty_cmo", "CMO"],
    ...SONG.members.map((m): [string, reg.PartyType] => [`pty_member_${m}`, "MEMBER"]),
  ];
  for (const [id, t] of parties) await reg.registerParty(tx, clock, { partyId: id, partyType: t, displayName: id });
  await reg.registerWork(tx, clock, { workId: "wrk_nova_summer", title: "Nova Summer" });
  await reg.createScope(tx, clock, { factsScopeId: SONG.scope, workId: "wrk_nova_summer" });
  await reg.registerRecording(tx, clock, { recordingId: "rcd_nova_summer", workId: "wrk_nova_summer", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
  let sort = 1;
  for (const s of SONG.slots) await reg.registerSlot(tx, { slotId: s.id, recordingId: "rcd_nova_summer", startMs: s.startMs, endMs: s.endMs, sortOrder: sort++ });
  await reg.registerSlot(tx, { slotId: "slt_mr", recordingId: "rcd_nova_summer", startMs: 0, endMs: 180000, sortOrder: sort });
  await reg.registerStem(tx, clock, { stemId: "stm_mr", slotId: "slt_mr", recordingId: "rcd_nova_summer", rightsBearing: false });
  const base = { factsScopeId: SONG.scope, status: "VERIFIED" as const, validFrom: T0 };
  for (const m of SONG.members) {
    await reg.registerVoice(tx, clock, { voiceId: `vo_${m}`, factsScopeId: SONG.scope, kind: "HUMAN" });
    for (const s of SONG.slots) {
      const stemId = `stm_${m}_${s.id}`;
      await reg.registerStem(tx, clock, { stemId, slotId: s.id, recordingId: "rcd_nova_summer", performerPartyId: `pty_member_${m}`, rightsBearing: true });
      await reg.recordClaim(tx, clock, { ...base, claimId: `c_perf_${m}_${s.id}`, sourceId: stemId, edge: "PERFORMED_BY", targetId: `vo_${m}`, shareBps: 10000, performerRole: "FEATURED" });
    }
    await reg.recordClaim(tx, clock, { ...base, claimId: `c_own_${m}`, sourceId: `vo_${m}`, edge: "OWNED_BY", targetId: `pty_member_${m}`, shareBps: 10000 });
  }
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_master", sourceId: "rcd_nova_summer", edge: "CONTROLLED_BY", targetId: "pty_label", shareBps: 10000 });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_lyrics", sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_author_b", shareBps: 6000, roleDetail: "LYRICS" });
  await reg.recordClaim(tx, clock, { ...base, claimId: "c_music", sourceId: "wrk_nova_summer", edge: "WRITTEN_BY", targetId: "pty_author_c", shareBps: 4000, roleDetail: "COMPOSITION" });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_cmo", fromPartyId: "pty_author_b", toPartyId: "pty_cmo", rightKind: "WORK", shareBps: 10000 });
  await reg.recordMandate(tx, clock, { ...base, mandateId: "m_agency", fromPartyId: "pty_member_a", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000 });
  await issuance.createPack(tx, clock, rights, { packId: SONG.pack, packCode: "NOVA-SUMMER", title: "Nova Summer", factsScopeId: SONG.scope });
  await issuance.setPackClaimants(tx, clock, rights, SONG.pack, SONG.declared);
}
