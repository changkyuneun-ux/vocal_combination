import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("only src/engine-bridge imports mdrl (design 9.2)", () => {
  const offenders = walk(SRC)
    .filter((p) => !relative(SRC, p).startsWith("engine-bridge/"))
    .filter((p) => /from\s+["']mdrl(\/[a-z]+)?["']/.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p));
  assert.deepEqual(offenders, []);
});

test("src/revenue does not import settlement (dependency runs settlement -> revenue)", () => {
  const offenders = walk(join(SRC, "revenue"))
    .filter((p) => /from\s+["'][^"']*\/settlement\//.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p));
  assert.deepEqual(offenders, []);
});

test("src/ledger does not import settlement or payout (dependency runs settlement/payout -> ledger)", () => {
  const offenders = walk(join(SRC, "ledger"))
    .filter((p) => /from\s+["'][^"']*\/(settlement|payout)\//.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p));
  assert.deepEqual(offenders, []);
});

test("src/payout does not import settlement (settlement/invariants reads payout/reconcile, so the dependency runs settlement -> payout)", () => {
  const offenders = walk(join(SRC, "payout"))
    .filter((p) => /from\s+["'][^"']*\/settlement\//.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p));
  assert.deepEqual(offenders, []);
});

test("only src/dev, src/http/server.ts and src/http/assemble.ts import src/dev (design 12.2-7)", () => {
  const allowed = new Set(["http/server.ts", "http/assemble.ts"]);
  const offenders = walk(SRC)
    .map((p) => relative(SRC, p))
    .filter((r) => !r.startsWith("dev/") && !allowed.has(r))
    .filter((r) => /from\s+["'][^"']*\/dev\//.test(readFileSync(join(SRC, r), "utf8")))
    .map((r) => r);
  assert.deepEqual(offenders, []);
});
