import { test, after } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../helpers.ts";

// 슬롯·파트(결정 SL1·SL6·SL7): 기존 슬롯은 파트 1로 옮겨지고, 스템은 파트를 가리킨다.
const { db, drop } = await freshDb();
after(drop);

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
