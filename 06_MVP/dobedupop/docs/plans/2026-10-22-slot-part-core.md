# 2부-A 코어: 슬롯·파트, IR 생성 전 편집, 권리 주장 함께 만들기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 슬롯을 원곡 흐름 구간으로, 그 안의 원곡 트랙을 파트(보컬·그룹·반주)로 관리하고, 2차 이용(조합)을 "슬롯·파트마다 스템 배치"로 바꾼다. 곡·녹음·슬롯·파트·스템·보이스는 IR 생성(첫 facts 봉인) 전까지 고치고 지울 수 있게 한다. 녹음·스템을 등록하면 권리 주장을 함께 만든다.

**Architecture:** 새 표 `slot_part`와 `stem.part_no`·`snapshot_stem_assignment.part_no`를 더한다. 기존 슬롯은 마이그레이션이 "파트 1"로 옮기므로 지금 데이터와 Dynamite 시나리오는 그대로 돈다(금액·digest 불변). 수정 금지 트리거는 "범위가 한 번도 봉인되지 않았으면 허용"으로 바꾼다. MDRL facts의 스템에는 선택 항목 `part`만 더하고, 파트가 하나뿐인 슬롯은 적지 않는다.

**Tech Stack:** Node 24 TypeScript, Fastify 5, PostgreSQL(RLS), `node:test`, MDRL 패키지(`packages/mdrl`)

**설계 문서:** [슬롯(원곡 흐름)과 파트 구조](../../../../00_프로젝트_개요/보컬_슬롯과_라인_구조_20261022.md)(결정 SL1~SL8), [E10~E11 IR 연계와 CRUD](../../../../00_프로젝트_개요/E10_E11_IR_연계와_CRUD_20261022.md)(결정 ID1~ID3)

**선행:** 1부 계획 [2026-10-22-rbac-core.md](2026-10-22-rbac-core.md)가 master에 합쳐져 있어야 한다(권한 검사 `requirePermission(actor, "rights.edit")`을 쓴다). 합쳐지기 전이면 이 계획의 `requirePermission(actor, "rights.edit")`을 `requireRole(actor, "RIGHTS_EDITOR")`로 읽는다.

**이 계획 밖(2부-B):** Dynamite 시드를 슬롯 12·파트로 다시 만들기(SL-S4, 파트 경계 데이터 필요), 작품 목록·곡 워크스페이스 화면, 총괄 콘솔.

## Global Constraints

- 작업 폴더: `06_MVP/dobedupop/services/rights-core`(MDRL 작업은 `06_MVP/dobedupop/packages/mdrl`)
- 시험: `node --test test/<경로>.test.ts`, 전체 `npm test`, 타입 `npm run typecheck`. MDRL은 그 폴더에서 `npm test`
- 마이그레이션은 새 순번 파일만 만든다. 1부가 0039~0041을 쓰므로 이 계획은 **0042·0043**이다(번호가 이미 있으면 다음 번호)
- **불변 조건:** 마이그레이션 뒤에도 기존 시험이 모두 통과하고, `npm run scenario:dynamite` 보고서가 바이트 단위로 같아야 한다(기존 슬롯은 파트 1, 파트가 하나뿐인 슬롯은 facts에 `part`를 적지 않는다)
- "IR 생성 전" = 그 곡의 `facts_scope.sealed_through IS NULL`. 한 번이라도 봉인되면 그 곡의 카탈로그 행은 잠긴다(409 `CATALOG_SEALED`)
- 파트 종류: `VOCAL`(멤버 한 명, 교체 가능, 사용 시간에 넣음), `GROUP`(전원 제창·애드리브, 교체 불가, 사용 시간 제외 — SL7), `INSTRUMENT`(반주, 권리 부담 없음, 사용 시간 제외 — SL6)
- 파트 시각(`start_ms`·`end_ms`)은 녹음 기준 절대 시각이고 슬롯 안에 있어야 한다. 겹칠 수 있다(화음)
- 새 표는 `test/platform/data-keys.test.ts`의 `KEYS`에 분류를 넣는다(`slot_part`는 소유 열쇠 `OWNER`, 부모 `part_slot`)
- 주석은 한국어, 오류 메시지는 영어. 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

---

### Task 1: 슬롯·파트 스키마와 기존 데이터 이전(SL-S1)

**Files:**
- Create: `migrations/0042_slot_parts.sql`
- Create: `test/registry/slot-parts.test.ts`
- Modify: `test/platform/data-keys.test.ts`

**Interfaces:**
- Produces(DB): `part_slot.section_label TEXT NULL`; `slot_part(slot_id, part_no, kind, role, start_ms, end_ms, original_party_id, owner_tenant_id)`; `stem.part_no INT NULL`; `snapshot_stem_assignment.part_no INT NOT NULL`(PK snapshot_id·slot_id·part_no)

- [ ] **Step 1: 실패하는 시험**

`test/registry/slot-parts.test.ts`:

```ts
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
```

- [ ] **Step 2: 실패 확인** — Run: `node --test test/registry/slot-parts.test.ts` / Expected: FAIL(`slot_part` 없음)

- [ ] **Step 3: 마이그레이션**

`migrations/0042_slot_parts.sql`:

