// tarball 스모크 테스트(스펙 12.52): npm pack → 임시 디렉터리에 설치 → 라이브러리·CLI(verify 포함)·타입 선언·스키마 export 확인.
// 네트워크 없이 돈다(런타임 의존성이 없으므로 --offline 설치). 실행: npm run smoke
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const requireFromPkg = createRequire(join(pkg, "package.json"));
const tscBin = requireFromPkg.resolve("typescript/bin/tsc");
const typesRoot = dirname(dirname(requireFromPkg.resolve("@types/node/package.json")));
const tmp = mkdtempSync(join(tmpdir(), "vcrl-smoke-"));
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: "utf8" });
const read = (rel: string) => readFileSync(join(pkg, rel), "utf8");

try {
  // prepack의 빌드 출력이 --json 출력에 섞이지 않도록 빌드를 먼저 따로 돌리고 pack은 스크립트 없이 실행한다.
  sh("npm", ["run", "build"], pkg);
  const packed = JSON.parse(sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], pkg)) as { filename: string; files: { path: string }[] }[];
  const shipped = packed[0]!.files.map((f) => f.path);
  for (const must of [
    "dist/src/core/index.js", "dist/src/core/index.d.ts", "dist/src/facts/index.js", "dist/src/allocation/index.js",
    "dist/src/allocation/verify.d.ts", "dist/src/text/index.js", "dist/bin/vcrl.js",
    "spec/schema/projection.ir.schema.json", "spec/schema/allocation.result.schema.json", "spec/grammar/allocation.ebnf",
  ]) assert.ok(shipped.includes(must), `tarball is missing ${must}`);
  const leaked = shipped.filter((f) => /^(src|test|conformance|scripts|samples)\//.test(f));
  assert.deepEqual(leaked, [], "tarball must ship only dist and spec");

  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "vcrl-smoke-app", private: true, type: "module" }));
  sh("npm", ["install", "--offline", "--no-audit", "--no-fund", join(tmp, packed[0]!.filename)], app);

  const alloc = JSON.parse(read("conformance/allocation/001-basic/input.json"));
  const facts = JSON.parse(read(`conformance/facts/${alloc.facts_case}/input.json`));
  const expected = JSON.parse(read("conformance/allocation/001-basic/expected.json"));
  const put = (name: string, v: unknown) => writeFileSync(join(app, name), typeof v === "string" ? v : JSON.stringify(v));
  put("policy.vcrl", read("conformance/text/001-basic.vcrl"));
  put("facts.json", facts.facts);
  put("usage.json", facts.usage);
  put("snapshot.json", alloc.snapshot);
  put("events.json", alloc.events);

  // 1) 라이브러리: 네 진입점을 import해 컴파일 → 투영 → 평가 → 검증.
  const args = { asOf: facts.as_of, knownAt: facts.known_at, runId: alloc.run_id };
  put("check.mjs", `
import { readFileSync } from "node:fs";
import { digestOf } from "vcrl/core";
import { projectToIr } from "vcrl/facts";
import { evaluate, verifyAllocationResult } from "vcrl/allocation";
import { compileAllocation } from "vcrl/text";
const j = (f) => JSON.parse(readFileSync(f, "utf8"));
const { asOf, knownAt, runId } = ${JSON.stringify(args)};
const policy = compileAllocation(readFileSync("policy.vcrl", "utf8"));
if (!policy.ok) throw new Error(JSON.stringify(policy.errors));
const facts = j("facts.json"), usage = j("usage.json"), snapshot = j("snapshot.json"), events = j("events.json");
const p = projectToIr(facts, usage, asOf, knownAt);
if (!p.ok) throw new Error(JSON.stringify(p.errors));
const r = evaluate({ policy: policy.value, facts, projection: p.value, snapshot, events, runId });
if (!r.ok) throw new Error(JSON.stringify(r.errors));
const v = verifyAllocationResult({ policy: policy.value, facts, usage, asOf, knownAt, snapshot, events, runId }, r.value);
if (v.length > 0) throw new Error(JSON.stringify(v));
if (!digestOf({}).startsWith("vcrl:sha256:")) throw new Error("digestOf");
for (const spec of ["vcrl/spec/schema/allocation.result.schema.json", "vcrl/package.json"]) {
  if (!import.meta.resolve(spec).startsWith("file:")) throw new Error("cannot resolve " + spec);
}
console.log(r.value.result_digest);
`);
  assert.equal(sh(process.execPath, ["check.mjs"], app).trim(), expected.result_digest, "library result digest");

  // 2) 설치된 CLI.
  const vcrl = join(app, "node_modules", ".bin", "vcrl");
  assert.deepEqual(JSON.parse(sh(vcrl, ["compile", "policy.vcrl"], app)), alloc.policy, "vcrl compile");
  const evalArgs = [
    "--policy", "policy.vcrl", "--facts", "facts.json", "--usage", "usage.json",
    "--as-of", facts.as_of, "--known-at", facts.known_at, "--snapshot", "snapshot.json", "--events", "events.json", "--run-id", alloc.run_id,
  ];
  const evaluated = sh(vcrl, ["evaluate", ...evalArgs], app);
  const result = JSON.parse(evaluated);
  assert.equal(result.result_digest, expected.result_digest, "vcrl evaluate");
  put("result.json", evaluated);
  assert.equal(sh(vcrl, ["verify", "--result", "result.json", ...evalArgs], app), `OK ${expected.result_digest}\n`, "vcrl verify");
  const tampered = structuredClone(result);
  tampered.lines[0].amount = "1";
  put("tampered.json", tampered);
  assert.throws(
    () => execFileSync(vcrl, ["verify", "--result", "tampered.json", ...evalArgs], { cwd: app, encoding: "utf8", stdio: "pipe" }),
    (e: { status?: number }) => e.status === 1,
    "vcrl verify must exit 1 on a tampered result",
  );

  // 3) 타입 선언 소비.
  put("types.ts", `
import { ALLOCATION_RESULT_FORMAT, evaluate, verifyAllocationResult, type AllocationResult, type VerificationInput } from "vcrl/allocation";
import { digestOf, type Diagnostic } from "vcrl/core";
import { PROJECTION_FORMAT, projectToIr, type ProjectionIr } from "vcrl/facts";
import { compileAllocation } from "vcrl/text";
export const formats: ["vcrl-allocation-result/1", "vcrl-projection/1"] = [ALLOCATION_RESULT_FORMAT, PROJECTION_FORMAT];
export const check = (input: VerificationInput, r: AllocationResult): Diagnostic[] => verifyAllocationResult(input, r);
export const fns = [evaluate, projectToIr, compileAllocation, digestOf] as const;
export type Fmt = ProjectionIr["format"];
// @ts-expect-error result_digest는 문자열이다
export const bad: AllocationResult["result_digest"] = 1;
`);
  put("tsconfig.json", {
    compilerOptions: {
      target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false,
      types: ["node"], typeRoots: [typesRoot],
    },
    files: ["types.ts"],
  });
  sh(process.execPath, [tscBin, "-p", "tsconfig.json"], app);

  console.log(`smoke OK ${expected.result_digest}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try {
    sh("npm", ["run", "clean"], pkg);
  } catch {
    // 정리 실패는 스모크 결과를 바꾸지 않는다.
  }
}
