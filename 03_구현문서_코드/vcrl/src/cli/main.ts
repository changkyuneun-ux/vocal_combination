import { parseArgs } from "node:util";
import { digestOf } from "../core/digest.ts";
import { VcrlError, diag, fail, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { evaluate } from "../allocation/evaluate.ts";
import type { AllocationDocument, AllocationResult, RevenueEvent, Snapshot } from "../allocation/types.ts";
import { validateAllocation } from "../allocation/validate.ts";
import { checkActivation } from "../facts/activation.ts";
import type { ClaimantEntry } from "../facts/mandate.ts";
import type { Usage } from "../facts/project.ts";
import { projectToIr, type ProjectionIr } from "../facts/result.ts";
import type { FactsDocument } from "../facts/types.ts";
import { validateFacts, validateFactsStructure } from "../facts/validate.ts";
import { formatAllocation } from "../text/format-allocation.ts";
import { formatFacts } from "../text/format-facts.ts";
import { compileAllocation } from "../text/parse-allocation.ts";

export type Io = { readText(path: string): string; out(s: string): void; err(s: string): void };

export const USAGE = `사용법: vcrl <명령> [옵션]
  compile <policy.vcrl>                        텍스트 정책을 IR(JSON)로 컴파일
  fmt <doc.json>                               IR을 텍스트로 출력(facts는 읽기 전용 표시)
  check <doc.json|policy.vcrl>                 구조·불변식 검증, 성공 시 digest 출력
  project --facts F --usage U --as-of T --known-at T
  evaluate --policy P --facts F --usage U --as-of T --known-at T --snapshot S --events E --run-id R
  verify --result R (+ evaluate 옵션)          입력으로 다시 계산해 result_digest 대조
  activate --facts F --usage U --as-of T --known-at T --declared D
  help
`;

class UsageError extends Error {}

const OPTIONS = {
  facts: { type: "string" },
  usage: { type: "string" },
  "as-of": { type: "string" },
  "known-at": { type: "string" },
  policy: { type: "string" },
  snapshot: { type: "string" },
  events: { type: "string" },
  "run-id": { type: "string" },
  result: { type: "string" },
  declared: { type: "string" },
} as const;

type Opts = Partial<Record<keyof typeof OPTIONS, string>>;

/** 명령별 필수 옵션. 파일을 읽기 전에 모두 검사해, 사용법 오류(종료 2)가 입력 읽기 오류(종료 1)보다 먼저 보고되게 한다. */
const REQUIRED: Readonly<Partial<Record<string, readonly (keyof typeof OPTIONS)[]>>> = {
  project: ["facts", "usage", "as-of", "known-at"],
  evaluate: ["policy", "facts", "usage", "as-of", "known-at", "snapshot", "events", "run-id"],
  verify: ["result", "policy", "facts", "usage", "as-of", "known-at", "snapshot", "events", "run-id"],
  activate: ["facts", "usage", "as-of", "known-at", "declared"],
};

function requireOptions(o: Opts, cmd: string): void {
  const names = REQUIRED[cmd];
  if (names === undefined) return;
  const missing = names.filter((n) => o[n] === undefined);
  if (missing.length > 0) throw new UsageError(`다음 옵션이 필요합니다: ${missing.map((n) => `--${n}`).join(", ")}`);
}

/** CLI 진입점. 입출력은 주입받는다. 반환값은 종료 코드(0 성공, 1 진단 실패, 2 사용법 오류). */
export function run(argv: readonly string[], io: Io): number {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "help" || cmd === "--help") {
      io.out(USAGE);
      return 0;
    }
    let parsed: { values: Opts; positionals: string[] };
    try {
      parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true }) as { values: Opts; positionals: string[] };
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
    return dispatch(cmd, parsed.values, parsed.positionals, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof VcrlError) {
      report(io, e.diagnostics);
      return 1;
    }
    // 안전망: 라이브러리 경계에서 잡히지 않은 예외도 진단 형식으로 stderr 한 줄에 보고한다(스택은 노출하지 않는다).
    const message = e instanceof Error ? e.message : String(e);
    io.err(`CORE_TYPE_ERROR $ unexpected error: ${message}\n`);
    return 1;
  }
}

