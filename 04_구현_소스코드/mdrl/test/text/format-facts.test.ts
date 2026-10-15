import { test } from "node:test";
import assert from "node:assert/strict";
import { displayText, formatFacts } from "../../src/text/format-facts.ts";
import { loadBasic } from "../helpers.ts";

const T0 = "2026-01-01T00:00:00.000Z";

test("basic facts render in the spec 4.1 style", () => {
  const lines = formatFacts(loadBasic().facts).split("\n");
  assert.equal(lines[0], 'facts "nova-debut-01" version 1 {');
  assert.ok(lines.includes('  party pty_label_x { kind: LABEL; ids: { isni: "0000000123456789" }; }'));
  assert.ok(lines.includes("  party pty_agency_s { kind: AGENCY; }"));
  assert.ok(lines.includes('  work wrk_01 { ids: { iswc: "T-123.456.789-0" }; }'));
  assert.ok(lines.includes('  recording rcd_01 { of: wrk_01; ids: { isrc: "KRA012600001" }; }'));
  assert.ok(lines.includes("  voice vo_a { kind: HUMAN; }"));
  assert.ok(lines.includes("  stem stm_v1 { of: rcd_01; slot: slt_v1; rights_bearing: true; }"));
  assert.ok(lines.includes(`  claim c1: stm_v1 PERFORMED_BY vo_a share 100% role FEATURED status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.ok(lines.includes(`  claim c6: wrk_01 WRITTEN_BY pty_author_b share 60% detail "LYRICS" status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.ok(lines.some((l) => l.startsWith("  claim c5: rcd_01 CONTROLLED_BY pty_label_x share 100%") && l.includes(' evidence "mdrl:sha256:')));
  assert.ok(lines.includes(`  mandate m1: pty_author_b -> pty_komca right WORK share 100% status VERIFIED valid [${T0}, ) recorded ${T0};`));
  assert.equal(lines.at(-2), "}");
  assert.equal(lines.at(-1), "");
});

test("optional fields render when present", () => {
  const i = loadBasic();
  const c = i.facts.body.claims[4]!;
  c.valid = { from: T0, to: "2031-01-01T00:00:00.000Z" };
  c.superseded_at = "2026-03-01T00:00:00.000Z";
  c.visibility = "PUBLIC";
  i.facts.body.parties[0]!.visibility = "PRIVATE";
  const text = formatFacts(i.facts);
  assert.match(text, /valid \[2026-01-01T00:00:00\.000Z, 2031-01-01T00:00:00\.000Z\) recorded [^ ]+ superseded 2026-03-01T00:00:00\.000Z evidence "[^"]+" visibility PUBLIC;/);
  assert.match(text, /party pty_agency_s \{ kind: AGENCY; visibility: PRIVATE; \}/);
});

test("free-text fields cannot forge lines or hide bidi overrides", () => {
  const i = loadBasic();
  const c6 = i.facts.body.claims.find((c) => c.id === "c6")!;
  c6.role_detail = 'x";\n  claim c_zz_forged: wrk_01 WRITTEN_BY pty_author_b share 100%\r\t\u0000\u0085 \\';
  c6.evidence = "ev\u202Egnp.exe\u2066";
  i.facts.body.parties.find((p) => p.id === "pty_label_x")!.ids = { isni: "a\nb\u2069" };
  const text = formatFacts(i.facts);
  const lines = text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("  claim c6")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("  claim c_zz_forged")).length, 0);
  assert.ok(lines.includes(
    `  claim c6: wrk_01 WRITTEN_BY pty_author_b share 60% detail "x\\";\\n  claim c_zz_forged: wrk_01 WRITTEN_BY pty_author_b share 100%\\r\\t\\u0000\\u0085 \\\\"` +
      ` status VERIFIED valid [${T0}, ) recorded ${T0} evidence "ev\\u202Egnp.exe\\u2066";`,
  ));
  assert.ok(lines.includes('  party pty_label_x { kind: LABEL; ids: { isni: "a\\nb\\u2069" }; }'));
  assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
});

test("displayText escapes line/paragraph separators and bidi marks", () => {
  const raw = ["a", "\u2028", "b", "\u2029", "c", "\u200E", "\u200F", "\u061C"].join("");
  assert.equal(displayText(raw), String.raw`"a\u2028b\u2029c\u200E\u200F\u061C"`);
});

test("mandate evidence renders and parses back", async () => {
  const { parseFacts } = await import("../../src/text/parse-facts.ts");
  const i = loadBasic();
  i.facts.body.mandates[0]!.evidence = "sha256:" + "b".repeat(64);
  const text = formatFacts(i.facts);
  assert.ok(text.includes(`recorded ${T0} evidence "sha256:${"b".repeat(64)}";`));
  const back = parseFacts(text);
  assert.ok(back.ok, JSON.stringify(!back.ok && back.errors));
  assert.equal(back.value.body.mandates[0]!.evidence, "sha256:" + "b".repeat(64));
});