```sql
-- 슬롯(원곡 흐름 구간)과 파트(그 구간의 원곡 트랙). 결정 SL1·SL6·SL7, 진행 SL-S1.
-- 2차 이용(조합)은 슬롯·파트마다 스템을 고르는 배치다. 기존 슬롯은 파트 1로 옮기므로 기존 데이터·금액은 그대로다.
ALTER TABLE part_slot ADD COLUMN section_label TEXT NULL;

CREATE TABLE slot_part (
  slot_id           mdrl_id NOT NULL REFERENCES part_slot,
  part_no           INT NOT NULL CHECK (part_no >= 1),
  kind              TEXT NOT NULL CHECK (kind IN ('VOCAL','GROUP','INSTRUMENT')),
  role              TEXT NULL CHECK (role IN ('LEAD','HARMONY','ADLIB','UNISON','RAP')),
  start_ms          INT NOT NULL,
  end_ms            INT NOT NULL,
  duration_ms       INT GENERATED ALWAYS AS (end_ms - start_ms) STORED,
  original_party_id mdrl_id NULL REFERENCES party,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot_id, part_no),
  CHECK (end_ms > start_ms),
  CHECK ((kind = 'VOCAL') = (original_party_id IS NOT NULL))
);
-- 파트 시각은 슬롯 안이어야 한다.
CREATE FUNCTION rc_slot_part_within() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s part_slot;
BEGIN
  SELECT * INTO s FROM part_slot WHERE slot_id = NEW.slot_id;
  IF NEW.start_ms < s.start_ms OR NEW.end_ms > s.end_ms THEN
    RAISE EXCEPTION 'PART_OUTSIDE_SLOT: part %/% (% ~ %) is outside slot (% ~ %)', NEW.slot_id, NEW.part_no, NEW.start_ms, NEW.end_ms, s.start_ms, s.end_ms;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER slot_part_within BEFORE INSERT OR UPDATE ON slot_part FOR EACH ROW EXECUTE FUNCTION rc_slot_part_within();

-- 소유 열쇠(0017과 같은 방식): 부모 슬롯이 보이면 보인다.
ALTER TABLE slot_part ADD COLUMN owner_tenant_id mdrl_id NOT NULL DEFAULT COALESCE(rc_tenant(), 'tnt_platform') REFERENCES tenant;
CREATE INDEX slot_part_owner ON slot_part (owner_tenant_id);
ALTER TABLE slot_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_rw ON slot_part USING (rc_owns(owner_tenant_id))
  WITH CHECK (rc_owns(owner_tenant_id) AND EXISTS (SELECT 1 FROM part_slot p WHERE p.slot_id = slot_part.slot_id));
GRANT SELECT, INSERT ON slot_part TO rc_app;

-- 기존 슬롯 → 파트 1. 권리 부담 스템의 실연자가 한 명이면 그 사람이 원곡 담당(VOCAL), 아니면 반주(INSTRUMENT).
INSERT INTO slot_part (slot_id, part_no, kind, role, start_ms, end_ms, original_party_id, created_at, owner_tenant_id)
SELECT s.slot_id, 1,
       CASE WHEN o.party_id IS NULL THEN 'INSTRUMENT' ELSE 'VOCAL' END,
       CASE WHEN o.party_id IS NULL THEN NULL ELSE 'LEAD' END,
       s.start_ms, s.end_ms, o.party_id, now(), s.owner_tenant_id
  FROM part_slot s
  LEFT JOIN LATERAL (
    SELECT st.performer_party_id AS party_id FROM stem st
     WHERE st.slot_id = s.slot_id AND st.rights_bearing AND st.performer_party_id IS NOT NULL
       AND st.stem_id LIKE '%' || replace(s.slot_id, 'slt_part_', '') || '%'
     ORDER BY st.stem_id LIMIT 1) o ON true;

-- 스템·발행 배정 → 파트 1. 두 표는 수정 금지 트리거가 있어 이전하는 동안만 끈다.
ALTER TABLE stem ADD COLUMN part_no INT NULL DEFAULT 1;
ALTER TABLE stem DISABLE TRIGGER stem_immutable;
UPDATE stem SET part_no = 1;
ALTER TABLE stem ENABLE TRIGGER stem_immutable;
ALTER TABLE stem ADD CONSTRAINT stem_part_fkey FOREIGN KEY (slot_id, part_no) REFERENCES slot_part (slot_id, part_no);
ALTER TABLE stem ALTER COLUMN part_no SET NOT NULL;

ALTER TABLE snapshot_stem_assignment ADD COLUMN part_no INT NULL DEFAULT 1;
ALTER TABLE snapshot_stem_assignment DISABLE TRIGGER snapshot_stem_assignment_immutable;
UPDATE snapshot_stem_assignment SET part_no = 1;
ALTER TABLE snapshot_stem_assignment ENABLE TRIGGER snapshot_stem_assignment_immutable;
ALTER TABLE snapshot_stem_assignment ALTER COLUMN part_no SET NOT NULL;
ALTER TABLE snapshot_stem_assignment DROP CONSTRAINT snapshot_stem_assignment_pkey;
ALTER TABLE snapshot_stem_assignment ADD PRIMARY KEY (snapshot_id, slot_id, part_no);
```

`DEFAULT 1`은 Task 3·4가 INSERT 코드에 `part_no`를 넣기 전까지 기존 코드를 살려 두려는 것이고, Task 5의 마이그레이션이 지운다.

원곡 담당을 찾는 `LIKE` 조건은 지금 데이터의 이름 규칙(`slt_part_<멤버>` ↔ `stm_<멤버>_<멤버>`)에 맞춘 것이다. 시험 데이터에 이 규칙이 아닌 슬롯이 있어 VOCAL인데 원곡 담당이 비면 CHECK가 실패한다. 그때는 `ORDER BY st.stem_id LIMIT 1`만 남기고 `LIKE` 줄을 지운다(첫 실연자가 원곡 담당).

`test/platform/data-keys.test.ts`의 `KEYS`에 `slot_part: "OWNER",`를 더한다.

- [ ] **Step 4: 통과·회귀** — Run: `node --test test/registry/slot-parts.test.ts test/platform/data-keys.test.ts && npm test` / Expected: 실패 0(기존 INSERT는 `part_no` 기본값 1로 통과한다)

- [ ] **Step 5: Dynamite 보고서 불변 확인** — Run: `npm run scenario:dynamite > /private/tmp/dyn-0042.json` 후 1부 완료 시점 보고서와 `diff` / Expected: 차이 없음

- [ ] **Step 6: Commit** — `feat(core): 슬롯·파트 스키마 — slot_part(VOCAL·GROUP·INSTRUMENT), stem·발행 배정의 part_no, 기존 슬롯은 파트 1(SL-S1)`

---

### Task 2: MDRL facts 스템의 `part`(SL-S2)

**Files:**
- Modify: `packages/mdrl/src/facts/types.ts:25`, `packages/mdrl/src/facts/validate.ts:25,167`, `packages/mdrl/src/text/format-facts.ts:42`, `packages/mdrl/src/text/parse-facts.ts`(스템 항목 파싱)
- Test: MDRL 패키지의 facts 시험 폴더(`grep -rln "rights_bearing" packages/mdrl/test | head -3`로 찾은 facts 시험 파일)

**Interfaces:**
- Produces: `type Stem = { id: string; of: string; slot: string; part?: string; rights_bearing: boolean }`. 텍스트 형식 `stem <id> { of: <rec>; slot: <slot>; part: <n>; rights_bearing: <bool>; }`(part는 있을 때만)

