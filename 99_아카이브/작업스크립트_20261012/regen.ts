// 접두어 변경(vcrl→mdrl) 후 적합성 digest를 재계산하고, 옛 hex→새 hex를 코드 트리 전체에 치환한다.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const code = process.argv[2]!; // 04_구현_소스코드 절대경로
const mdrl = join(code, "mdrl");
const imp = (p: string) => import(pathToFileURL(join(mdrl, p)).href);
const { projectToIr } = await imp("src/facts/result.ts");
const { evaluate } = await imp("src/allocation/evaluate.ts");
const { reverse } = await imp("src/allocation/reverse.ts");

const HEX = /mdrl:sha256:([0-9a-f]{64})/;
const map = new Map<string, string>();
const note = (oldD: string, newD: string) => {
  const o = HEX.exec(oldD)?.[1], n = HEX.exec(newD)?.[1];
  if (o && n && o !== n) map.set(o, n);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", "dist", "test-results", ".blobs-dev", "prototypes"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|json|mdrl|md|sql)$/.test(e) && e !== "package-lock.json") out.push(p);
  }
  return out;
}
function applyMap() {
  let files = 0;
  for (const f of walk(code)) {
    const s = readFileSync(f, "utf8");
    let t = s;
    for (const [o, n] of map) t = t.split(o).join(n);
    if (t !== s) { writeFileSync(f, t); files++; }
  }
  return files;
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const dirs = (p: string) => readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const conf = join(mdrl, "conformance");

// 1) facts 투영 digest
for (const name of dirs(join(conf, "facts"))) {
  const input = readJson(join(conf, "facts", name, "input.json"));
  const expected = readJson(join(conf, "facts", name, "expected.json"));
  if (expected.digest === undefined) continue;
  const r = projectToIr(input.facts, input.usage, input.as_of, input.known_at);
  if (!r.ok) throw new Error(`facts/${name}: ${JSON.stringify(r.errors)}`);
  note(expected.digest, r.value.digest);
}
console.log("facts map", map.size, "files", applyMap());

// 1b) 정책 depends_on이 가리키는 facts 문서 digest
const { digestOf } = await imp("src/core/digest.ts");
for (const name of dirs(join(conf, "allocation"))) {
  const c = readJson(join(conf, "allocation", name, "input.json"));
  const f = readJson(join(conf, "facts", c.facts_case, "input.json"));
  for (const d of c.policy.depends_on ?? []) note(d.digest, digestOf(f.facts));
}
console.log("+facts doc map", map.size, "files", applyMap());

// 2) allocation result digest (입력이 갱신된 뒤 다시 읽는다)
const evalInput = (c: any) => {
  const f = readJson(join(conf, "facts", c.facts_case, "input.json"));
  const p = projectToIr(f.facts, f.usage, f.as_of, f.known_at);
  return { policy: c.policy, facts: f.facts, projection: p.value, snapshot: c.snapshot, events: c.events, runId: c.run_id };
};
for (const name of dirs(join(conf, "allocation"))) {
  const c = readJson(join(conf, "allocation", name, "input.json"));
  const expected = readJson(join(conf, "allocation", name, "expected.json"));
  if (expected.result_digest === undefined) continue;
  const r = evaluate(evalInput(c));
  if (!r.ok) throw new Error(`allocation/${name}: ${JSON.stringify(r.errors)}`);
  note(expected.result_digest, r.value.result_digest);
}
console.log("+allocation map", map.size, "files", applyMap());

// 3) reversal result digest
for (const name of dirs(join(conf, "reversal"))) {
  const input = readJson(join(conf, "reversal", name, "input.json"));
  const expected = readJson(join(conf, "reversal", name, "expected.json"));
  const c = readJson(join(conf, "allocation", input.allocation_case, "input.json"));
  const ev = evaluate(evalInput(c));
  if (!ev.ok) throw new Error(`reversal/${name} base`);
  const priors: any[] = [];
  input.steps.forEach((s: any, i: number) => {
    const r = reverse({ original: ev.value, policy: c.policy, eventId: input.event_id, refund: s.refund, priors, runId: s.run_id });
    const want = expected.steps[i];
    if (!r.ok) return;
    if (want.result_digest) note(want.result_digest, r.value.result_digest);
    priors.push(r.value);
  });
}
console.log("+reversal map", map.size, "files", applyMap());
