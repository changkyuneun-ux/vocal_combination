import { test } from "node:test";
import assert from "node:assert/strict";
import { at, tokenize } from "../../src/text/lexer.ts";
import { VcrlError } from "../../src/core/errors.ts";

const kinds = (src: string) => tokenize(src).map((t) => [t.kind, t.text]);
const failsAt = (src: string, code: string, path: string) =>
  assert.throws(() => tokenize(src), (e: unknown) =>
    e instanceof VcrlError && e.diagnostics[0]?.code === code && e.diagnostics[0]?.path === path);

test("tokens: idents, strings, numbers with units, punctuation, comments", () => {
  assert.deepEqual(kinds('master = graph(MASTER_OWNER) : 45%; // 주석\nops = 500bps;'), [
    ["ident", "master"], ["punct", "="], ["ident", "graph"], ["punct", "("], ["ident", "MASTER_OWNER"], ["punct", ")"],
    ["punct", ":"], ["number", "45%"], ["punct", ";"],
    ["ident", "ops"], ["punct", "="], ["number", "500bps"], ["punct", ";"], ["eof", ""],
  ]);
  assert.deepEqual(kinds('uses facts "nova-debut-01"@1 x |> y -> z == 12.5%'), [
    ["ident", "uses"], ["ident", "facts"], ["string", "nova-debut-01"], ["punct", "@"], ["number", "1"],
    ["ident", "x"], ["punct", "|>"], ["ident", "y"], ["punct", "->"], ["ident", "z"], ["punct", "=="], ["number", "12.5%"], ["eof", ""],
  ]);
});

test("idents may contain . and - between alphanumerics but not end with -", () => {
  assert.deepEqual(kinds("pak_nova.v-2 DISPUTED->hold"), [
    ["ident", "pak_nova.v-2"], ["ident", "DISPUTED"], ["punct", "->"], ["ident", "hold"], ["eof", ""],
  ]);
});

test("string escapes", () => {
  assert.deepEqual(kinds('"a\\"b\\\\c"'), [["string", 'a"b\\c'], ["eof", ""]]);
});

test("positions are 1-based line:col", () => {
  const t = tokenize("a\n  bb");
  assert.deepEqual(t.map((x) => [x.text, x.line, x.col]), [["a", 1, 1], ["bb", 2, 3], ["", 2, 5]]);
  assert.equal(at({ line: 3, col: 7 }), "@3:7");
});

test("lexical errors", () => {
  failsAt('"open', "PARSE_SYNTAX", "@1:1");
  failsAt('x "a\\nb"', "PARSE_SYNTAX", "@1:3");
  failsAt("10abc", "PARSE_SYNTAX", "@1:1");
  failsAt("a # b", "PARSE_SYNTAX", "@1:3");
});
