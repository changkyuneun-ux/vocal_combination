import { parseBps, percentToBps } from "../core/bps.ts";
import { attempt, err, fail, ok, type Result } from "../core/errors.ts";
import type { EnumValue } from "../core/enums.ts";
import type { Dependency } from "../core/envelope.ts";
import { MAX_VECTOR_DEPTH, validateAllocation } from "../allocation/validate.ts";
import type { AllocationBody, AllocationDocument, SplitBucket, Tier1Bucket, VectorExpr } from "../allocation/types.ts";
import type { ClaimantRole } from "../facts/types.ts";
import { at, tokenize, type Token } from "./lexer.ts";
import { inferRole } from "./roles.ts";

const REQUIRED_BLOCKS = ["scope", "bind", "tier1", "tier2", "rounding"] as const;
const FIXED_EXCEPTIONS: Readonly<Record<string, string>> = { DISPUTED: "DISPUTED_SHARE", FRAUD_FLAG: "RIGHTS_POOL" };

/** 텍스트를 IR로 파싱만 한다(IR 검증 없음). 문법 오류는 PARSE_* 진단으로 돌려준다. */
export function parseAllocation(src: string): Result<AllocationDocument> {
  return attempt(() => parseProgram(tokenize(src)));
}

/** 파싱 후 validateAllocation까지 통과해야 성공이다. */
export function compileAllocation(src: string): Result<AllocationDocument> {
  const parsed = parseAllocation(src);
  if (!parsed.ok) return parsed;
  const errors = validateAllocation(parsed.value);
  return errors.length > 0 ? err(errors) : ok(parsed.value);
}

