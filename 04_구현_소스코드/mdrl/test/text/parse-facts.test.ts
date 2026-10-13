import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFacts } from "../../src/text/format-facts.ts";
import { parseFacts, compileFacts } from "../../src/text/parse-facts.ts";
import type { FactsDocument } from "../../src/facts/types.ts";

const sampleFacts: FactsDocument = {
  mdrl: "1.0",
  module: "facts",
  id: "test-facts-01",
  version: "1",
  depends_on: [],
  visibility_default: "PARTIES",
  body: {
    parties: [
      { id: "pty_author_1", kind: "AUTHOR", ids: { KOMCA: "W001" } },
      { id: "pty_author_2", kind: "AUTHOR" },
      { id: "pty_cmo", kind: "CMO" },
    ],
    works: [{ id: "ast_work_1", ids: { ISWC: "T-000.000.001-0" } }],
    recordings: [{ id: "ast_rec_1", of: "ast_work_1", ids: { ISRC: "KR-A01-26-00001" } }],
    voices: [{ id: "ast_voice_1", kind: "HUMAN" }],
    stems: [{ id: "ast_stem_1", of: "ast_rec_1", slot: "s_lead", rights_bearing: true }],
    claims: [
      {
        id: "c1",
        source: "ast_work_1",
        edge: "WRITTEN_BY",
        target: "pty_author_1",
        share: "6000",
        status: "VERIFIED",
        valid: { from: "2026-01-01T00:00:00.000Z" },
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "c2",
        source: "ast_work_1",
        edge: "WRITTEN_BY",
        target: "pty_author_2",
        share: "4000",
        status: "VERIFIED",
        valid: { from: "2026-01-01T00:00:00.000Z" },
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    mandates: [
      {
        id: "m1",
        from: "pty_author_2",
        to: "pty_cmo",
        right: "WORK",
        share: "10000",
        status: "VERIFIED",
        valid: { from: "2026-01-01T00:00:00.000Z" },
        recorded_at: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
};

test("formatFacts and parseFacts round-trip", () => {
  const formatted = formatFacts(sampleFacts);
  const parsed = parseFacts(formatted);
  if (!parsed.ok) console.error("PARSE ERRORS:", parsed.errors);
  assert.equal(parsed.ok, true);

  if (parsed.ok) {
    assert.equal(parsed.value.id, sampleFacts.id);
    assert.equal(parsed.value.version, sampleFacts.version);
    assert.deepEqual(parsed.value.body.parties, sampleFacts.body.parties);
    assert.deepEqual(parsed.value.body.works, sampleFacts.body.works);
    assert.deepEqual(parsed.value.body.recordings, sampleFacts.body.recordings);
    assert.deepEqual(parsed.value.body.claims, sampleFacts.body.claims);
    assert.deepEqual(parsed.value.body.mandates, sampleFacts.body.mandates);
  }
});

test("compileFacts validates structure and invariants", () => {
  const formatted = formatFacts(sampleFacts);
  const compiled = compileFacts(formatted);
  assert.equal(compiled.ok, true);
});

test("parseFacts reports syntax errors with line:col", () => {
  const bad = 'facts "bad" version 1 {\n  party p1 { invalid_key: x; }\n}';
  const parsed = parseFacts(bad);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors[0]);
    assert.equal(parsed.errors[0].code, "PARSE_SYNTAX");
    assert.equal(parsed.errors[0].path.startsWith("@2:"), true);
  }
});