function dispatch(cmd: string | undefined, o: Opts, pos: string[], io: Io): number {
  if (cmd !== undefined) requireOptions(o, cmd);
  switch (cmd) {
    case "compile": {
      printJson(io, loadPolicy(io, onePositional(pos)));
      return 0;
    }
    case "fmt": {
      const path = onePositional(pos);
      const doc = readJson(io, path);
      if (isPlainObject(doc) && doc.module === "facts") {
        throwIf(validateFactsStructure(doc));
        io.out(formatFacts(doc as unknown as FactsDocument));
      } else if (isPlainObject(doc) && doc.module === "allocation") {
        throwIf(validateAllocation(doc));
        io.out(formatAllocation(doc as unknown as AllocationDocument));
      } else {
        fail("CORE_TYPE_ERROR", `${path}:$.module`, "expected a facts or allocation document");
      }
      return 0;
    }
    case "check": {
      const path = onePositional(pos);
      const doc = path.endsWith(".vcrl") ? loadPolicy(io, path) : readJson(io, path);
      if (isPlainObject(doc) && doc.module === "facts") throwIf(validateFacts(doc));
      else if (isPlainObject(doc) && doc.module === "allocation") throwIf(validateAllocation(doc));
      else fail("CORE_TYPE_ERROR", `${path}:$.module`, "expected a facts or allocation document");
      io.out(`OK ${digestOf(doc)}\n`);
      return 0;
    }
    case "project": {
      printJson(io, project(io, o));
      return 0;
    }
    case "evaluate": {
      printJson(io, evaluateFromFiles(io, o).result);
      return 0;
    }
    case "verify": {
      const given = readJson(io, need(o, "result"));
      const { result, projection } = evaluateFromFiles(io, o);
      const errors: Diagnostic[] = [];
      if (!isPlainObject(given)) {
        errors.push(diag("CORE_TYPE_ERROR", "$.result", "must be an object"));
      } else {
        if (given.projection_digest !== projection.digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.result.projection_digest", String(given.projection_digest)));
        if (given.result_digest !== result.result_digest) errors.push(diag("CORE_DIGEST_MISMATCH", "$.result.result_digest", String(given.result_digest)));
        if (digestOf({ ...given, result_digest: undefined }) !== result.result_digest) {
          errors.push(diag("CORE_DIGEST_MISMATCH", "$.result", "result content does not match the recomputed result"));
        }
      }
      throwIf(errors);
      io.out(`OK ${result.result_digest}\n`);
      return 0;
    }
    case "activate": {
      throwIf(checkActivation({
        facts: readJson(io, need(o, "facts")) as FactsDocument,
        usage: readJson(io, need(o, "usage")) as Usage,
        asOf: need(o, "as-of"),
        knownAt: need(o, "known-at"),
        declared: readJson(io, need(o, "declared")) as ClaimantEntry[],
      }));
      io.out("OK\n");
      return 0;
    }
    default:
      throw new UsageError(cmd === undefined ? "명령이 필요합니다" : `알 수 없는 명령: ${cmd}`);
  }
}

function project(io: Io, o: Opts): ProjectionIr {
  const r = projectToIr(
    readJson(io, need(o, "facts")) as FactsDocument, readJson(io, need(o, "usage")) as Usage, need(o, "as-of"), need(o, "known-at"),
  );
  if (!r.ok) throw new VcrlError(r.errors);
  return r.value;
}

/** 투영은 입력으로 계산하고(제공된 투영을 받지 않는다) 평가한다. */
function evaluateFromFiles(io: Io, o: Opts): { result: AllocationResult; projection: ProjectionIr } {
  const projection = project(io, o);
  const r = evaluate({
    policy: loadPolicy(io, need(o, "policy")),
    facts: readJson(io, need(o, "facts")) as FactsDocument,
    projection,
    snapshot: readJson(io, need(o, "snapshot")) as Snapshot,
    events: readJson(io, need(o, "events")) as RevenueEvent[],
    runId: need(o, "run-id"),
  });
  if (!r.ok) throw new VcrlError(r.errors);
  return { result: r.value, projection };
}

function loadPolicy(io: Io, path: string): AllocationDocument {
  if (!path.endsWith(".vcrl")) return readJson(io, path) as AllocationDocument;
  const r = compileAllocation(readText(io, path));
  if (!r.ok) throw new VcrlError(r.errors);
  return r.value;
}

function readText(io: Io, path: string): string {
  try {
    return io.readText(path);
  } catch {
    return fail("CORE_UNKNOWN_REF", path, "cannot read file");
  }
}

function readJson(io: Io, path: string): unknown {
  const text = readText(io, path);
  try {
    return JSON.parse(text);
  } catch {
    return fail("CORE_TYPE_ERROR", path, "invalid JSON");
  }
}

function need(o: Opts, name: keyof typeof OPTIONS): string {
  const v = o[name];
  if (v === undefined) throw new UsageError(`--${name} 옵션이 필요합니다`);
  return v;
}

function onePositional(pos: string[]): string {
  if (pos.length !== 1) throw new UsageError("파일 경로 하나가 필요합니다");
  return pos[0]!;
}

function throwIf(errors: Diagnostic[]): void {
  if (errors.length > 0) throw new VcrlError(errors);
}

function printJson(io: Io, v: unknown): void {
  io.out(JSON.stringify(v, null, 2) + "\n");
}

function report(io: Io, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) io.err(`${d.code} ${d.path} ${d.message}\n`);
}