- [ ] **Step 1: 실패하는 시험** — facts 시험 파일에:

```ts
test("stem part is optional: absent keeps the digest, present round-trips", () => {
  const base = /* 그 파일의 기존 최소 facts 픽스처를 복사 */;
  const withPart = { ...base, assets: { ...base.assets, stems: base.assets.stems.map((s, i) => (i === 0 ? { ...s, part: "2" } : s)) } };
  assert.deepEqual(validateFacts(base), []);
  assert.deepEqual(validateFacts(withPart), []);
  const text = formatFacts(withPart);
  assert.match(text, /part: 2;/);
  assert.deepEqual(parseFacts(text).value, withPart);
  assert.doesNotMatch(formatFacts(base), /part:/);
});
```

픽스처의 실제 구조(스템이 `assets.stems`에 있는지)와 함수 이름(`validateFacts`·`formatFacts`·`parseFacts`)은 그 시험 파일의 기존 import를 따른다.

- [ ] **Step 2: 실패 확인** — Run(MDRL 폴더): `npm test` / Expected: 새 시험 FAIL(`part` 알 수 없는 키)

- [ ] **Step 3: 구현**
  - `types.ts`: `export type Stem = { id: string; of: string; slot: string; part?: string; rights_bearing: boolean };`
  - `validate.ts`: 허용 키 목록 `stem: ["id", "of", "slot", "rights_bearing"]` → `stem: ["id", "of", "slot", "part", "rights_bearing"]`, 167줄 `text(x.slot, …)` 아래에 `if (x.part !== undefined) { text(x.part, `${p}.part`); if (!/^[1-9][0-9]*$/.test(x.part)) err(`${p}.part`, "part must be a positive integer string"); }`(그 파일의 오류 함수 이름을 따른다). 필수 키 검사가 허용 키 목록으로 필수 여부를 같이 정한다면, `part`를 선택 키로 따로 둔다
  - `format-facts.ts:42`: `slot: ${idText(s.slot)};` 뒤에 `${s.part === undefined ? "" : ` part: ${s.part};`}`
  - `parse-facts.ts`: 스템 항목 파서가 `part`를 읽어 문자열로 넣는다(없으면 키를 만들지 않는다)

- [ ] **Step 4: 통과** — Run: `npm test`(MDRL) / Expected: 실패 0. 엔진 시험 307개가 그대로 통과해야 한다

- [ ] **Step 5: Commit** — `feat(mdrl): facts 스템의 선택 항목 part — 없으면 digest 불변(SL-S2, 결정 SL4)`

---

### Task 3: 슬롯·파트 등록과 조회, facts 변환(SL-S3 앞부분)

**Files:**
- Modify: `src/registry/service.ts`(`registerSlot`, `registerStem`, 새 `registerSlotPart`), `src/registry/routes.ts`(`/slot-parts` 등록 경로), `src/registry/queries.ts`(범위 facts 조회에 파트), `src/engine-bridge/facts.ts`(`loadFactsRows`의 스템에 part 정보), `src/engine-bridge/convert-facts.ts`(`StemRow.partNo`, 파트가 둘 이상인 슬롯만 `part`)
- Test: `test/registry/slot-parts.test.ts`

**Interfaces:**
- Consumes: Task 1 표, Task 2 `Stem.part`
- Produces:
  - `registerSlot(tx, clock, s: { slotId; recordingId; startMs; endMs; sortOrder; sectionLabel?: string; parts?: SlotPartInput[] })` — `parts`가 없으면 슬롯 전체 길이의 `INSTRUMENT` 파트 1을 만든다
  - `type SlotPartInput = { partNo: number; kind: "VOCAL" | "GROUP" | "INSTRUMENT"; role?: "LEAD" | "HARMONY" | "ADLIB" | "UNISON" | "RAP"; startMs: number; endMs: number; originalPartyId?: string }`
  - `registerSlotPart(tx, clock, slotId: string, p: SlotPartInput)`
  - `registerStem(tx, clock, s: { …기존; partNo?: number })` — 기본 1
  - `POST /slot-parts` 본문 `{ slotId, partNo, kind, role?, startMs, endMs, originalPartyId? }`
  - `StemRow = { stemId; recordingId; slotId; partNo: number; rightsBearing; createdAt }`, facts 스템은 그 슬롯의 파트 수가 2 이상일 때만 `part: String(partNo)`

- [ ] **Step 1: 실패하는 시험** — `test/registry/slot-parts.test.ts`에 더한다. 시험 준비는 기존 레지스트리 시험(`grep -rln "registerStem" test | head -1`)의 픽스처 함수를 그대로 쓴다(곡·범위·녹음·당사자 생성):

```ts
test("a slot with two vocal parts: stems per part, facts carry part only when a slot has several", async () => {
  // 준비: 기존 픽스처로 곡 w, 범위 sc, 녹음 r, 멤버 당사자 pa·pb
  await db.tx(async (tx) => {
    await registerSlot(tx, clock, { slotId: "s_ch", recordingId: "r", startMs: 0, endMs: 18000, sortOrder: 1, sectionLabel: "Chorus 1",
      parts: [{ partNo: 1, kind: "VOCAL", role: "LEAD", startMs: 0, endMs: 9000, originalPartyId: "pa" }, { partNo: 2, kind: "VOCAL", role: "LEAD", startMs: 9000, endMs: 18000, originalPartyId: "pb" }, { partNo: 3, kind: "INSTRUMENT", startMs: 0, endMs: 18000 }] });
    await registerSlot(tx, clock, { slotId: "s_in", recordingId: "r", startMs: 18000, endMs: 22000, sortOrder: 2, sectionLabel: "Intro" });
    await registerStem(tx, clock, { stemId: "st_ch_1_a", slotId: "s_ch", partNo: 1, recordingId: "r", performerPartyId: "pa", rightsBearing: true });
    await registerStem(tx, clock, { stemId: "st_ch_2_b", slotId: "s_ch", partNo: 2, recordingId: "r", performerPartyId: "pb", rightsBearing: true });
    await registerStem(tx, clock, { stemId: "st_in", slotId: "s_in", recordingId: "r", rightsBearing: false });
  });
  const rows = await db.tx((tx) => loadFactsRows(tx, "sc", clock.now()));
  const doc = buildFactsDocument(rows, clock.now());
  const byId = Object.fromEntries(doc.assets.stems.map((s: any) => [s.id, s]));
  assert.equal(byId.st_ch_1_a.part, "1");
  assert.equal(byId.st_ch_2_b.part, "2");
  assert.equal(byId.st_in.part, undefined, "a slot with one part does not write part (digest unchanged)");
  await assert.rejects(db.tx((tx) => registerSlotPart(tx, clock, "s_in", { partNo: 2, kind: "VOCAL", startMs: 0, endMs: 30000, originalPartyId: "pa" })), /PART_OUTSIDE_SLOT/);
});
```

