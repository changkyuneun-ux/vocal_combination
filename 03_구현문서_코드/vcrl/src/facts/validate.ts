import { parseBps } from "../core/bps.ts";
import { validateEnvelope } from "../core/envelope.ts";
import { isEnumValue, type EnumName } from "../core/enums.ts";
import { capture, diag, type Diagnostic } from "../core/errors.ts";
import { checkInterval, isInstant } from "../core/time.ts";
import { checkClaimSums, checkMandates } from "./invariants.ts";
import { CLAIM_EDGE_KINDS, type EntityType, type FactsBody, type FactsDocument } from "./types.ts";

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
  const allowed = ALLOWED_KEYS[kind] as readonly string[];
  return Object.keys(obj)
    .filter((k) => !allowed.includes(k))
    .map((k) => diag("CORE_TYPE_ERROR", `${path}.${k}`, "unknown key"));
}

export function validateFactsStructure(doc: unknown): Diagnostic[] {
  const env = validateEnvelope(doc);
  if (env.length > 0) return env;
  const d = doc as FactsDocument;
  if (d.module !== "facts") return [diag("CORE_TYPE_ERROR", "$.module", "expected facts")];
  const partial = d.body as Partial<FactsBody>;
  const shape = ARRAYS.filter((k) => !Array.isArray(partial[k])).map((k) => diag("CORE_TYPE_ERROR", `$.body.${k}`, "must be an array"));
  if (shape.length > 0) return shape;
  const body = d.body;
  const out: Diagnostic[] = [];

  const kinds = new Map<string, EntityType>();
  for (const key of ARRAYS) {
    (body[key] as readonly { id: string }[]).forEach((e, i) => {
      if (kinds.has(e.id)) out.push(diag("FACTS_DUPLICATE_ID", `$.body.${key}[${i}]`, e.id));
      else kinds.set(e.id, ENTITY_OF[key]);
    });
  }

  const ref = (id: string, expected: EntityType, path: string) => {
    const k = kinds.get(id);
    if (k === undefined) out.push(diag(expected === "party" ? "FACTS_UNKNOWN_PARTY" : "FACTS_UNKNOWN_ENTITY", path, id));
    else if (k !== expected) out.push(diag("FACTS_EDGE_KIND", path, `${id} is ${k}, expected ${expected}`));
  };
  const enumCheck = (name: EnumName, v: unknown, path: string) => {
    if (!isEnumValue(name, v)) out.push(diag("CORE_ENUM_UNKNOWN", path, `${name}: ${String(v)}`));
  };
  const record = (r: { recorded_at: unknown; superseded_at?: unknown; status: unknown; valid: unknown }, p: string) => {
    enumCheck("claim_status", r.status, `${p}.status`);
    if (typeof r.valid === "object" && r.valid !== null) out.push(...unknownKeys(r.valid, "interval", `${p}.valid`));
    out.push(...checkInterval(r.valid, `${p}.valid`));
    if (!isInstant(r.recorded_at)) out.push(diag("CORE_TYPE_ERROR", `${p}.recorded_at`, String(r.recorded_at)));
    else if (r.superseded_at !== undefined && (!isInstant(r.superseded_at) || r.superseded_at <= r.recorded_at)) {
      out.push(diag("CORE_TYPE_ERROR", `${p}.superseded_at`, "must be an instant after recorded_at"));
    }
  };

  body.parties.forEach((x, i) => {
    const p = `$.body.parties[${i}]`;
    out.push(...unknownKeys(x, "party", p));
    enumCheck("party_kind", x.kind, `${p}.kind`);
  });
  body.works.forEach((x, i) => out.push(...unknownKeys(x, "work", `$.body.works[${i}]`)));
  body.voices.forEach((x, i) => {
    const p = `$.body.voices[${i}]`;
    out.push(...unknownKeys(x, "voice", p));
    enumCheck("voice_kind", x.kind, `${p}.kind`);
  });
  body.recordings.forEach((x, i) => {
    const p = `$.body.recordings[${i}]`;
    out.push(...unknownKeys(x, "recording", p));
    ref(x.of, "work", `${p}.of`);
  });
  body.stems.forEach((x, i) => {
    const p = `$.body.stems[${i}]`;
    out.push(...unknownKeys(x, "stem", p));
    ref(x.of, "recording", `${p}.of`);
    if (typeof x.rights_bearing !== "boolean") out.push(diag("CORE_TYPE_ERROR", `${p}.rights_bearing`));
  });

  body.claims.forEach((c, i) => {
    const p = `$.body.claims[${i}]`;
    out.push(...unknownKeys(c, "claim", p));
    const kindsFor = Object.hasOwn(CLAIM_EDGE_KINDS, c.edge) ? CLAIM_EDGE_KINDS[c.edge] : undefined;
    if (kindsFor === undefined) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.edge`, String(c.edge)));
    } else {
      ref(c.source, kindsFor[0], `${p}.source`);
      ref(c.target, kindsFor[1], `${p}.target`);
    }
    out.push(...capture(() => parseBps(c.share, `${p}.share`)));
    record(c, p);
    if (c.edge === "PERFORMED_BY") enumCheck("performer_role", c.performer_role, `${p}.performer_role`);
    else if (c.performer_role !== undefined) out.push(diag("CORE_TYPE_ERROR", `${p}.performer_role`, "only allowed on PERFORMED_BY"));
  });

  body.mandates.forEach((m, i) => {
    const p = `$.body.mandates[${i}]`;
    out.push(...unknownKeys(m, "mandate", p));
    ref(m.from, "party", `${p}.from`);
    ref(m.to, "party", `${p}.to`);
    enumCheck("mandate_right", m.right, `${p}.right`);
    out.push(...capture(() => parseBps(m.share, `${p}.share`)));
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
