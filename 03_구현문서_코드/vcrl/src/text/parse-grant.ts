import { attempt, err, fail, ok, type Result } from "../core/errors.ts";
import type { GrantBody, GrantDoc, GrantRule } from "../grant/types.ts";
import { validateGrantBody } from "../grant/validate.ts";
import type { Scope } from "../core/scope.ts";
import type { Interval } from "../core/time.ts";
import { at, tokenize, type Token } from "./lexer.ts";

/** 텍스트를 Grant IR로 파싱한다. 문법 오류는 PARSE_SYNTAX 진단으로 반환한다. */
export function parseGrant(src: string): Result<GrantDoc> {
  return attempt(() => parseGrantProgram(tokenize(src)));
}

/** 파싱 후 validateGrantBody까지 통과해야 성공이다. */
export function compileGrant(src: string): Result<GrantDoc> {
  const parsed = parseGrant(src);
  if (!parsed.ok) return parsed;
  const errors = validateGrantBody(parsed.value.body);
  return errors.length > 0 ? err(errors) : ok(parsed.value);
}

function parseGrantProgram(toks: readonly Token[]): GrantDoc {
  let k = 0;
  const peek = () => toks[k]!;
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

  const parseInterval = (): Interval => {
    expectP("[");
    const from = id("interval start instant");
    expectP(",");
    let to: string | undefined;
    const p = peek();
    if (!isP(p, ")")) {
      to = id("interval end instant");
    }
    expectP(")");
    return to ? { from, to } : { from };
  };

  const parseStringList = (): string[] => {
    expectP("[");
    const list: string[] = [];
    while (!isP(peek(), "]")) {
      list.push(ident("list item"));
      if (isP(peek(), ",")) {
        next();
      } else {
        break;
      }
    }
    expectP("]");
    return list;
  };

  const parseScope = (): Scope => {
    expectP("{");
    let actions: string[] | undefined;
    let territories: string[] | undefined;
    let media: string[] | undefined;
    let period: Interval | undefined;
    let audience: string[] | undefined;

    while (!isP(peek(), "}")) {
      const field = ident("scope field name");
      expectP(":");
      switch (field) {
        case "actions":
          actions = parseStringList();
          break;
        case "territories":
          territories = parseStringList();
          break;
        case "media":
          media = parseStringList();
          break;
        case "period":
          period = parseInterval();
          break;
        case "audience":
          audience = parseStringList();
          break;
        default:
          fail("PARSE_SYNTAX", at(peek()), `unknown scope field "${field}"`);
      }
      expectP(";");
    }
    expectP("}");

    if (!actions || !territories || !media || !period || !audience) {
      fail("PARSE_SYNTAX", at(peek()), "Scope must specify all 5 dimensions (actions, territories, media, period, audience)");
    }

    return {
      actions,
      territories,
      media,
      period,
      audience,
    };
  };

  expectW("grant");
  const docId = id("grant document id");
  expectW("version");
  const versionTok = next();
  if (versionTok.kind !== "number" || !/^[1-9]\d*$/.test(versionTok.text)) {
    fail("PARSE_SYNTAX", at(versionTok), `expected integer version, found ${describe(versionTok)}`);
  }
  const version = versionTok.text;
  expectP("{");

  const grants: GrantRule[] = [];

  while (!isP(peek(), "}")) {
    expectW("rule");
    const ruleId = id("grant rule id");
    expectP("{");

    let grantor: string | undefined;
    let grantee: string | undefined;
    let asset: string | undefined;
    let rightType: string | undefined;
    let scope: Scope | undefined;
    let obligations: string[] | undefined;
    let status: any;
    let valid: Interval | undefined;
    let recordedAt: string | undefined;

    while (!isP(peek(), "}")) {
      const field = ident("rule field name");
      expectP(":");
      switch (field) {
        case "grantor":
          grantor = id("grantor party id");
          break;
        case "grantee":
          grantee = id("grantee party id");
          break;
        case "asset":
          asset = id("asset id");
          break;
        case "right":
          rightType = ident("right type");
          break;
        case "scope":
          scope = parseScope();
          break;
        case "obligations":
          obligations = parseStringList();
          break;
        case "status":
          status = ident("grant status");
          break;
        case "valid":
          valid = parseInterval();
          break;
        case "recorded":
          recordedAt = id("recorded timestamp");
          break;
        default:
          fail("PARSE_SYNTAX", at(peek()), `unknown grant rule field "${field}"`);
      }
      expectP(";");
    }
    expectP("}");

    if (!grantor || !asset || !rightType || !scope || !status || !valid || !recordedAt) {
      fail("PARSE_SYNTAX", at(peek()), `Grant rule ${ruleId} is missing required fields`);
    }

    const rule: GrantRule = {
      id: ruleId,
      grantor,
      asset,
      right_type: rightType,
      scope,
      status,
      valid,
      recorded_at: recordedAt,
    };
    if (grantee !== undefined) (rule as any).grantee = grantee;
    if (obligations !== undefined) (rule as any).obligations = obligations;
    grants.push(rule);
  }

  expectP("}");

  const body: GrantBody = {
    grants: grants.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };

  return {
    vcrl: "1.0",
    module: "grant",
    id: docId,
    version,
    depends_on: [],
    visibility_default: "PARTIES",
    body,
  };
}