`doc.assets.stems`의 실제 경로는 `buildFactsDocument` 반환 구조에 맞춘다.

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현**

`src/registry/service.ts`:

```ts
export type SlotPartInput = { partNo: number; kind: "VOCAL" | "GROUP" | "INSTRUMENT"; role?: "LEAD" | "HARMONY" | "ADLIB" | "UNISON" | "RAP"; startMs: number; endMs: number; originalPartyId?: string };

/** 슬롯 = 원곡 흐름 구간(SL1). 파트를 주지 않으면 슬롯 전체 길이의 반주 파트 1을 만든다. */
export async function registerSlot(tx: Tx, clock: Clock, s: { slotId: string; recordingId: string; startMs: number; endMs: number; sortOrder: number; sectionLabel?: string; parts?: SlotPartInput[] }): Promise<void> {
  await fenceRecording(tx, s.recordingId, clock.now());
  await tx.query("INSERT INTO part_slot (slot_id, recording_id, start_ms, end_ms, sort_order, section_label) VALUES ($1,$2,$3,$4,$5,$6)",
    [s.slotId, s.recordingId, s.startMs, s.endMs, s.sortOrder, s.sectionLabel ?? null]);
  for (const p of s.parts ?? [{ partNo: 1, kind: "INSTRUMENT" as const, startMs: s.startMs, endMs: s.endMs }]) await registerSlotPart(tx, clock, s.slotId, p);
}

/** 파트 = 슬롯 안 원곡 트랙(SL1·SL6·SL7). 보컬은 원곡 담당 멤버가 있어야 한다. */
export async function registerSlotPart(tx: Tx, clock: Clock, slotId: string, p: SlotPartInput): Promise<void> {
  const r = (await tx.query("SELECT recording_id FROM part_slot WHERE slot_id = $1", [slotId])).rows[0];
  if (r === undefined) throw invalid("INVALID_REFERENCE", `slot ${slotId} does not exist`);
  await fenceRecording(tx, r.recording_id, clock.now());
  await tx.query("INSERT INTO slot_part (slot_id, part_no, kind, role, start_ms, end_ms, original_party_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [slotId, p.partNo, p.kind, p.role ?? null, p.startMs, p.endMs, p.originalPartyId ?? null, clock.now()]);
}
```

`registerSlot`의 시그니처가 `(tx, s)`에서 `(tx, clock, s)`로 바뀐다. 부르는 곳(`grep -rn "registerSlot(" src test`)을 모두 고친다. `registerStem`은 INSERT에 `part_no`(`s.partNo ?? 1`)를 넣는다. `routes.ts`의 `/slots`는 `reg.registerSlot(tx, deps.clock, b)`로, 그리고 `created<any>("/slot-parts", (tx, b) => reg.registerSlotPart(tx, deps.clock, b.slotId, b), ["slotId", "partNo", "kind", "startMs", "endMs"])`를 더한다. 오류 `PART_OUTSIDE_SLOT`은 DB 예외라서, `src/http/server.ts`의 DB 오류 변환(`grep -n "RC001\|23514\|P0001" src/http/server.ts`)에 `PART_OUTSIDE_SLOT:`으로 시작하는 메시지를 422 `PART_OUTSIDE_SLOT`으로 바꾸는 한 줄을 더한다.

`src/engine-bridge/facts.ts`의 스템 조회를 파트 수와 함께 읽게 바꾼다:

```ts
  const stems = (await tx.query(
    `SELECT st.stem_id, st.recording_id, st.slot_id, st.part_no, st.rights_bearing, st.created_at,
            (SELECT count(*)::int FROM slot_part p WHERE p.slot_id = st.slot_id) AS part_count
       FROM stem st WHERE st.recording_id = ANY($1) AND st.created_at <= $2`,
    [recordings.map((r) => r.recording_id), knownAt],
  )).rows;
```

그리고 매핑에 `partNo: s.part_count > 1 ? s.part_no : undefined`를 넣는다. `convert-facts.ts`: `StemRow`에 `partNo?: number`, 스템 출력에 `...(s.partNo === undefined ? {} : { part: String(s.partNo) })`.

`src/registry/queries.ts`의 범위 facts 조회(`getScopeFacts`)에서 슬롯마다 `sectionLabel`과 `parts`(`slot_part` 행, 시작·끝·종류·역할·원곡 담당)를 함께 돌려준다. 스템에는 `partNo`를 붙인다.

- [ ] **Step 4: 통과·회귀** — Run: `node --test test/registry/slot-parts.test.ts && npm run typecheck && npm test` / Expected: 실패 0

- [ ] **Step 5: Commit** — `feat(core): 슬롯 구간 이름·파트 등록과 조회, 스템 파트, facts 스템 part(파트 둘 이상인 슬롯만)`

---

### Task 4: 발행·판정·하위 화면 조회를 파트 단위로(SL-S3 뒷부분)

**Files:**
- Modify: `src/issuance/service.ts`(`IssueInput`, `issue`, `slotShareBps` 호출부), `src/fan/decision.ts`, `src/http/channel-routes.ts`(팬 조합 본문, 실연자 "사용"), `src/policy/form.ts`, `src/audio/render.ts`, `src/monitor/trace.ts`, `src/performer/contributions.ts`, `src/exposure/service.ts`(조인 확인), `src/scenario/*.ts`(배정에 partNo가 없으면 그대로 — 기본 1)
- Test: `test/issuance/parts.test.ts`(새), 기존 발행·판정 시험

**Interfaces:**
- Produces:
  - `IssueInput.assignments: { slotId: string; partNo?: number; stemId: string }[]` — `partNo` 없으면 1
  - 오류: 422 `INVALID_ISSUE`(같은 슬롯·파트 중복, 다른 파트의 스템), 422 `PART_MISSING`(배정되지 않은 VOCAL 파트가 있음), 422 `GROUP_PART_FIXED`(그룹 파트에 원곡 그룹 스템이 아닌 스템)
  - 사용 시간: `usageMs[stemId] += part.duration_ms` — VOCAL 파트만. GROUP·INSTRUMENT는 넣지 않는다
  - `snapshot_stem_assignment`에 `part_no`, `start_ms`·`end_ms`·`duration_ms`는 **파트**의 값

