import { describe, expect, it } from "vitest";
import { defaultForm } from "../../api/policyForm.ts";
import type { Claim, Mandate } from "../../api/types.ts";
import type { SlotWithParts, StemRow } from "../../api/works.ts";
import { memberProgress, previewLines, rightsBuckets, slotPartRows, slugId, stageBars, stemIdFor, stemMatrix, sungSeconds } from "./model.ts";

const claim = (claimId: string, edge: string, sourceId: string, targetId: string, shareBps: number, status = "VERIFIED"): Claim => ({
  claimId, version: 1, factsScopeId: "fsc_d", sourceId, edge, targetId, shareBps, performerRole: null, roleDetail: null, status,
  validFrom: "2026-01-01T00:00:00.000Z", validTo: null, recordedAt: "2026-01-01T00:00:00.000Z", supersededAt: null, evidenceDigest: null, visibility: null, sourceRef: null,
});
const M = ["pty_jungkook", "pty_jimin", "pty_v", "pty_jin", "pty_rm", "pty_jhope", "pty_suga"];
// 시안 Chorus 1: 파트 1 정국 · 파트 2 지민 · 파트 3 반주
const chorus: SlotWithParts = { slotId: "slt_s05", recordingId: "rcd_d", startMs: 39000, endMs: 57000, sortOrder: 5, sectionLabel: "Chorus 1", parts: [
  { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 48000, endMs: 57000, originalPartyId: "pty_jimin" },
  { partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 39000, endMs: 48000, originalPartyId: "pty_jungkook" },
  { partNo: 3, kind: "INSTRUMENT", role: null, startMs: 39000, endMs: 57000, originalPartyId: null },
] };
const intro: SlotWithParts = { slotId: "slt_s01", recordingId: "rcd_d", startMs: 0, endMs: 4000, sortOrder: 1, sectionLabel: "Intro", parts: [
  { partNo: 1, kind: "INSTRUMENT", role: null, startMs: 0, endMs: 4000, originalPartyId: null },
] };
const stem = (stemId: string, slotId: string, partNo: number, performerPartyId: string | null): StemRow => ({ stemId, slotId, partNo, recordingId: "rcd_d", performerPartyId, rightsBearing: performerPartyId !== null });
const stems = [stem("stm_s05_p1_jungkook", "slt_s05", 1, "pty_jungkook"), stem("stm_s05_p2_jimin", "slt_s05", 2, "pty_jimin"), stem("stm_s05_p2_jin", "slt_s05", 2, "pty_jin")];

