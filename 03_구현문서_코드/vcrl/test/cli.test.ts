import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, type Io } from "../src/cli/main.ts";
import { loadAllocationCase, loadBasic } from "./helpers.ts";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

function fixture(): Map<string, string> {
  const basic = loadBasic();
  const alloc = loadAllocationCase();
  const j = (v: unknown) => JSON.stringify(v);
  return new Map([
    ["policy.vcrl", read("conformance/text/001-basic.vcrl")],
    ["policy.json", j(alloc.policy)],
    ["facts.json", j(basic.facts)],
    ["usage.json", j(basic.usage)],
    ["snapshot.json", j(alloc.snapshot)],
    ["events.json", j(alloc.events)],
    ["declared.json", j(basic.declared_claimants)],
    ["bad.vcrl", 'allocation "x" version 1 { scope { pack p; } }'],
    ["broken.json", "{"],
  ]);
}

function cli(argv: string[], files = fixture()) {
  let out = "";
  let err = "";
  const io: Io = {
    readText: (p) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return v;
    },
    out: (s) => { out += s; },
    err: (s) => { err += s; },
  };
  const code = run(argv, io);
  return { code, out, err };
}

const TIMES = ["--as-of", "2026-06-01T00:00:00.000Z", "--known-at", "2026-06-01T00:00:00.000Z"];
const EVAL = ["--policy", "policy.vcrl", "--facts", "facts.json", "--usage", "usage.json", ...TIMES,
  "--snapshot", "snapshot.json", "--events", "events.json", "--run-id", "run_2026_06"];
const expectedDigest = () => JSON.parse(read("conformance/allocation/001-basic/expected.json")).result_digest as string;

test("compile turns text into the conformance IR", () => {
  const r = cli(["compile", "policy.vcrl"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), loadAllocationCase().policy);
});

test("compile reports syntax errors with positions", () => {
  const r = cli(["compile", "bad.vcrl"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^PARSE_SYNTAX @1:41 /);
});

test("check, fmt and project", () => {
  assert.match(cli(["check", "facts.json"]).out, /^OK vcrl:sha256:4c8fc5573e79e0da0e23eee13566d4af8c5aa5fd319319f7b2684a78077ca6f4\n$/);
  assert.equal(cli(["check", "policy.vcrl"]).code, 0);
  assert.match(cli(["fmt", "facts.json"]).out, /^facts "nova-debut-01" version 1 \{\n/);
  const fmt = cli(["fmt", "policy.json"]);
  const files = fixture();
  files.set("round.vcrl", fmt.out);
  assert.deepEqual(JSON.parse(cli(["compile", "round.vcrl"], files).out), loadAllocationCase().policy);
  const p = cli(["project", "--facts", "facts.json", "--usage", "usage.json", ...TIMES]);
  assert.equal(p.code, 0, p.err);
  assert.deepEqual(JSON.parse(p.out).vectors.MASTER_OWNER, { pty_label_x: "1/1" });
});

test("evaluate from text reproduces the conformance result digest, verify accepts it", () => {
  const r = cli(["evaluate", ...EVAL]);
  assert.equal(r.code, 0, r.err);
  const result = JSON.parse(r.out);
  assert.equal(result.result_digest, expectedDigest());
  const files = fixture();
  files.set("result.json", r.out);
  const v = cli(["verify", "--result", "result.json", ...EVAL], files);
  assert.equal(v.code, 0, v.err);
  assert.equal(v.out, `OK ${expectedDigest()}\n`);
  result.lines[0].amount = "1";
  files.set("tampered.json", JSON.stringify(result));
  const t = cli(["verify", "--result", "tampered.json", ...EVAL], files);
  assert.equal(t.code, 1);
  assert.match(t.err, /^CORE_DIGEST_MISMATCH /m);
});

test("activate", () => {
  const ok = cli(["activate", "--facts", "facts.json", "--usage", "usage.json", ...TIMES, "--declared", "declared.json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, "OK\n");
  const files = fixture();
  files.set("declared.json", JSON.stringify(loadBasic().declared_claimants.filter((c) => c.role !== "CMO")));
  const drift = cli(["activate", "--facts", "facts.json", "--usage", "usage.json", ...TIMES, "--declared", "declared.json"], files);
  assert.equal(drift.code, 1);
  assert.match(drift.err, /^FACTS_CLAIMANT_DRIFT /m);
});

test("usage errors exit 2, input errors exit 1", () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli(["nope"]).code, 2);
  assert.equal(cli(["project", "--facts", "facts.json"]).code, 2);
  assert.equal(cli(["compile", "a.vcrl", "--bogus"]).code, 2);
  const missing = cli(["check", "missing.json"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^CORE_UNKNOWN_REF missing\.json /);
  assert.match(cli(["check", "broken.json"]).err, /^CORE_TYPE_ERROR broken\.json /);
  const help = cli(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /사용법: vcrl/);
});

test("bin/vcrl.ts runs as a Node executable", () => {
  const bin = fileURLToPath(new URL("../bin/vcrl.ts", import.meta.url));
  const out = execFileSync(process.execPath, [bin, "help"], { encoding: "utf8" });
  assert.match(out, /사용법: vcrl/);
});
