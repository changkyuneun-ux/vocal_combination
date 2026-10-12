import { parseBps } from "../core/bps.ts";
import { isCommitment } from "../core/commit.ts";
import { validateEnvelope } from "../core/envelope.ts";
import { isEnumValue, type EnumName } from "../core/enums.ts";
import { capture, describe, diag, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { checkInterval, isInstant } from "../core/time.ts";
import { checkClaimSums, checkMandates } from "./invariants.ts";
import { CLAIM_EDGE_KINDS, type ClaimEdge, type EntityType, type FactsDocument } from "./types.ts";

const ARRAYS = ["parties", "works", "recordings", "voices", "stems", "claims", "mandates"] as const;
const ENTITY_OF: Record<(typeof ARRAYS)[number], EntityType> = {
  parties: "party", works: "work", recordings: "recording", voices: "voice",
  stems: "stem", claims: "claim", mandates: "mandate",
};

/** 각 형태가 허용하는 키. `additionalProperties: false` 스키마와 일치시킨다. */
const ALLOWED_KEYS = {
  body: ARRAYS,
  party: ["id", "kind", "ids", "visibility"],
  work: ["id", "ids"],
  recording: ["id", "of", "ids"],
  voice: ["id", "kind"],
  stem: ["id", "of", "slot", "rights_bearing"],
  claim: [
    "id", "source", "edge", "target", "share", "performer_role", "role_detail",
    "status", "valid", "recorded_at", "superseded_at", "evidence", "visibility",
  ],
  mandate: [
    "id", "from", "to", "right", "share", "status", "valid",
    "recorded_at", "superseded_at", "visibility",
  ],
  interval: ["from", "to"],
} as const satisfies Record<string, readonly string[]>;

/** JSON Schema의 `additionalProperties: false`와 동일하게, 허용되지 않은 키를 CORE_TYPE_ERROR로 보고한다. */
function unknownKeys(obj: object, kind: keyof typeof ALLOWED_KEYS, path: string): Diagnostic[] {
  return rejectUnknownKeys(obj, ALLOWED_KEYS[kind], path);
}

type Entity = Record<string, unknown>;

/**
 * facts 구조 검증. 7개 엔티티 배열은 id 오름차순(코드 유닛 비교)인 정규형이어야 한다.
 * 같은 id가 연속하면 FACTS_DUPLICATE_ID만 보고하고 정렬 오류로 보지 않는다.
 */
export function validateFactsStructure(doc: unknown): Diagnostic[] {
  return validateStructure(doc, "raw");
}

/**
 * 공개본(publicFacts 결과) 검증: 구조 규칙은 같고, claim.share·claim.evidence·mandate.share·party.ids는
 * 원문 또는 커밋먼트를 허용한다. share 합·위임 불변식은 커밋된 값으로 검사할 수 없으므로 돌리지 않는다.
 */
export function validatePublicFacts(doc: unknown): Diagnostic[] {
  return validateStructure(doc, "public");
}

function validateStructure(doc: unknown, mode: "raw" | "public"): Diagnostic[] {
  const env = validateEnvelope(doc);
  if (env.length > 0) return env;
  const d = doc as { module: unknown; body: Record<string, unknown> };
  if (d.module !== "facts") return [diag("CORE_TYPE_ERROR", "$.module", "expected facts")];
  const shape = ARRAYS.filter((k) => !Array.isArray(d.body[k])).map((k) => diag("CORE_TYPE_ERROR", `$.body.${k}`, "must be an array"));
  if (shape.length > 0) return shape;
  const elements = ARRAYS.flatMap((k) =>
    (d.body[k] as unknown[]).flatMap((e, i) => (isPlainObject(e) ? [] : [diag("CORE_TYPE_ERROR", `$.body.${k}[${i}]`, "must be an object")])));
  if (elements.length > 0) return elements;
  const body = d.body as Record<(typeof ARRAYS)[number], Entity[]>;
  const out: Diagnostic[] = [];

  const kinds = new Map<string, EntityType>();
  for (const key of ARRAYS) {
    let sorted = true;
    body[key].forEach((e, i) => {
      const p = `$.body.${key}[${i}]`;
      if (!isId(e.id)) {
        out.push(diag("CORE_TYPE_ERROR", `${p}.id`, `not an id: ${describe(e.id)}`));
        return;
      }
      const prev = body[key][i - 1]?.id;
      if (isId(prev) && prev > e.id) sorted = false;
      if (kinds.has(e.id)) out.push(diag("FACTS_DUPLICATE_ID", p, e.id));
      else kinds.set(e.id, ENTITY_OF[key]);
    });
    if (!sorted) out.push(diag("CORE_TYPE_ERROR", `$.body.${key}`, "not sorted by id"));
  }

  /** 공개본에서 커밋먼트로 치환될 수 있는 필드가 커밋먼트인가. PUBLIC 항목은 원문이어야 한다. */
  const committed = (v: unknown, visibility?: unknown): boolean => mode === "public" && visibility !== "PUBLIC" && isCommitment(v);
  const present = (v: unknown, path: string): boolean => {
    if (v === undefined) out.push(diag("CORE_TYPE_ERROR", path, "required"));
    return v !== undefined;
  };
  const ref = (v: unknown, expected: EntityType | undefined, path: string) => {
    if (!present(v, path)) return;
    if (!isId(v)) {
      out.push(diag("CORE_TYPE_ERROR", path, `not an id: ${describe(v)}`));
      return;
    }
    if (expected === undefined) return;
    const k = kinds.get(v);
    if (k === undefined) out.push(diag(expected === "party" ? "FACTS_UNKNOWN_PARTY" : "FACTS_UNKNOWN_ENTITY", path, v));
    else if (k !== expected) out.push(diag("FACTS_EDGE_KIND", path, `${v} is ${k}, expected ${expected}`));
  };
  /** 없는 값: optional이면 통과, 아니면 required. 있는 값만 형식을 본다. */
  const absent = (v: unknown, path: string, optional: boolean): boolean => {
    if (v === undefined && !optional) present(v, path);
    return v === undefined;
  };
  const enumField = (name: EnumName, v: unknown, path: string, optional = false) => {
    if (!absent(v, path, optional) && !isEnumValue(name, v)) out.push(diag("CORE_ENUM_UNKNOWN", path, `${name}: ${describe(v)}`));
  };
  const text = (v: unknown, path: string, optional = false) => {
    if (!absent(v, path, optional) && typeof v !== "string") out.push(diag("CORE_TYPE_ERROR", path, "must be a string"));
  };
  const idsField = (v: unknown, path: string, sealable = false) => {
    if (v === undefined || (sealable && committed(v))) return;
    if (!isPlainObject(v) || !Object.values(v).every((x) => typeof x === "string")) {
      out.push(diag("CORE_TYPE_ERROR", path, "must be an object of strings"));
    } else if (Object.hasOwn(v, "commit")) {
      out.push(diag("CORE_TYPE_ERROR", `${path}.commit`, "reserved key (commitment marker)"));
    }
  };
  const bps = (v: unknown, path: string, visibility?: unknown) => {
    if (!committed(v, visibility)) out.push(...capture(() => parseBps(v, path)));
  };
  const record = (r: Entity, p: string) => {
    enumField("claim_status", r.status, `${p}.status`);
    if (isPlainObject(r.valid)) out.push(...unknownKeys(r.valid, "interval", `${p}.valid`));
    out.push(...checkInterval(r.valid, `${p}.valid`));
    if (!isInstant(r.recorded_at)) out.push(diag("CORE_TYPE_ERROR", `${p}.recorded_at`, describe(r.recorded_at)));
    else if (r.superseded_at !== undefined && (!isInstant(r.superseded_at) || r.superseded_at <= r.recorded_at)) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.superseded_at`, "must be an instant after recorded_at"));
    }
    enumField("visibility", r.visibility, `${p}.visibility`, true);
  };

  body.parties.forEach((x, i) => {
    const p = `$.body.parties[${i}]`;
    out.push(...unknownKeys(x, "party", p));
    enumField("party_kind", x.kind, `${p}.kind`);
    idsField(x.ids, `${p}.ids`, x.visibility === "PRIVATE");
    enumField("visibility", x.visibility, `${p}.visibility`, true);
  });
  body.works.forEach((x, i) => {
    const p = `$.body.works[${i}]`;
    out.push(...unknownKeys(x, "work", p));
    idsField(x.ids, `${p}.ids`);
  });
  body.voices.forEach((x, i) => {
    const p = `$.body.voices[${i}]`;
    out.push(...unknownKeys(x, "voice", p));
    enumField("voice_kind", x.kind, `${p}.kind`);
  });
  body.recordings.forEach((x, i) => {
    const p = `$.body.recordings[${i}]`;
    out.push(...unknownKeys(x, "recording", p));
    ref(x.of, "work", `${p}.of`);
    idsField(x.ids, `${p}.ids`);
  });
  body.stems.forEach((x, i) => {
    const p = `$.body.stems[${i}]`;
    out.push(...unknownKeys(x, "stem", p));
    ref(x.of, "recording", `${p}.of`);
    text(x.slot, `${p}.slot`);
    if (typeof x.rights_bearing !== "boolean") out.push(diag("CORE_TYPE_ERROR", `${p}.rights_bearing`));
  });

  body.claims.forEach((c, i) => {
    const p = `$.body.claims[${i}]`;
    out.push(...unknownKeys(c, "claim", p));
    const kindsFor = typeof c.edge === "string" && Object.hasOwn(CLAIM_EDGE_KINDS, c.edge)
      ? CLAIM_EDGE_KINDS[c.edge as ClaimEdge]
      : undefined;
    if (kindsFor === undefined && present(c.edge, `${p}.edge`)) out.push(diag("CORE_ENUM_UNKNOWN", `${p}.edge`, describe(c.edge)));
    ref(c.source, kindsFor?.[0], `${p}.source`);
    ref(c.target, kindsFor?.[1], `${p}.target`);
    bps(c.share, `${p}.share`, c.visibility);
    record(c, p);
    if (c.edge === "PERFORMED_BY") {
      if (!isEnumValue("performer_role", c.performer_role)) {
        out.push(diag("CORE_ENUM_UNKNOWN", `${p}.performer_role`, `performer_role: ${describe(c.performer_role)}`));
      }
    } else if (c.performer_role !== undefined) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.performer_role`, "only allowed on PERFORMED_BY"));
    }
    text(c.role_detail, `${p}.role_detail`, true);
    if (!committed(c.evidence, c.visibility)) text(c.evidence, `${p}.evidence`, true);
  });

  body.mandates.forEach((m, i) => {
    const p = `$.body.mandates[${i}]`;
    out.push(...unknownKeys(m, "mandate", p));
    ref(m.from, "party", `${p}.from`);
    ref(m.to, "party", `${p}.to`);
    enumField("mandate_right", m.right, `${p}.right`);
    bps(m.share, `${p}.share`, m.visibility);
    record(m, p);
  });

  out.push(...unknownKeys(body, "body", "$.body"));

  return out;
}

/** 구조 검증 → (통과 시) share 합 불변식 → 위임 합·순환·깊이. */
export function validateFacts(doc: unknown): Diagnostic[] {
  const structural = validateFactsStructure(doc);
  if (structural.length > 0) return structural;
  const body = (doc as FactsDocument).body;
  return [...checkClaimSums(body), ...checkMandates(body)];
}