describe("works model", () => {
  it("stage bars: done before, now at, todo after", () => {
    expect(stageBars(1)).toEqual(["done", "now", "todo", "todo", "todo"]);
    expect(stageBars(4)).toEqual(["done", "done", "done", "done", "now"]);
  });

  it("rights buckets: authors, label and member voices in three buckets", () => {
    const claims = [
      claim("c_work_ds", "WRITTEN_BY", "wrk_d", "pty_ds", 5000, "ASSERTED"), claim("c_work_ja", "WRITTEN_BY", "wrk_d", "pty_ja", 5000, "ASSERTED"),
      claim("c_master", "CONTROLLED_BY", "rcd_d", "pty_label", 10000),
      ...M.map((m) => claim(`c_own_${m}`, "OWNED_BY", m.replace("pty_", "voc_"), m, 10000, "ASSERTED")),
      { ...claim("c_old", "WRITTEN_BY", "wrk_d", "pty_x", 10000), supersededAt: "2026-01-02T00:00:00.000Z" },
    ];
    const b = rightsBuckets(claims, new Map([["pty_ds", "David Stewart"], ["pty_label", "빅히트 레이블"]]));
    expect(b.map((x) => [x.key, x.rows.length, x.totalBps])).toEqual([["work", 2, 10000], ["master", 1, 10000], ["performer", 7, 0]]);
    expect(b[0]!.rows[0]!.name).toBe("David Stewart");
    expect(b[0]!.rows[1]!.name).toBe("pty_ja");
  });

  it("slot part rows follow slot order then part number", () => {
    const rows = slotPartRows([chorus, intro]);
    expect(rows.map((r) => [r.slotNo, r.section, r.partNo, r.kind, r.original])).toEqual([
      [1, "Intro", 1, "INSTRUMENT", null], [2, "Chorus 1", 1, "VOCAL", "pty_jungkook"], [2, "Chorus 1", 2, "VOCAL", "pty_jimin"], [2, "Chorus 1", 3, "INSTRUMENT", null],
    ]);
  });

  it("stem matrix: vocal parts × members, original / registered / empty", () => {
    const m = stemMatrix(slotPartRows([chorus]), stems, M);
    expect(m.length).toBe(2);
    expect(m[0]!.map((c) => c.state)).toEqual(["original", "empty", "empty", "empty", "empty", "empty", "empty"]);
    expect(m[1]!.map((c) => c.state)).toEqual(["empty", "original", "empty", "registered", "empty", "empty", "empty"]);
    expect(m[1]![3]!.stemId).toBe("stm_s05_p2_jin");
  });

  it("member progress counts original parts, extra stems, consent and mandate", () => {
    const claims = [
      claim("c_own_jin", "OWNED_BY", "voc_jin", "pty_jin", 10000, "ASSERTED"), claim("c_own_jimin", "OWNED_BY", "voc_jimin", "pty_jimin", 10000),
      claim("c_perf_stm_s05_p2_jimin", "PERFORMED_BY", "stm_s05_p2_jimin", "voc_jimin", 10000), claim("c_perf_stm_s05_p2_jin", "PERFORMED_BY", "stm_s05_p2_jin", "voc_jin", 10000, "ASSERTED"),
    ];
    const consents = [{ consentId: "cst_jimin", factsScopeId: "fsc_d", partyId: "pty_jimin", rightType: "PERFORMER", assetId: "voc_jimin", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2027-01-01T00:00:00.000Z", status: "SIGNED" }];
    const mandates: Mandate[] = [{ mandateId: "m_jimin", version: 1, factsScopeId: "fsc_d", fromPartyId: "pty_jimin", toPartyId: "pty_agency", rightKind: "PERFORMER", shareBps: 10000,
      status: "VERIFIED", validFrom: "2026-01-01T00:00:00.000Z", validTo: null, recordedAt: "2026-01-01T00:00:00.000Z", supersededAt: null, visibility: null, sourceRef: null }];
    const [jimin, jin] = memberProgress([{ partyId: "pty_jimin", name: "지민" }, { partyId: "pty_jin", name: "진" }], claims, slotPartRows([chorus]), stems, consents, mandates, "2026-02-01T00:00:00.000Z");
    expect(jimin).toMatchObject({ voice: "voc_jimin", ownership: "확인됨", origParts: [1, 1], extraStems: [0, 0], consent: true, mandate: true, left: 0 });
    expect(jin).toMatchObject({ voice: "voc_jin", ownership: "대기", origParts: [0, 0], extraStems: [0, 1], consent: false, mandate: false, left: 4 });
  });

  it("preview lines match the mockup numbers (권리자 70 · 녹음 40 · 실연 45 · 작품 15, 3,300원)", () => {
    const sung = { 정국: 58.8, 지민: 37.2, 뷔: 17.2, 진: 18.8, RM: 8.7, 제이홉: 8.7, 슈가: 8.7 };
    const lines = previewLines(defaultForm("pak_d"), 3300, sung);
    const won = (prefix: string) => lines.find((l) => l.label.startsWith(prefix))!.won;
    expect(won("플랫폼")).toBeCloseTo(825);
    expect(won("운영")).toBeCloseTo(165);
    expect(won("권리자")).toBeCloseTo(2310);
    expect(won("녹음")).toBeCloseTo(924);
    expect(won("작품")).toBeCloseTo(173.25);
    expect(won("실연")).toBeCloseTo(1039.5);
    expect(won("· 정국")).toBeCloseTo(291.4, 1);
  });

  it("sung seconds add vocal part lengths to the singer", () => {
    expect(sungSeconds(slotPartRows([chorus, intro]))).toEqual({ pty_jungkook: 9, pty_jimin: 9 });
    expect(sungSeconds(slotPartRows([chorus]), (r) => (r.original === "pty_jimin" ? "pty_jin" : r.original))).toEqual({ pty_jungkook: 9, pty_jin: 9 });
  });

  it("ids: slug from title with a numeric tail when taken, stem id from slot/part/member", () => {
    expect(slugId("wrk", "E2E Song")).toBe("wrk_e2e_song");
    expect(slugId("wrk", "E2E Song", new Set(["wrk_e2e_song"]))).toBe("wrk_e2e_song_2");
    expect(slugId("wrk", "봄날")).toBe("wrk_song");
    expect(stemIdFor("slt_s05", 2, "pty_jin")).toBe("stm_s05_p2_jin");
  });
});