- [ ] **Step 1: 실패하는 시험** — `test/issuance/parts.test.ts`: Task 3 시험과 같은 곡 준비(Chorus 슬롯 파트 1·2·3 + Intro) 뒤 팩·정책을 활성화(기존 발행 시험의 픽스처 함수를 쓴다 — `grep -rln "issue(" test/issuance | head -1`). 그리고:

```ts
test("issue by part: both vocal parts must be assigned, usage = part length, group/instrument excluded", async () => {
  // 지민(pb) 파트 2를 pa가 부른 스템으로 바꾼 조합
  await assert.rejects(issueAs(fan, { vcId: "vc_miss", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 3, stemId: "st_ch_inst" }, { slotId: "s_in", stemId: "st_in" }], members: { pa: 10000 } }), /PART_MISSING/);
  const seal = await issueAs(fan, { vcId: "vc_swap", assignments: [{ slotId: "s_ch", partNo: 1, stemId: "st_ch_1_a" }, { slotId: "s_ch", partNo: 2, stemId: "st_ch_2_a" }, { slotId: "s_ch", partNo: 3, stemId: "st_ch_inst" }, { slotId: "s_in", stemId: "st_in" }], members: { pa: 10000 } });
  const a = (await db.pool.query("SELECT slot_id, part_no, stem_id, duration_ms FROM snapshot_stem_assignment WHERE snapshot_id = $1 ORDER BY slot_id, part_no", [seal.snapshotId])).rows;
  assert.deepEqual(a.map((r) => [r.slot_id, r.part_no, r.duration_ms]), [["s_ch", 1, 9000], ["s_ch", 2, 9000], ["s_ch", 3, 18000], ["s_in", 1, 4000]]);
});
```

`issueAs`는 그 시험 파일의 발행 도우미를 쓴다. 스템 `st_ch_2_a`(파트 2를 pa가 부른 추가 녹음)와 `st_ch_inst`(파트 3 반주)는 준비 단계에서 더 등록한다.

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** — `src/issuance/service.ts`의 `issue`:

