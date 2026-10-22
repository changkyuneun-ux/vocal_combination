import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";
import { fixedClock } from "../../src/platform/clock.ts";
import { registerParty, registerRecording, registerSlot, registerSlotPart, registerStem, registerWork, createScope } from "../../src/registry/service.ts";
import { loadFactsRows } from "../../src/engine-bridge/facts.ts";
import { buildFactsDocument } from "../../src/engine-bridge/convert-facts.ts";
import { getScopeFacts } from "../../src/registry/queries.ts";

// 슬롯·파트(결정 SL1·SL6·SL7): 기존 슬롯은 파트 1로 옮겨지고, 스템은 파트를 가리킨다.
const { db, drop } = await freshDb();
after(drop);
const clock = fixedClock("2026-01-01T00:00:00.000Z", 1000);

test("slot_part exists with kinds and stem/assignment carry part_no", async () => {
  const cols = async (t: string) => (await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [t])).rows.map((r) => r.column_name);
  assert.ok((await cols("slot_part")).includes("kind"));
  assert.ok((await cols("stem")).includes("part_no"));
  assert.ok((await cols("snapshot_stem_assignment")).includes("part_no"));
  assert.ok((await cols("part_slot")).includes("section_label"));
  const pk = (await db.pool.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'snapshot_stem_assignment'::regclass AND i.indisprimary ORDER BY a.attname`)).rows.map((r) => r.attname);
  assert.deepEqual(pk, ["part_no", "slot_id", "snapshot_id"]);
});

test("a slot with two vocal parts: stems per part, facts carry part only when a slot has several", async () => {
  await db.tx(async (tx) => {
    for (const [id, t] of [["pa", "MEMBER"], ["pb", "MEMBER"], ["pty_label", "LABEL"]] as const) await registerParty(tx, clock, { partyId: id, partyType: t, displayName: id });
    await registerWork(tx, clock, { workId: "w", title: "Song" });
    await createScope(tx, clock, { factsScopeId: "sc", workId: "w" });
    await registerRecording(tx, clock, { recordingId: "r", workId: "w", masterOwnerPartyId: "pty_label", versionTitle: "Main" });
    await registerSlot(tx, clock, { slotId: "s_ch", recordingId: "r", startMs: 0, endMs: 18000, sortOrder: 1, sectionLabel: "Chorus 1",
      parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pa" }, { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 9000, endMs: 18000, originalPartyId: "pb" }, { partNo: 3, kind: "INSTRUMENT", startMs: 0, endMs: 18000 }] });
    await registerSlot(tx, clock, { slotId: "s_in", recordingId: "r", startMs: 18000, endMs: 22000, sortOrder: 2, sectionLabel: "Intro" });
    await registerStem(tx, clock, { stemId: "st_ch_1_a", slotId: "s_ch", partNo: 1, recordingId: "r", performerPartyId: "pa", rightsBearing: true });
    await registerStem(tx, clock, { stemId: "st_ch_2_b", slotId: "s_ch", partNo: 2, recordingId: "r", performerPartyId: "pb", rightsBearing: true });
    await registerStem(tx, clock, { stemId: "st_in", slotId: "s_in", recordingId: "r", rightsBearing: false });
  });
  const rows = await db.tx((tx) => loadFactsRows(tx, "sc", clock.now()));
  const doc = buildFactsDocument(rows, clock.now());
  const byId = Object.fromEntries(doc.body.stems.map((s) => [s.id, s]));
  assert.equal(byId.st_ch_1_a!.part, "1");
  assert.equal(byId.st_ch_2_b!.part, "2");
  assert.equal(byId.st_in!.part, undefined, "a slot with one part does not write part (digest unchanged)");
  await assert.rejects(db.tx((tx) => registerSlotPart(tx, clock, "s_in", { partNo: 2, kind: "VOCAL", startMs: 0, endMs: 30000, originalPartyId: "pa" })), /PART_OUTSIDE_SLOT/);
  // 조회: 슬롯마다 구간 이름과 파트, 스템마다 파트 번호
  const f = await db.tx((tx) => getScopeFacts(tx, "sc"));
  const ch = f.slots.find((s) => s.slotId === "s_ch")!;
  assert.equal(ch.sectionLabel, "Chorus 1");
  assert.deepEqual(ch.parts.map((p) => [p.partNo, p.kind, p.startMs, p.endMs, p.originalPartyId]), [[1, "VOCAL", 0, 9000, "pa"], [2, "VOCAL", 9000, 18000, "pb"], [3, "INSTRUMENT", 0, 18000, null]]);
  assert.deepEqual(f.slots.find((s) => s.slotId === "s_in")!.parts.map((p) => p.kind), ["INSTRUMENT"]);
  assert.equal(f.stems.find((s) => s.stemId === "st_ch_2_b")!.partNo, 2);
});
