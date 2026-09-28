import { digestOf, isDigest } from "./digest.ts";
import { isEnumValue, type EnumValue } from "./enums.ts";
import { capture, diag, type Diagnostic } from "./errors.ts";
import { canonicalize } from "./jcs.ts";
import { parseRef } from "./ref.ts";

export const LANGUAGE_VERSION = "1.0";

export type Dependency = { ref: string; digest: string };
export type IrDocument<B = unknown> = {
  vcrl: string;
  module: EnumValue<"module">;
  id: string;
  version: string;
  depends_on: Dependency[];
  visibility_default: EnumValue<"visibility">;
  body: B;
};

/** 의존은 낮은 rank로만 향한다. 같은 rank·역방향은 CORE_DEP_DIRECTION (순환은 이 규칙으로 불가능해진다). */
export const MODULE_RANK: Readonly<Record<EnumValue<"module">, number>> = {
  core: 0, facts: 1, constraint: 2, grant: 2, approval: 3, allocation: 4,
};

const ID_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_RE = /^[1-9]\d*$/;
const ENVELOPE_KEYS = ["vcrl", "module", "id", "version", "depends_on", "visibility_default", "body"] as const;
const DEPENDENCY_KEYS = ["ref", "digest"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateEnvelope(doc: unknown): Diagnostic[] {
  if (!isObject(doc)) return [diag("CORE_TYPE_ERROR", "$", "document must be an object")];
  const out: Diagnostic[] = [...capture(() => canonicalize(doc))];
  if (doc.vcrl !== LANGUAGE_VERSION) out.push(diag("CORE_TYPE_ERROR", "$.vcrl", `expected "${LANGUAGE_VERSION}"`));
  if (!isEnumValue("module", doc.module)) out.push(diag("CORE_ENUM_UNKNOWN", "$.module", String(doc.module)));
  if (typeof doc.id !== "string" || !ID_RE.test(doc.id)) out.push(diag("CORE_TYPE_ERROR", "$.id"));
  if (typeof doc.version !== "string" || !VERSION_RE.test(doc.version)) out.push(diag("CORE_TYPE_ERROR", "$.version"));
  if (!isEnumValue("visibility", doc.visibility_default)) {
    out.push(diag("CORE_ENUM_UNKNOWN", "$.visibility_default", String(doc.visibility_default)));
  }
  if (!isObject(doc.body)) out.push(diag("CORE_TYPE_ERROR", "$.body", "body must be an object"));
  if (!Array.isArray(doc.depends_on)) {
    out.push(diag("CORE_TYPE_ERROR", "$.depends_on", "must be an array"));
  } else {
    doc.depends_on.forEach((dep: unknown, i: number) => {
      const p = `$.depends_on[${i}]`;
      if (!isObject(dep) || typeof dep.ref !== "string" || !isDigest(dep.digest)) {
        out.push(diag("CORE_TYPE_ERROR", p, "expected { ref, digest }"));
        return;
      }
      const ref = dep.ref;
      out.push(...capture(() => parseRef(ref, `${p}.ref`)));
      // Check for unknown keys in dependency object (only if well-formed)
      for (const k of Object.keys(dep)) {
        if (!(DEPENDENCY_KEYS as readonly string[]).includes(k)) {
          out.push(diag("CORE_TYPE_ERROR", `${p}.${k}`, "unknown key"));
        }
      }
    });
  }
  // Check for unknown keys at top level
  for (const k of Object.keys(doc)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) {
      out.push(diag("CORE_TYPE_ERROR", `$.${k}`, "unknown key"));
    }
  }
  return out;
}

export function refOf(doc: IrDocument): string {
  return `vc:${doc.module}/${doc.id}@${doc.version}`;
}

export function checkDependencies(docs: readonly IrDocument[]): Diagnostic[] {
  const byRef = new Map(docs.map((d) => [refOf(d), d]));
  const out: Diagnostic[] = [];
  for (const doc of docs) {
    doc.depends_on.forEach((dep, i) => {
      const p = `${refOf(doc)}.depends_on[${i}]`;
      const target = byRef.get(dep.ref);
      if (!target) {
        out.push(diag("CORE_UNKNOWN_REF", p, dep.ref));
        return;
      }
      if (MODULE_RANK[target.module] >= MODULE_RANK[doc.module]) {
        out.push(diag("CORE_DEP_DIRECTION", p, `${doc.module} -> ${target.module}`));
      }
      const actual = digestOf(target);
      if (actual !== dep.digest) out.push(diag("CORE_DIGEST_MISMATCH", p, `${dep.digest} != ${actual}`));
    });
  }
  return out;
}
