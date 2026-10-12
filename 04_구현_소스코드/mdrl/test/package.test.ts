import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const MODULES = ["core", "facts", "allocation", "text"];

test("exports point at built files that mirror src (spec 12.51)", () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [...MODULES.map((m) => `./${m}`), "./spec/*", "./package.json"].sort());
  assert.equal(pkg.exports["./spec/*"], "./spec/*");
  assert.equal(pkg.exports["./package.json"], "./package.json");
  for (const m of MODULES) {
    assert.deepEqual(pkg.exports[`./${m}`], { types: `./dist/src/${m}/index.d.ts`, default: `./dist/src/${m}/index.js` });
    assert.ok(existsSync(new URL(`../src/${m}/index.ts`, import.meta.url)), m);
  }
  assert.deepEqual(pkg.bin, { mdrl: "./dist/bin/mdrl.js" });
  assert.ok(existsSync(new URL("../bin/mdrl.ts", import.meta.url)));
});

test("package metadata keeps it private, dependency-free and ships only dist and spec", () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(pkg.files, ["dist", "spec"]);
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.equal(pkg.scripts.smoke, "node scripts/smoke-pack.ts");
});

test("build config compiles only src and bin into dist with rewritten extensions", () => {
  const cfg = JSON.parse(readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8"));
  assert.equal(cfg.extends, "./tsconfig.json");
  assert.deepEqual(cfg.include, ["src", "bin"]);
  assert.equal(cfg.compilerOptions.outDir, "dist");
  assert.equal(cfg.compilerOptions.noEmit, false);
  assert.equal(cfg.compilerOptions.rewriteRelativeImportExtensions, true);
  assert.equal(cfg.compilerOptions.declaration, true);
});
