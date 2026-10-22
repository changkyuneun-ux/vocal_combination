import { parseBps, percentToBps } from "../core/bps.ts";
import { attempt, err, fail, ok, type Result } from "../core/errors.ts";
import type { EnumValue } from "../core/enums.ts";
import { validateFactsStructure } from "../facts/validate.ts";
import type {
  Claim,
  FactsBody,
  FactsDocument,
  Mandate,
  Party,
  Recording,
  Stem,
  Voice,
  Work,
} from "../facts/types.ts";

import type { Interval } from "../core/time.ts";
import { at, tokenize, type Token } from "./lexer.ts";

/** 텍스트를 Facts IR로 파싱한다. 문법 오류는 PARSE_SYNTAX 진단으로 반환한다. */
export function parseFacts(src: string): Result<FactsDocument> {
  return attempt(() => parseFactsProgram(tokenize(src)));
}

/** 파싱 후 validateFactsStructure까지 통과해야 성공이다. */
export function compileFacts(src: string): Result<FactsDocument> {
  const parsed = parseFacts(src);
  if (!parsed.ok) return parsed;
  const errors = validateFactsStructure(parsed.value);
  return errors.length > 0 ? err(errors) : ok(parsed.value);
}

function parseFactsProgram(toks: readonly Token[]): FactsDocument {
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

  const ratio = (): string => {
    const t = next();
    if (t.kind === "number") {
      if (t.text.endsWith("bps")) {
        const v = parseBps(t.text.slice(0, -3));
        if (v === null) fail("PARSE_SYNTAX", at(t), `invalid bps literal "${t.text}"`);
        return String(v);
      }
      if (t.text.endsWith("%")) {
        const v = percentToBps(t.text.slice(0, -1));
        if (v === null) fail("PARSE_SYNTAX", at(t), `invalid percentage "${t.text}"`);
        return String(v);
      }
    }
    fail("PARSE_SYNTAX", at(t), `expected ratio (percentage or bps), found ${describe(t)}`);
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

  const parseIdsBlock = (): Record<string, string> | undefined => {
    const p = peek();
    if (!isW(p, "ids")) return undefined;
    next();
    expectP(":");
    expectP("{");
    const ids: Record<string, string> = {};
    while (!isP(peek(), "}")) {
      const k = ident("id scheme");
      expectP(":");
      const v = str("id value");
      ids[k] = v;
      if (isP(peek(), ",")) {
        next();
      } else {
        break;
      }
    }
    expectP("}");
    expectP(";");
    return ids;
  };

  expectW("facts");
  const docId = id("facts document id");
  expectW("version");
  const versionTok = next();
  if (versionTok.kind !== "number" || !/^[1-9]\d*$/.test(versionTok.text)) {
    fail("PARSE_SYNTAX", at(versionTok), `expected integer version, found ${describe(versionTok)}`);
  }
  const version = versionTok.text;
  expectP("{");

  const parties: Party[] = [];
  const works: Work[] = [];
  const recordings: Recording[] = [];
  const voices: Voice[] = [];
  const stems: Stem[] = [];
  const claims: Claim[] = [];
  const mandates: Mandate[] = [];

  while (!isP(peek(), "}")) {
    const itemKindTok = next();
    if (itemKindTok.kind !== "ident") {
      fail("PARSE_SYNTAX", at(itemKindTok), `expected facts item keyword, found ${describe(itemKindTok)}`);
    }
    const itemKind = itemKindTok.text;

    switch (itemKind) {
      case "party": {
        const itemId = id("party id");
        expectP("{");
        expectW("kind");
        expectP(":");
        const kind = ident("party kind") as EnumValue<"party_kind">;
        expectP(";");
        const ids = parseIdsBlock();
        let visibility: EnumValue<"visibility"> | undefined;
        if (isW(peek(), "visibility")) {
          next();
          expectP(":");
          visibility = ident("visibility") as EnumValue<"visibility">;
          expectP(";");
        }
        expectP("}");
        const party: Party = { id: itemId, kind };
        if (ids !== undefined) (party as any).ids = ids;
        if (visibility !== undefined) (party as any).visibility = visibility;
        parties.push(party);
        break;
      }
      case "work": {
        const itemId = id("work id");
        expectP("{");
        const ids = parseIdsBlock();
        expectP("}");
        const work: Work = { id: itemId };
        if (ids !== undefined) (work as any).ids = ids;
        works.push(work);
        break;
      }
      case "recording": {
        const itemId = id("recording id");
        expectP("{");
        expectW("of");
        expectP(":");
        const ofWork = id("work id");
        expectP(";");
        const ids = parseIdsBlock();
        expectP("}");
        const rec: Recording = { id: itemId, of: ofWork };
        if (ids !== undefined) (rec as any).ids = ids;
        recordings.push(rec);
        break;
      }
      case "voice": {
        const itemId = id("voice id");
        expectP("{");
        expectW("kind");
        expectP(":");
        const kind = ident("voice kind") as EnumValue<"voice_kind">;
        expectP(";");
        expectP("}");
        voices.push({ id: itemId, kind });
        break;
      }
      case "stem": {
        const itemId = id("stem id");
        expectP("{");
        expectW("of");
        expectP(":");
        const ofRec = id("recording id");
        expectP(";");
        expectW("slot");
        expectP(":");
        const slot = id("slot id");
        expectP(";");
        // 파트 번호(선택, 결정 SL4)
        let part: string | undefined;
        if (isW(peek(), "part")) {
          next();
          expectP(":");
          const pt = next();
          if (pt.kind !== "number" || !/^[1-9][0-9]*$/.test(pt.text)) fail("PARSE_SYNTAX", at(pt), `expected part number, found ${describe(pt)}`);
          part = pt.text;
          expectP(";");
        }
        expectW("rights_bearing");
        expectP(":");
        const rbTok = next();
        const rightsBearing = rbTok.kind === "ident" && rbTok.text === "true" ? true : rbTok.text === "false" ? false : null;
        if (rightsBearing === null) fail("PARSE_SYNTAX", at(rbTok), "expected boolean true or false");
        expectP(";");
        expectP("}");
        stems.push({ id: itemId, of: ofRec, slot, ...(part === undefined ? {} : { part }), rights_bearing: rightsBearing });
        break;
      }
      case "claim": {
        const claimId = id("claim id");
        expectP(":");
        const source = id("source asset id");
        const edge = ident("edge type") as any;
        const target = id("target party id");
        expectW("share");
        const share = ratio();
        let performerRole: EnumValue<"performer_role"> | undefined;
        if (isW(peek(), "role")) {
          next();
          performerRole = ident("performer role") as EnumValue<"performer_role">;
        }
        let roleDetail: string | undefined;
        if (isW(peek(), "detail")) {
          next();
          roleDetail = str("role detail");
        }
        expectW("status");
        const status = ident("claim status") as EnumValue<"claim_status">;
        expectW("valid");
        const valid = parseInterval();
        expectW("recorded");

        const recordedAt = id("recorded_at timestamp");
        let supersededAt: string | undefined;
        if (isW(peek(), "superseded")) {
          next();
          supersededAt = id("superseded_at timestamp");
        }
        let evidence: string | undefined;
        if (isW(peek(), "evidence")) {
          next();
          evidence = str("evidence text");
        }
        let visibility: EnumValue<"visibility"> | undefined;
        if (isW(peek(), "visibility")) {
          next();
          visibility = ident("visibility") as EnumValue<"visibility">;
        }
        expectP(";");

        const claim: Claim = {
          id: claimId,
          source,
          edge,
          target,
          share,
          status,
          valid,
          recorded_at: recordedAt,
        };
        if (performerRole !== undefined) (claim as any).performer_role = performerRole;
        if (roleDetail !== undefined) (claim as any).role_detail = roleDetail;
        if (supersededAt !== undefined) (claim as any).superseded_at = supersededAt;
        if (evidence !== undefined) (claim as any).evidence = evidence;
        if (visibility !== undefined) (claim as any).visibility = visibility;
        claims.push(claim);
        break;
      }
      case "mandate": {
        const mandateId = id("mandate id");
        expectP(":");
        const from = id("from party id");
        expectP("->");
        const to = id("to party id");
        expectW("right");
        const right = ident("mandate right") as any;
        expectW("share");
        const share = ratio();
        expectW("status");
        const status = ident("mandate status") as any;
        expectW("valid");
        const valid = parseInterval();
        expectW("recorded");
        const recordedAt = id("recorded_at timestamp");
        let supersededAt: string | undefined;
        if (isW(peek(), "superseded")) {
          next();
          supersededAt = id("superseded_at timestamp");
        }
        let mandateEvidence: string | undefined;
        if (isW(peek(), "evidence")) {
          next();
          mandateEvidence = str("evidence text");
        }
        let visibility: EnumValue<"visibility"> | undefined;
        if (isW(peek(), "visibility")) {
          next();
          visibility = ident("visibility") as EnumValue<"visibility">;
        }
        expectP(";");

        const mandate: Mandate = {
          id: mandateId,
          from,
          to,
          right,
          share,
          status,
          valid,
          recorded_at: recordedAt,
        };
        if (supersededAt !== undefined) (mandate as any).superseded_at = supersededAt;
        if (mandateEvidence !== undefined) (mandate as any).evidence = mandateEvidence;
        if (visibility !== undefined) (mandate as any).visibility = visibility;
        mandates.push(mandate);
        break;
      }
      default:
        fail("PARSE_SYNTAX", at(itemKindTok), `unknown facts item keyword "${itemKind}"`);
    }
  }

  expectP("}");

  const body: FactsBody = {
    parties: parties.sort((a, b) => (a.id < b.id ? -1 : 1)),
    works: works.sort((a, b) => (a.id < b.id ? -1 : 1)),
    recordings: recordings.sort((a, b) => (a.id < b.id ? -1 : 1)),
    voices: voices.sort((a, b) => (a.id < b.id ? -1 : 1)),
    stems: stems.sort((a, b) => (a.id < b.id ? -1 : 1)),
    claims: claims.sort((a, b) => (a.id < b.id ? -1 : 1)),
    mandates: mandates.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };

  return {
    mdrl: "1.0",
    module: "facts",
    id: docId,
    version,
    depends_on: [],
    visibility_default: "PARTIES",
    body,
  };
}
