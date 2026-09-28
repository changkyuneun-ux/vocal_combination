import { BPS_TOTAL, parseBps } from "../core/bps.ts";
import { validateEnvelope } from "../core/envelope.ts";
import { isEnumValue, type EnumName, type EnumValue } from "../core/enums.ts";
import { capture, diag, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { ROLE_RIGHT } from "../facts/mandate.ts";
import type { ClaimantRole } from "../facts/types.ts";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** 벡터 식 fn별 허용 키. `additionalProperties: false` 스키마와 일치시킨다. */
const VECTOR_KEYS: Readonly<Record<EnumValue<"vector_fn">, readonly string[]>> = {
  graph: ["fn", "role", "via_mandate"],
  contract: ["fn", "party"],
  member_pct: ["fn"],
  performance_pool: ["fn", "mode", "fixed", "usage", "featured_weight"],
  mix: ["fn", "parts"],
  cap: ["fn", "max", "of"],
  floor_guarantee: ["fn", "min", "of"],
};

type Obj = Record<string, unknown>;

export const PERFORMER_ROLES: readonly ClaimantRole[] = ["PERFORMER_FEATURED", "PERFORMER_NON_FEATURED"];

/** 버킷 역할 판정용 잎: graph는 그 역할, 실연 풀·멤버 비율은 실연 클래스, contract는 어느 역할이든 된다. */
type Leaf = { graph: ClaimantRole } | { performer: string };

/** 벡터 식의 잎을 모은다. 구조 오류는 vector()가 따로 보고하므로 여기서는 알 수 없는 노드를 건너뛴다. */
function leavesOf(v: unknown): Leaf[] {
  if (!isPlainObject(v)) return [];
  switch (v.fn) {
    case "graph":
      return isEnumValue("claimant_role", v.role) ? [{ graph: v.role }] : [];
    case "performance_pool":
    case "member_pct":
      return [{ performer: v.fn }];
    case "mix":
      return Array.isArray(v.parts) ? v.parts.flatMap((part: unknown) => (isPlainObject(part) ? leavesOf(part.of) : [])) : [];
    case "cap":
    case "floor_guarantee":
      return leavesOf(v.of);
    default:
      return [];
  }
}

/** 스펙 12.32: 실연 잎이 있으면 버킷은 실연 역할이고 graph 잎도 모두 실연 역할, 아니면 graph 잎은 버킷 역할과 같다. 어긋난 첫 잎을 돌려준다. */
function roleMismatch(role: ClaimantRole, leaves: readonly Leaf[]): string | undefined {
  const isPerformer = (l: Leaf) => "performer" in l || PERFORMER_ROLES.includes(l.graph);
  const name = (l: Leaf) => ("performer" in l ? l.performer : l.graph);
  const bad = leaves.some(isPerformer)
    ? leaves.find((l) => !PERFORMER_ROLES.includes(role) || !isPerformer(l))
    : leaves.find((l) => "graph" in l && l.graph !== role);
  return bad === undefined ? undefined : name(bad);
}

/** 안분 정책 IR의 정적 검증(스펙 5.4). 투영·스냅샷이 필요한 검사(커버리지 등)는 evaluate가 한다. */
export function validateAllocation(doc: unknown): Diagnostic[] {
  const env = validateEnvelope(doc);
  if (env.length > 0) return env;
  const d = doc as { module: unknown; body: Obj };
  if (d.module !== "allocation") return [diag("CORE_TYPE_ERROR", "$.module", "expected allocation")];
  const out: Diagnostic[] = [];

  const obj = (v: unknown, p: string): v is Obj => {
    if (isPlainObject(v)) return true;
    out.push(diag("CORE_TYPE_ERROR", p, "must be an object"));
    return false;
  };
  const enumCheck = (name: EnumName, v: unknown, p: string) => {
    if (!isEnumValue(name, v)) out.push(diag("CORE_ENUM_UNKNOWN", p, `${name}: ${String(v)}`));
  };
  /** bps를 검사하고 값을 돌려준다. 잘못되면 오류를 기록하고 undefined. */
  const bps = (v: unknown, p: string): number | undefined => {
    const e = capture(() => parseBps(v, p));
    out.push(...e);
    return e.length === 0 ? Number(v) : undefined;
  };
  const silentBps = (v: unknown): number | undefined => (capture(() => parseBps(v)).length === 0 ? Number(v) : undefined);

  const buckets = (arr: unknown, p: string, extra: readonly string[], each?: (bk: Obj, bp: string) => void): string[] => {
    if (!Array.isArray(arr) || arr.length === 0) {
      out.push(diag("CORE_TYPE_ERROR", p, "non-empty array required"));
      return [];
    }
    const names: string[] = [];
    let total = 0;
    let complete = true;
    arr.forEach((bk: unknown, i: number) => {
      const bp = `${p}[${i}]`;
      if (!obj(bk, bp)) {
        complete = false;
        return;
      }
      out.push(...rejectUnknownKeys(bk, ["name", "bps", ...extra], bp));
      if (typeof bk.name !== "string" || !NAME_RE.test(bk.name)) out.push(diag("CORE_TYPE_ERROR", `${bp}.name`, String(bk.name)));
      else if (names.includes(bk.name)) out.push(diag("ALLOC_DUPLICATE_NAME", `${bp}.name`, bk.name));
      else names.push(bk.name);
      const v = bps(bk.bps, `${bp}.bps`);
      if (v === undefined) complete = false;
      else total += v;
      each?.(bk, bp);
    });
    if (complete && total !== BPS_TOTAL) out.push(diag("ALLOC_SUM_MISMATCH", p, `${total}bps`));
    return names;
  };

  const pool = (v: Obj, p: string): void => {
    if (v.mode === undefined) {
      out.push(diag("ALLOC_MODE_REQUIRED", `${p}.mode`));
      return;
    }
    enumCheck("pool_mode", v.mode, `${p}.mode`);
    const need = (k: string) => {
      if (v[k] === undefined) out.push(diag("ALLOC_MODE_REQUIRED", `${p}.${k}`, `required for ${String(v.mode)}`));
      else bps(v[k], `${p}.${k}`);
    };
    const forbid = (k: string) => {
      if (v[k] !== undefined) out.push(diag("CORE_TYPE_ERROR", `${p}.${k}`, `not allowed for ${String(v.mode)}`));
    };
    switch (v.mode) {
      case "MEMBER_PCT":
      case "FIXED":
        forbid("fixed");
        forbid("usage");
        forbid("featured_weight");
        break;
      case "USAGE_WEIGHTED":
        need("featured_weight");
        forbid("fixed");
        forbid("usage");
        break;
      case "HYBRID": {
        need("featured_weight");
        need("fixed");
        need("usage");
        const f = silentBps(v.fixed);
        const u = silentBps(v.usage);
        if (f !== undefined && u !== undefined && f + u !== BPS_TOTAL) {
          out.push(diag("ALLOC_WEIGHT_MISMATCH", p, `fixed + usage = ${f + u}bps`));
        }
        break;
      }
    }
  };

  const vector = (v: unknown, p: string): void => {
    if (!obj(v, p)) return;
    if (!isEnumValue("vector_fn", v.fn)) {
      out.push(diag("CORE_ENUM_UNKNOWN", `${p}.fn`, String(v.fn)));
      return;
    }
    out.push(...rejectUnknownKeys(v, VECTOR_KEYS[v.fn], p));
    switch (v.fn) {
      case "graph":
        enumCheck("claimant_role", v.role, `${p}.role`);
        if (v.via_mandate !== undefined && typeof v.via_mandate !== "boolean") out.push(diag("CORE_TYPE_ERROR", `${p}.via_mandate`));
        else if (v.via_mandate === true && isEnumValue("claimant_role", v.role) && ROLE_RIGHT[v.role] === undefined) {
          out.push(diag("CORE_TYPE_ERROR", `${p}.via_mandate`, `${v.role} has no mandate right`));
        }
        break;
      case "contract":
        if (!isId(v.party)) out.push(diag("CORE_TYPE_ERROR", `${p}.party`, String(v.party)));
        break;
      case "member_pct":
        break;
      case "performance_pool":
        pool(v, p);
        break;
      case "mix": {
        if (!Array.isArray(v.parts) || v.parts.length === 0) {
          out.push(diag("CORE_TYPE_ERROR", `${p}.parts`, "non-empty array required"));
          break;
        }
        let total = 0;
        let complete = true;
        v.parts.forEach((part: unknown, i: number) => {
          const pp = `${p}.parts[${i}]`;
          if (!obj(part, pp)) {
            complete = false;
            return;
          }
          out.push(...rejectUnknownKeys(part, ["weight", "of"], pp));
          const w = bps(part.weight, `${pp}.weight`);
          if (w === undefined) complete = false;
          else total += w;
          vector(part.of, `${pp}.of`);
        });
        if (complete && total !== BPS_TOTAL) out.push(diag("ALLOC_WEIGHT_MISMATCH", `${p}.parts`, `${total}bps`));
        break;
      }
      case "cap":
        if (bps(v.max, `${p}.max`) === 0) out.push(diag("ALLOC_INFEASIBLE", `${p}.max`, "0bps"));
        vector(v.of, `${p}.of`);
        break;
      case "floor_guarantee":
        bps(v.min, `${p}.min`);
        vector(v.of, `${p}.of`);
        break;
    }
  };

  const b = d.body;
  out.push(...rejectUnknownKeys(b, ["scope", "bind", "tier1", "tier2", "rounding"], "$.body"));

  if (obj(b.scope, "$.body.scope")) {
    const s = b.scope;
    out.push(...rejectUnknownKeys(s, ["pack", "events", "currency"], "$.body.scope"));
    if (!isId(s.pack)) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.pack", String(s.pack)));
    if (!Array.isArray(s.events) || s.events.length === 0) {
      out.push(diag("CORE_TYPE_ERROR", "$.body.scope.events", "non-empty array required"));
    } else {
      s.events.forEach((e: unknown, i: number) => enumCheck("event_type", e, `$.body.scope.events[${i}]`));
      if (new Set(s.events).size !== s.events.length) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.events", "duplicate event type"));
    }
    if (typeof s.currency !== "string" || !CURRENCY_RE.test(s.currency)) out.push(diag("CORE_TYPE_ERROR", "$.body.scope.currency", String(s.currency)));
  }
  if (obj(b.bind, "$.body.bind")) {
    out.push(...rejectUnknownKeys(b.bind, ["time"], "$.body.bind"));
    enumCheck("binding_time", b.bind.time, "$.body.bind.time");
  }
  if (obj(b.tier1, "$.body.tier1")) {
    out.push(...rejectUnknownKeys(b.tier1, ["buckets", "rights"], "$.body.tier1"));
    const names = buckets(b.tier1.buckets, "$.body.tier1.buckets", []);
    if (typeof b.tier1.rights !== "string" || !names.includes(b.tier1.rights)) {
      out.push(diag("CORE_UNKNOWN_REF", "$.body.tier1.rights", String(b.tier1.rights)));
    }
  }
  if (obj(b.tier2, "$.body.tier2")) {
    out.push(...rejectUnknownKeys(b.tier2, ["split"], "$.body.tier2"));
    buckets(b.tier2.split, "$.body.tier2.split", ["role", "vector"], (bk, bp) => {
      enumCheck("claimant_role", bk.role, `${bp}.role`);
      vector(bk.vector, `${bp}.vector`);
      if (isEnumValue("claimant_role", bk.role)) {
        const leaf = roleMismatch(bk.role, leavesOf(bk.vector));
        if (leaf !== undefined) out.push(diag("CORE_TYPE_ERROR", `${bp}.role`, `role mismatch: ${bk.role} vs ${leaf}`));
      }
    });
  }
  if (obj(b.rounding, "$.body.rounding")) {
    out.push(...rejectUnknownKeys(b.rounding, ["method", "tie"], "$.body.rounding"));
    enumCheck("rounding_method", b.rounding.method, "$.body.rounding.method");
    if (b.rounding.tie !== "party_id_asc") out.push(diag("CORE_TYPE_ERROR", "$.body.rounding.tie", String(b.rounding.tie)));
  }
  return out;
}
