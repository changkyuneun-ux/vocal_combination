import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFrame, checkFields, type FrameField } from "../../src/contracts/frames.ts";

// 읽기 틀 적용(결정 CT1): 사람이 표시한 인용 문장에서 값 모양대로 값을 뽑는다. 안 맞으면 후보를 만들지 않는다(사람이 입력).
export const PUBLISHING_FRAME: FrameField[] = [
  { key: "title", label: "곡명", irItem: "WORK_TITLE", page: 1, clause: "제1조", pattern: "본 계약의 대상 저작물은 「{text}」" },
  { key: "author1", label: "작가 · 지분 1", irItem: "AUTHOR_SHARE", page: 2, clause: "제3조 1항", pattern: "작가 갑의 지분은 {percent}퍼센트", partyOrder: 1, roleDetail: "LYRICS_COMPOSITION" },
  { key: "author2", label: "작가 · 지분 2", irItem: "AUTHOR_SHARE", page: 2, clause: "제3조 2항", pattern: "작가 을의 지분은 {percent}퍼센트", partyOrder: 2, roleDetail: "LYRICS_COMPOSITION" },
  { key: "effectiveFrom", label: "효력 시작", irItem: "EFFECTIVE_FROM", page: 1, clause: "제2조", pattern: "{date}부터 효력" },
];
const parties = [{ partyId: "pty_ds", name: "David Stewart" }, { partyId: "pty_ja", name: "Jessica Agombar" }];

test("applyFrame reads {text}, {percent} with party order, and a Korean {date}", () => {
  const c = applyFrame(PUBLISHING_FRAME, {
    title: "본 계약의 대상 저작물은 「Dynamite」으로 한다", author1: "작가 갑의 지분은 50퍼센트", author2: "“작가 을의 지분은 50 퍼센트”", effectiveFrom: "이 계약은 2026년 1월 1일부터 효력이 있다",
  }, { parties });
  assert.deepEqual(c.map((x) => x.value), [
    { text: "Dynamite" }, { partyId: "pty_ds", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" }, { partyId: "pty_ja", shareBps: 5000, roleDetail: "LYRICS_COMPOSITION" }, { date: "2026-01-01" },
  ]);
});

test("applyFrame reads {bps}, {party} by name and an ISO {date}; a missing or mismatched quote leaves the value to a person", () => {
  const fields: FrameField[] = [
    { key: "share", label: "지분", irItem: "AUTHOR_SHARE", page: 3, clause: "제5조", pattern: "{party}의 몫은 {bps}bps" },
    { key: "owner", label: "마스터 보유자", irItem: "MASTER_OWNER", page: 1, clause: "제1조", pattern: "마스터 권리자: {party}" },
    { key: "from", label: "효력", irItem: "EFFECTIVE_FROM", page: 1, clause: "제2조", pattern: "효력 시작 {date}" },
    { key: "gone", label: "없음", irItem: "WORK_TITLE", page: 1, clause: "제1조", pattern: "곡명 {text}" },
  ];
  const c = applyFrame(fields, { share: "Jessica Agombar의 몫은 2500bps", owner: "마스터 권리자: 모르는 회사", from: "효력 시작 2026-02-30" }, { parties });
  assert.deepEqual(c[0]!.value, { partyId: "pty_ja", shareBps: 2500, roleDetail: null });
  assert.equal(c[1]!.value, null, "unknown party");
  assert.equal(c[2]!.value, null, "not a real date");
  assert.equal(c[3]!.value, null);
  assert.match(c[3]!.reason!, /사람이 입력/);
  assert.equal(applyFrame([PUBLISHING_FRAME[1]!], { author1: "작가 갑의 몫은 절반" }, { parties })[0]!.value, null, "shape does not match");
  assert.equal(applyFrame([PUBLISHING_FRAME[1]!], { author1: "작가 갑의 지분은 150퍼센트" }, { parties })[0]!.value, null, "share over 100%");
});

test("checkFields refuses unknown IR items, duplicate keys and patterns without a value slot", () => {
  assert.equal(checkFields(PUBLISHING_FRAME).length, 4);
  assert.throws(() => checkFields([{ ...PUBLISHING_FRAME[0]!, irItem: "PRICE" }]), /irItem/);
  assert.throws(() => checkFields([PUBLISHING_FRAME[0]!, PUBLISHING_FRAME[0]!]), /unique/);
  assert.throws(() => checkFields([{ ...PUBLISHING_FRAME[0]!, pattern: "값 자리 없음" }]), /pattern/);
  assert.throws(() => checkFields([]), /non-empty/);
});
