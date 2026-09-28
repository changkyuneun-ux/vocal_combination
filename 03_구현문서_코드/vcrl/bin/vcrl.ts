#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "../src/cli/main.ts";

process.exitCode = run(process.argv.slice(2), {
  readText: (p) => readFileSync(p, "utf8"),
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