```ts
  const picks = input.assignments.map((a) => ({ slotId: a.slotId, partNo: a.partNo ?? 1, stemId: a.stemId }));
  if (new Set(picks.map((a) => `${a.slotId}#${a.partNo}`)).size !== picks.length) throw bad("duplicate slot part in assignments");
  const stems = (await tx.query(
    `SELECT st.stem_id, st.slot_id, st.part_no, st.performer_party_id, st.rights_bearing, p.kind, p.start_ms, p.end_ms, p.duration_ms, s.facts_scope_id
       FROM stem st JOIN slot_part p ON p.slot_id = st.slot_id AND p.part_no = st.part_no
       JOIN recording_version r ON r.recording_id = st.recording_id JOIN facts_scope s ON s.work_id = r.work_id
      WHERE st.stem_id = ANY($1)`, [picks.map((a) => a.stemId)])).rows;
  const byStem = new Map(stems.map((s) => [s.stem_id as string, s]));
  for (const a of picks) {
    const s = byStem.get(a.stemId);
    if (s === undefined || s.slot_id !== a.slotId || s.part_no !== a.partNo || s.facts_scope_id !== pack.factsScopeId) throw bad(`stem ${a.stemId} is not in slot ${a.slotId} part ${a.partNo} of this song`);
  }
  // 모든 보컬 파트를 채워야 한다(SL1). 그룹 파트는 원곡 그룹 스템으로만(SL7).
  const vocal = (await tx.query(
    `SELECT p.slot_id, p.part_no FROM slot_part p JOIN part_slot sl ON sl.slot_id = p.slot_id JOIN recording_version r ON r.recording_id = sl.recording_id
       JOIN facts_scope s ON s.work_id = r.work_id WHERE s.facts_scope_id = $1 AND p.kind = 'VOCAL' AND p.slot_id = ANY($2)`,
    [pack.factsScopeId, [...new Set(picks.map((a) => a.slotId))]])).rows;
  const missing = vocal.filter((v) => !picks.some((a) => a.slotId === v.slot_id && a.partNo === v.part_no));
  if (missing.length > 0) throw invalid("PART_MISSING", `vocal parts are not assigned: ${missing.map((m) => `${m.slot_id}#${m.part_no}`).join(", ")}`);
  for (const a of picks) {
    const s = byStem.get(a.stemId)!;
    if (s.kind === "GROUP" && !(await isOriginalGroupStem(tx, a.stemId))) throw invalid("GROUP_PART_FIXED", `slot ${a.slotId} part ${a.partNo} is a group part; only its original stem can be used`);
  }
```

`isOriginalGroupStem(tx, stemId)`는 같은 파일에 둔다: 그 파트에 스템이 하나뿐이면 원곡 그룹 스템으로 본다(`SELECT count(*) FROM stem WHERE slot_id = … AND part_no = …` = 1). 스냅샷 INSERT는 `part_no`와 파트의 `start_ms`·`end_ms`·`duration_ms`를 넣고, 사용 시간은 `if (s.rights_bearing && s.kind === "VOCAL") usageMs[a.stemId] = (usageMs[a.stemId] ?? 0) + s.duration_ms`. 이후 코드에서 `input.assignments`를 쓰는 곳은 모두 `picks`로 바꾼다.

**PART_MISSING 범위:** 위 검사는 배정에 나온 슬롯의 보컬 파트만 본다. 지금 시나리오는 모든 슬롯을 배정하므로 충분하다. 곡의 모든 슬롯을 다 채워야 하는지는 기존 동작(빠진 슬롯을 허용하는지)을 따른다 — 기존 시험이 슬롯 일부만 배정하면 이 범위를 유지한다.

`src/fan/decision.ts`: `CheckInput.assignments`에 `partNo?: number`, 캐시 키 정렬을 `(slotId, partNo, stemId)` 순으로, `partNo`를 키에 넣을 때 기본 1로 채운다(같은 배치는 같은 키 — 기존 키와 같아지도록 `partNo`가 1이면 키에서 생략한다). `src/http/channel-routes.ts`의 팬 조합 본문 검증이 `assignments` 항목 키를 검사하면 `partNo`(양의 정수, 선택)를 허용한다. 실연자 "사용" 조회(52줄)는 `part_no`를 함께 돌려준다.

`src/policy/form.ts`(27·38~45줄): 후보 조회를 `slot_part`와 조인해 보컬 파트별로 묶는다(`slot_id`, `part_no`, 파트 `duration_ms`). `src/audio/render.ts`: 배정·미리듣기 조회에 `part_no`를 넣고, 정렬은 `start_ms, slot_id, part_no`, 렌더 해시 입력에 `part_no`를 더한다(기존 파트 1만 있는 데이터는 해시가 바뀐다 — 렌더 해시는 봉인 digest가 아니라서 허용. 시험이 기대 해시를 고정했다면 그 기대값을 새로 계산해 바꾼다). `src/monitor/trace.ts`·`src/performer/contributions.ts`·`src/exposure/service.ts`: `snapshot_stem_assignment`를 `slot_id`만으로 조인하는 곳에 `part_no`를 더한다(`grep -n "slot_id" <파일>`).

마지막으로 Task 1에서 둔 `stem.part_no`·`snapshot_stem_assignment.part_no` 기본값을 지우는 마이그레이션 줄을 `migrations/0043_catalog_edit.sql` 맨 위에 둔다(Task 5): `ALTER TABLE stem ALTER COLUMN part_no DROP DEFAULT; ALTER TABLE snapshot_stem_assignment ALTER COLUMN part_no DROP DEFAULT;`

- [ ] **Step 4: 통과·회귀** — Run: `node --test test/issuance/parts.test.ts && npm run typecheck && npm test && npm run scenario:dynamite > /private/tmp/dyn-t4.json` + Task 1 보고서와 `diff` / Expected: 실패 0, 보고서 차이 없음

- [ ] **Step 5: Commit** — `feat(core): 발행·판정을 슬롯·파트 단위로 — 보컬 파트 누락 PART_MISSING, 그룹 파트 고정, 사용 시간 = 파트 길이(SL2·SL7)`

---

### Task 5: IR 생성 전 카탈로그 수정·삭제(ID1)

**Files:**
- Create: `migrations/0043_catalog_edit.sql`
- Modify: `src/registry/service.ts`(수정·삭제 함수), `src/registry/routes.ts`(PUT·DELETE 경로), `src/http/server.ts`(DB 예외 `CATALOG_SEALED` 변환)
- Test: `test/registry/catalog-edit.test.ts`(새)

**Interfaces:**
- Produces:
  - `PUT /works/:id`(title·iswc), `PUT /recordings/:id`(versionTitle·isrc·masterOwnerPartyId), `PUT /slots/:id`(startMs·endMs·sortOrder·sectionLabel), `PUT /slot-parts/:slotId/:partNo`(kind·role·startMs·endMs·originalPartyId), `PUT /stems/:id`(performerPartyId·rightsBearing), `DELETE /works/:id`·`/recordings/:id`·`/slots/:id`·`/slot-parts/:slotId/:partNo`·`/stems/:id`·`/voices/:id`
  - 범위가 봉인된 적이 있으면 409 `CATALOG_SEALED`. 지우려는 행을 다른 행이 가리키면 409 `CATALOG_IN_USE`(예: 스템이 있는 파트 삭제). 스템·보이스를 지우면 그 스템·보이스를 출처·대상으로 하는 권리 주장과 그 확인 요청을 함께 지운다(봉인 전이라 어떤 IR에도 없다)
  - 권한: `rights.edit`, RLS가 소유를 거른다

- [ ] **Step 1: 실패하는 시험** — `test/registry/catalog-edit.test.ts`: 기존 픽스처로 곡·범위·녹음·슬롯·파트·스템·보이스·실연 주장을 만든 뒤:

```ts
test("before the first facts seal, catalog rows can be edited and deleted; after it they are locked", async () => {
  await http("PUT", "/portal/slots/s_ch", { startMs: 0, endMs: 20000, sortOrder: 1, sectionLabel: "Chorus 1" }, editor);           // 200
  await http("PUT", "/portal/slot-parts/s_ch/2", { kind: "VOCAL", role: "LEAD", startMs: 10000, endMs: 20000, originalPartyId: "pb" }, editor);
  await http("DELETE", "/portal/stems/st_ch_2_a", undefined, editor);                                                                 // 204, 그 실연 주장도 사라짐
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM right_claim WHERE source_id = 'st_ch_2_a'")).rows[0].n, 0);
  await sealScope("sc");                                                                                                              // facts 봉인(컴파일)
  const r = await http("PUT", "/portal/slots/s_ch", { startMs: 0, endMs: 21000, sortOrder: 1 }, editor, { expect: 409 });
  assert.equal(r.code, "CATALOG_SEALED");
});
```

`http`·`sealScope`는 기존 HTTP 시험 도우미(`grep -rln "inject(" test/http | head -1`)와 정책 컴파일 픽스처를 쓴다.

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 마이그레이션** — `migrations/0043_catalog_edit.sql`:

```sql
-- IR 생성(첫 facts 봉인) 전 카탈로그 수정·삭제(결정 ID1). 봉인된 적이 있는 곡의 행은 지금처럼 바꿀 수 없다.
ALTER TABLE stem ALTER COLUMN part_no DROP DEFAULT;
ALTER TABLE snapshot_stem_assignment ALTER COLUMN part_no DROP DEFAULT;

-- 행 → 곡의 범위가 봉인된 적이 있는가.
CREATE FUNCTION rc_scope_sealed_for(tbl TEXT, r jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE w TEXT;
BEGIN
  w := CASE tbl
    WHEN 'work' THEN r->>'work_id'
    WHEN 'recording_version' THEN r->>'work_id'
    WHEN 'part_slot' THEN (SELECT work_id FROM recording_version WHERE recording_id = r->>'recording_id')
    WHEN 'slot_part' THEN (SELECT rv.work_id FROM part_slot s JOIN recording_version rv ON rv.recording_id = s.recording_id WHERE s.slot_id = r->>'slot_id')
    WHEN 'stem' THEN (SELECT work_id FROM recording_version WHERE recording_id = r->>'recording_id')
    WHEN 'voice' THEN (SELECT work_id FROM facts_scope WHERE facts_scope_id = r->>'facts_scope_id')
  END;
  RETURN EXISTS (SELECT 1 FROM facts_scope WHERE work_id = w AND sealed_through IS NOT NULL);
END $$;

CREATE FUNCTION rc_mutable_before_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF rc_scope_sealed_for(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'CATALOG_SEALED: % % rejected — the song''s facts are sealed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'RC001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER work_immutable ON work;
DROP TRIGGER recording_immutable ON recording_version;
DROP TRIGGER part_slot_immutable ON part_slot;
DROP TRIGGER stem_immutable ON stem;
DROP TRIGGER voice_immutable ON voice;
CREATE TRIGGER work_mutable_before_seal BEFORE UPDATE OR DELETE ON work FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER recording_mutable_before_seal BEFORE UPDATE OR DELETE ON recording_version FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER part_slot_mutable_before_seal BEFORE UPDATE OR DELETE ON part_slot FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER slot_part_mutable_before_seal BEFORE UPDATE OR DELETE ON slot_part FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER stem_mutable_before_seal BEFORE UPDATE OR DELETE ON stem FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();
CREATE TRIGGER voice_mutable_before_seal BEFORE UPDATE OR DELETE ON voice FOR EACH ROW EXECUTE FUNCTION rc_mutable_before_seal();

-- 권리 주장·위임: 봉인 전에는 지울 수 있다(스템·보이스 삭제에 딸려). 봉인 뒤에는 지금처럼 대체만.
CREATE FUNCTION rc_supersede_or_delete_before_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM facts_scope WHERE facts_scope_id = OLD.facts_scope_id AND sealed_through IS NOT NULL) THEN
      RAISE EXCEPTION 'CATALOG_SEALED: % DELETE rejected — the song''s facts are sealed', TG_TABLE_NAME USING ERRCODE = 'RC001';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE는 지금과 같다(0001_base.sql rc_allow_supersede_only): superseded_at을 NULL에서 값으로 한 번만.
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
     OR (to_jsonb(NEW) - 'superseded_at') <> (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'append-only table %: only a single superseded_at set is allowed', TG_TABLE_NAME USING ERRCODE = 'RC001';
  END IF;
  RETURN NEW;
END $$;
```

그리고:

```sql
DROP TRIGGER right_claim_append_only ON right_claim;
DROP TRIGGER mandate_append_only ON mandate;
CREATE TRIGGER right_claim_append_only BEFORE UPDATE OR DELETE ON right_claim FOR EACH ROW EXECUTE FUNCTION rc_supersede_or_delete_before_seal();
CREATE TRIGGER mandate_append_only BEFORE UPDATE OR DELETE ON mandate FOR EACH ROW EXECUTE FUNCTION rc_supersede_or_delete_before_seal();

GRANT UPDATE, DELETE ON work, recording_version, part_slot, slot_part, stem, voice TO rc_app;
GRANT DELETE ON right_claim, mandate TO rc_app;
```

확인 요청 표 `confirmation_request`(0029)에 DELETE 권한이 없으면 `GRANT DELETE ON confirmation_request TO rc_app;`도 더한다. 봉인 원문을 가리키는 표(`record_evidence` 등)가 스템·주장을 외래키로 가리키면 삭제 함수가 먼저 그 행을 지운다.

- [ ] **Step 4: 서비스와 경로** — `src/registry/service.ts`에 `updateWork`, `updateRecording`, `updateSlot`, `updateSlotPart`, `updateStem`, `deleteCatalogRow(tx, kind, id)`를 둔다. 각 함수는 대상이 없으면 404, DB 예외 메시지가 `CATALOG_SEALED:`로 시작하면 409 `CATALOG_SEALED`, 외래키 위반(23503)이면 409 `CATALOG_IN_USE`. `deleteStem`은 지우기 전에 `DELETE FROM right_claim WHERE source_id = $1 OR target_id = $1`과 그 주장의 확인 요청을 지운다. `deleteVoice`는 같은 방식으로 `OWNED_BY`(source = voice)·`PERFORMED_BY`(target = voice) 주장을 지운다. 지우거나 고친 뒤에는 `revalidate(tx, clock, scopeId)`를 부른다(routes.ts의 기존 패턴). 경로는 `routes.ts`에 `app.put`·`app.delete`로 더하고 `requirePermission(actor, "rights.edit")`(1부)로 검사한다. 감사 로그 `CATALOG_UPDATE`·`CATALOG_DELETE`(이전·이후 값)를 남긴다

- [ ] **Step 5: 통과·회귀** — Run: `node --test test/registry/catalog-edit.test.ts && npm run typecheck && npm test` / Expected: 실패 0. 기존 시험 중 "카탈로그 UPDATE가 거부된다"를 확인하던 것이 있으면, 범위를 먼저 봉인한 뒤 거부되는지로 바꾼다

- [ ] **Step 6: Commit** — `feat(core): IR 생성 전 카탈로그 수정·삭제 — 봉인 뒤 CATALOG_SEALED, 스템·보이스 삭제 시 그 권리 주장·확인 요청도 거둠(ID1)`

---

### Task 6: 녹음·스템 등록 때 권리 주장 함께 만들기(ID2·ID3, SL3)

**Files:**
- Modify: `src/registry/routes.ts`(`/recordings`·`/stems`·`/slot-parts` 처리), `src/registry/service.ts`
- Test: `test/registry/auto-claims.test.ts`(새)

**Interfaces:**
- Produces:
  - `POST /recordings` 본문에 선택 `masterClaim: { evidenceDocuments?: DocRef[] }` — 있으면 `CONTROLLED_BY`(녹음 → 마스터 보유 당사자, 10000bps) 주장을 만든다. 당사자가 자기 테넌트면 `VERIFIED`, 아니면 `ASSERTED`(확인 요청)
  - `POST /stems` 본문에 선택 `withClaims: true` — 권리 부담 스템이고 실연자가 있으면: 그 실연자의 보이스(범위 안 `voc_<party에서 pty_ 뺀 것>`)가 없으면 보이스 + `OWNED_BY`(보이스 → 실연자) 주장을 만들고, `PERFORMED_BY`(스템 → 보이스, FEATURED, 10000bps) 주장을 만든다. 상태는 `ASSERTED`(본인 확인 요청)
  - `POST /slot-parts`의 보컬 파트 원곡 담당 지정은 그 원곡 스템의 실연 주장 확인으로 확인된다(SL3) — 따로 확인 요청을 만들지 않고, 정합성 규칙(Task 7)이 둘이 맞는지 본다
  - 주장 id 규칙: `c_master_<recordingId>`, `c_own_<voiceId>`, `c_perf_<stemId>`

- [ ] **Step 1: 실패하는 시험**

```ts
test("registering a stem with withClaims creates voice, ownership and performance claims and asks the member", async () => {
  await http("POST", "/portal/stems", { stemId: "st_new", slotId: "s_ch", partNo: 2, recordingId: "r", performerPartyId: "pb", rightsBearing: true, withClaims: true }, editor);
  const claims = (await db.pool.query("SELECT claim_id, edge, status FROM right_claim WHERE claim_id IN ('c_perf_st_new', 'c_own_voc_b') ORDER BY claim_id")).rows;
  assert.deepEqual(claims.map((c) => [c.claim_id, c.edge, c.status]), [["c_own_voc_b", "OWNED_BY", "ASSERTED"], ["c_perf_st_new", "PERFORMED_BY", "ASSERTED"]]);
  const req = (await db.pool.query("SELECT count(*)::int AS n FROM confirmation_request WHERE record_id = 'c_perf_st_new'")).rows[0].n;
  assert.equal(req, 1);
});

test("registering a recording with masterClaim records the master right (own party → verified)", async () => {
  await http("POST", "/portal/recordings", { recordingId: "r2", workId: "w", masterOwnerPartyId: "pty_label", versionTitle: "v2", masterClaim: {} }, editor);
  const c = (await db.pool.query("SELECT edge, target_id, share_bps, status FROM right_claim WHERE claim_id = 'c_master_r2'")).rows[0];
  assert.deepEqual([c.edge, c.target_id, c.share_bps, c.status], ["CONTROLLED_BY", "pty_label", 10000, "VERIFIED"]);
});
```

보이스 id 규칙(`voc_b` ← `pb`)은 시험 당사자 id에 맞춰 `voiceIdFor(partyId)` 도우미로 정한다: `pty_` 접두어를 떼고 `voc_`를 붙인다(`pty_jimin` → `voc_jimin`). 접두어가 없으면 id 전체를 붙인다(`pb` → `voc_pb`). 시험 기대값을 이 규칙에 맞춘다. 확인 요청 표는 `confirmation_request`다(0029).

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** — `routes.ts`의 `/recordings`·`/stems` 처리기에서 기본 등록 뒤 `recordWithConfirmation`(같은 파일의 기존 함수)을 써서 주장을 기록한다. 그래야 확인 요청·신탁·정합성 재검사가 기존 경로와 같다. `validFrom`은 범위의 문서 효력 시작이 없으면 `clock.now()`. 녹음 주장의 `status`는 `assertMayRecordVerified`가 허용하면 `VERIFIED`, 아니면 `ASSERTED`

- [ ] **Step 4: 통과·회귀** — Run: `node --test test/registry/auto-claims.test.ts && npm test` / Expected: 실패 0(기존 시나리오는 `withClaims`·`masterClaim`을 보내지 않으므로 그대로)

- [ ] **Step 5: Commit** — `feat(core): 녹음 등록의 녹음 권리 주장, 스템 등록의 보이스·소유·실연 주장 함께 만들기(ID2·ID3)`

---

### Task 7: 정합성 규칙 4개

**Files:**
- Modify: `src/validation/service.ts`(`checkScope`)
- Test: `test/validation/slot-part-rules.test.ts`(새)

**Interfaces:**
- Produces(규칙 코드): `MASTER_OWNER_CLAIM_MISMATCH`(WARN — 녹음의 마스터 보유자 ≠ 확정·주장된 CONTROLLED_BY 대상), `STEM_PERFORMER_CLAIM_MISMATCH`(BLOCK — 권리 부담 스템의 실연자 ≠ PERFORMED_BY 보이스의 OWNED_BY 대상), `PART_NO_ORIGINAL_STEM`(WARN — 보컬·그룹 파트에 원곡 담당이 부른 스템이 없음), `PART_ORIGINAL_NO_VOICE`(BLOCK — 보컬 파트 원곡 담당 멤버에게 그 범위 보이스가 없음)

- [ ] **Step 1: 실패하는 시험** — 규칙마다 하나씩 위반 데이터를 만들고 `checkScope` 결과에 그 코드가 나오는지, 고치면 사라지는지 본다(기존 정합성 시험 `test/validation/*.test.ts`의 준비 함수를 쓴다)

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** — `checkScope` 안 기존 규칙들 뒤에 네 규칙을 더한다. 형식은 기존 `out.push({ rule, severity, subjectType, subjectId, message, hint })`를 따르고, 메시지·힌트는 한국어(기존 규칙과 같은 말투)

- [ ] **Step 4: 통과·회귀** — Run: `node --test test/validation/slot-part-rules.test.ts && npm test` / Expected: 실패 0. 기존 Dynamite 시나리오가 새 BLOCK 규칙에 걸리면 시드 데이터를 고치지 말고, 원인(규칙 조건이 기존 이름 규칙의 데이터를 잘못 보는지)을 보고하고 멈춘다

- [ ] **Step 5: Commit** — `feat(core): 정합성 규칙 — 마스터 보유자·스템 실연자와 권리 주장 불일치, 파트 원곡 스템·보이스 누락`

---

### Task 8: 회귀와 문서

- [ ] **Step 1:** Run(코어): `npm test && npm run typecheck`, (MDRL): `npm test`, (모노레포 루트): `npm test --workspaces --if-present` / Expected: 실패 0
- [ ] **Step 2:** Dynamite 보고서가 1부 완료 시점과 바이트 단위로 같은지 비교(1부 계획 Task 8과 같은 방법)
- [ ] **Step 3:** 문서 갱신 — `00_프로젝트_개요/보컬_슬롯과_라인_구조_20261022.md`의 SL-S1~SL-S3를 `- [x]`(완료 한 줄씩), `00_프로젝트_개요/E10_E11_IR_연계와_CRUD_20261022.md`의 IR-G1~IR-G3를 `- [x]`, `06_MVP/dobedupop/docs/요건추적표.md`에 행 추가(슬롯·파트, IR 생성 전 편집, 주장 함께 만들기, 정합성 규칙 4)
- [ ] **Step 4: Commit** — `docs: 2부-A 코어 완료 — 슬롯·파트, IR 생성 전 편집, 주장 함께 만들기, 정합성 규칙`