function parseProgram(toks: readonly Token[]): AllocationDocument {
  let k = 0;
  const peek = () => toks[k]!;
  /** eof 토큰을 넘어가지 않는다: 잘린 입력에서도 반복 호출이 eof 위치의 진단을 안전하게 낸다. */
  const next = () => {
    const t = toks[k]!;
    if (t.kind !== "eof") k++;
    return t;
  };
  const describe = (t: Token) => (t.kind === "eof" ? "end of input" : `${t.kind} ${JSON.stringify(t.text)}`);
  const isP = (t: Token, s: string) => t.kind === "punct" && t.text === s;
  const isW = (t: Token, s: string) => t.kind === "ident" && t.text === s;
  const expectP = (s: string): Token => {
    const t = next();
    if (!isP(t, s)) fail("PARSE_SYNTAX", at(t), `expected "${s}", found ${describe(t)}`);
    return t;
  };
  const expectW = (s: string): Token => {
    const t = next();
    if (!isW(t, s)) fail("PARSE_SYNTAX", at(t), `expected ${s}, found ${describe(t)}`);
    return t;
  };
  const ident = (what: string): string => {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected ${what}, found ${describe(t)}`);
    return t.text;
  };
  const str = (what: string): string => {
    const t = next();
    if (t.kind !== "string") fail("PARSE_SYNTAX", at(t), `expected ${what} (quoted string), found ${describe(t)}`);
    return t.text;
  };
  const id = (what: string): string => {
    const t = next();
    if (t.kind !== "ident" && t.kind !== "string") fail("PARSE_SYNTAX", at(t), `expected ${what}, found ${describe(t)}`);
    return t.text;
  };
  const int = (what: string): string => {
    const t = next();
    if (t.kind !== "number" || !/^[1-9]\d*$/.test(t.text)) fail("PARSE_SYNTAX", at(t), `expected ${what} (positive integer), found ${describe(t)}`);
    return t.text;
  };
  const ratio = (): string => {
    const t = next();
    if (t.kind === "number" && t.text.endsWith("bps")) {
      const raw = t.text.slice(0, -3);
      if (!/^\d+$/.test(raw)) fail("PARSE_SYNTAX", at(t), "bps must be an integer");
      return String(parseBps(raw, at(t)));
    }
    if (t.kind === "number" && t.text.endsWith("%")) return String(percentToBps(t.text.slice(0, -1), at(t)));
    return fail("PARSE_SYNTAX", at(t), `expected a ratio like 45% or 4500bps, found ${describe(t)}`);
  };
  const list = <T>(item: () => T): T[] => {
    const out = [item()];
    while (isP(peek(), ",")) {
      next();
      out.push(item());
    }
    return out;
  };

  const primary = (): VectorExpr => {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected a vector expression, found ${describe(t)}`);
    switch (t.text) {
      case "graph": {
        expectP("(");
        const role = ident("claimant role") as ClaimantRole;
        expectP(")");
        if (isW(peek(), "via")) {
          next();
          expectW("mandate");
          return { fn: "graph", role, via_mandate: true };
        }
        return { fn: "graph", role };
      }
      case "contract": {
        expectP("(");
        const party = id("party id");
        expectP(")");
        return { fn: "contract", party };
      }
      case "member_pct":
        expectP("(");
        expectP(")");
        return { fn: "member_pct" };
      case "performance_pool": {
        expectP("(");
        const e: Record<string, string> = { fn: "performance_pool", mode: ident("pool mode") };
        while (isP(peek(), ",")) {
          next();
          const key = next();
          if (key.kind !== "ident") fail("PARSE_SYNTAX", at(key), `expected an argument name, found ${describe(key)}`);
          if (key.text === "__proto__") fail("PARSE_SYNTAX", at(key), "__proto__ is not a valid argument name");
          if (Object.hasOwn(e, key.text)) fail("PARSE_SYNTAX", at(key), `duplicate argument ${key.text}`);
          expectP(":");
          e[key.text] = ratio();
        }
        expectP(")");
        return e as unknown as VectorExpr;
      }
      case "mix": {
        expectP("(");
        const parts = list(() => {
          const weight = ratio();
          expectP(":");
          return { weight, of: vector() };
        });
        expectP(")");
        return { fn: "mix", parts };
      }
      default:
        return fail("PARSE_SYNTAX", at(t), `unknown vector function ${t.text}`);
    }
  };
  /** mix 재귀와 |> 파이프 연결을 합친 벡터 식의 총 중첩 한도(스택 오버플로 방지). 셈법은 IR 깊이와 같다(검증기와 공유). */
  let vectorDepth = 0;
  const vector = (): VectorExpr => {
    let localDepth = 0;
    const enterDepth = (pos: Token): void => {
      vectorDepth++;
      localDepth++;
      if (vectorDepth > MAX_VECTOR_DEPTH) fail("PARSE_SYNTAX", at(pos), "vector nesting too deep");
    };
    enterDepth(peek());
    try {
      let v = primary();
      while (isP(peek(), "|>")) {
        next();
        const t = next();
        enterDepth(t);
        if (isW(t, "cap")) {
          expectP("(");
          const max = ratio();
          expectP(")");
          v = { fn: "cap", max, of: v };
        } else if (isW(t, "floor_guarantee")) {
          expectP("(");
          const min = ratio();
          expectP(")");
          v = { fn: "floor_guarantee", min, of: v };
        } else {
          fail("PARSE_SYNTAX", at(t), `expected cap or floor_guarantee after |>, found ${describe(t)}`);
        }
      }
      return v;
    } finally {
      vectorDepth -= localDepth;
    }
  };

  const tier1Buckets = (): Tier1Bucket[] => {
    expectP("{");
    const out: Tier1Bucket[] = [];
    while (!isP(peek(), "}")) {
      const name = ident("bucket name");
      expectP("=");
      out.push({ name, bps: ratio() });
      expectP(";");
    }
    expectP("}");
    return out;
  };
  const splitBuckets = (): SplitBucket[] => {
    expectP("{");
    const out: SplitBucket[] = [];
    while (!isP(peek(), "}")) {
      const start = peek();
      const name = ident("bucket name");
      expectP("=");
      const vec = vector();
      expectP(":");
      const bps = ratio();
      let role: string | undefined;
      if (isW(peek(), "as")) {
        next();
        role = ident("claimant role");
      } else {
        role = inferRole(vec);
      }
      if (role === undefined) fail("PARSE_ROLE_REQUIRED", at(start), `bucket ${name}: add "as <ROLE>"`);
      expectP(";");
      out.push({ name, bps, role: role as ClaimantRole, vector: vec });
    }
    expectP("}");
    return out;
  };
  const guard = (): void => {
    expectP("{");
    while (!isP(peek(), "}")) {
      expectW("require");
      const t = next();
      if (isW(t, "covered")) {
        expectP("(");
        const what = next();
        if (what.kind !== "ident") fail("PARSE_SYNTAX", at(what), `expected all_claimants, found ${describe(what)}`);
        if (what.text !== "all_claimants") fail("PARSE_UNSUPPORTED", at(what), "only covered(all_claimants) is supported");
        expectP(")");
      } else if (isW(t, "sum")) {
        expectP("(");
        expectW("split");
        expectP(")");
        expectP("==");
        const total = peek();
        if (ratio() !== "10000") fail("PARSE_UNSUPPORTED", at(total), "sum(split) must be 100%");
      } else {
        fail("PARSE_UNSUPPORTED", at(t), `unsupported guard ${describe(t)}`);
      }
      expectP(";");
    }
    expectP("}");
  };
  const exceptions = (): void => {
    expectP("{");
    while (!isP(peek(), "}")) {
      expectW("on");
      const onTok = peek();
      const on = ident("exception name");
      expectP("->");
      expectW("hold");
      expectP("(");
      const target = ident("hold target");
      expectP(")");
      expectP(";");
      if (!Object.hasOwn(FIXED_EXCEPTIONS, on) || FIXED_EXCEPTIONS[on] !== target) {
        fail("PARSE_UNSUPPORTED", at(onTok), "exceptions are fixed: on DISPUTED -> hold(DISPUTED_SHARE); on FRAUD_FLAG -> hold(RIGHTS_POOL)");
      }
    }
    expectP("}");
  };

  expectW("allocation");
  const docId = str("policy id");
  expectW("version");
  const version = int("version");
  expectP("{");
  const seen = new Set<string>();
  const once = (t: Token) => {
    if (seen.has(t.text)) fail("PARSE_SYNTAX", at(t), `duplicate ${t.text} block`);
    seen.add(t.text);
  };
  const dependsOn: Dependency[] = [];
  let visibility = "PARTIES";
  let scope: AllocationBody["scope"] | undefined;
  let bind: AllocationBody["bind"] | undefined;
  let tier1: Tier1Bucket[] = [];
  let rightsName = "";
  let split: SplitBucket[] = [];
  let rounding: AllocationBody["rounding"] | undefined;

  while (!isP(peek(), "}")) {
    const t = next();
    if (t.kind !== "ident") fail("PARSE_SYNTAX", at(t), `expected a block keyword, found ${describe(t)}`);
    switch (t.text) {
      case "uses": {
        expectW("facts");
        const factsId = str("facts id");
        expectP("@");
        const factsVersion = int("facts version");
        expectW("digest");
        const digest = str("digest");
        expectP(";");
        dependsOn.push({ ref: `vc:facts/${factsId}@${factsVersion}`, digest });
        break;
      }
      case "visibility":
        once(t);
        visibility = ident("visibility");
        expectP(";");
        break;
      case "scope": {
        once(t);
        expectP("{");
        expectW("pack");
        expectP(":");
        const pack = id("pack id");
        expectP(";");
        expectW("events");
        expectP(":");
        expectP("[");
        const events = list(() => ident("event type")) as EnumValue<"event_type">[];
        expectP("]");
        expectP(";");
        expectW("currency");
        expectP(":");
        const currency = ident("currency");
        expectP(";");
        expectP("}");
        scope = { pack, events, currency };
        break;
      }
      case "bind": {
        once(t);
        expectP("{");
        expectW("time");
        expectP(":");
        const time = ident("binding time") as EnumValue<"binding_time">;
        expectP(";");
        expectP("}");
        bind = { time };
        break;
      }
      case "tier1":
        once(t);
        tier1 = tier1Buckets();
        break;
      case "tier2":
        once(t);
        rightsName = ident("rights bucket name");
        expectP("{");
        expectW("split");
        split = splitBuckets();
        expectP("}");
        break;
      case "guard":
        once(t);
        guard();
        break;
      case "exceptions":
        once(t);
        exceptions();
        break;
      case "rounding": {
        once(t);
        expectP("{");
        expectW("method");
        expectP(":");
        const method = ident("rounding method") as EnumValue<"rounding_method">;
        expectP(";");
        expectW("tie");
        expectP(":");
        const tie = ident("tie rule") as "party_id_asc";
        expectP(";");
        expectP("}");
        rounding = { method, tie };
        break;
      }
      default:
        fail("PARSE_SYNTAX", at(t), `unknown block ${t.text}`);
    }
  }
  const close = expectP("}");
  const end = next();
  if (end.kind !== "eof") fail("PARSE_SYNTAX", at(end), `unexpected ${describe(end)} after the policy`);
  for (const b of REQUIRED_BLOCKS) if (!seen.has(b)) fail("PARSE_SYNTAX", at(close), `missing ${b} block`);

  return {
    mdrl: "1.0",
    module: "allocation",
    id: docId,
    version,
    depends_on: dependsOn,
    visibility_default: visibility as EnumValue<"visibility">,
    body: {
      scope: scope!,
      bind: bind!,
      tier1: { buckets: tier1, rights: rightsName },
      tier2: { split },
      rounding: rounding!,
    },
  };
}
