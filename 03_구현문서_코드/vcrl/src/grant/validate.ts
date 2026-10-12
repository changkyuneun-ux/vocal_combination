import type { Diagnostic } from "../core/errors.ts";
import { diag } from "../core/errors.ts";
import { isId, rejectUnknownKeys } from "../core/shape.ts";
import { validateScope } from "../core/scope.ts";
import { isInstant } from "../core/time.ts";
import type { GrantBody, GrantDoc, GrantRule, Requirement } from "./types.ts";



const GRANT_RULE_KNOWN_KEYS = [
  "id",
  "grantor",
  "grantee",
  "asset",
  "right_type",
  "scope",
  "obligations",
  "status",
  "valid",
  "recorded_at",
] as const;

const VALID_STATUSES = new Set(["VERIFIED", "ASSERTED", "DISPUTED", "REVOKED"]);

export function validateGrantRule(rule: unknown, path: string): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
    return [diag("CORE_TYPE_ERROR", path, "Grant rule must be an object")];
  }
  const r = rule as Record<string, unknown>;
  errors.push(...rejectUnknownKeys(r, GRANT_RULE_KNOWN_KEYS, path));

  if (typeof r.id !== "string" || !isId(r.id)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.id`, "id must match ^[A-Za-z0-9._-]+$"));
  }
  if (typeof r.grantor !== "string" || !isId(r.grantor)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.grantor`, "grantor must match ^[A-Za-z0-9._-]+$"));
  }
  if (r.grantee !== undefined && (typeof r.grantee !== "string" || !isId(r.grantee))) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.grantee`, "grantee must match ^[A-Za-z0-9._-]+$"));
  }
  if (typeof r.asset !== "string" || !isId(r.asset)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.asset`, "asset must match ^[A-Za-z0-9._-]+$"));
  }
  if (typeof r.right_type !== "string" || r.right_type.length === 0) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.right_type`, "right_type must be a non-empty string"));
  }
  if (typeof r.status !== "string" || !VALID_STATUSES.has(r.status)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.status`, "status must be VERIFIED, ASSERTED, DISPUTED, or REVOKED"));
  }
  if (typeof r.recorded_at !== "string" || !isInstant(r.recorded_at)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.recorded_at`, "recorded_at must be an ISO 8601 UTC instant"));
  }

  errors.push(...validateScope(r.scope, `${path}.scope`));

  if (r.obligations !== undefined) {
    if (!Array.isArray(r.obligations)) {
      errors.push(diag("CORE_TYPE_ERROR", `${path}.obligations`, "obligations must be an array of strings"));
    } else {
      for (let i = 0; i < r.obligations.length; i++) {
        if (typeof r.obligations[i] !== "string") {
          errors.push(diag("CORE_TYPE_ERROR", `${path}.obligations[${i}]`, "obligation must be a string"));
        }
      }
    }
  }

  return errors;
}

export function validateGrantBody(body: unknown, path = "$.body"): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [diag("CORE_TYPE_ERROR", path, "Grant body must be an object")];
  }
  const b = body as Record<string, unknown>;
  errors.push(...rejectUnknownKeys(b, ["grants"], path));

  if (!Array.isArray(b.grants)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.grants`, "grants must be an array"));
    return errors;
  }

  const ids = new Set<string>();
  for (let i = 0; i < b.grants.length; i++) {
    const item = b.grants[i] as GrantRule;
    errors.push(...validateGrantRule(item, `${path}.grants[${i}]`));
    if (typeof item === "object" && item !== null && typeof item.id === "string") {
      if (ids.has(item.id)) {
        errors.push(diag("CORE_TYPE_ERROR", `${path}.grants[${i}].id`, `Duplicate grant rule id: ${item.id}`));
      }
      ids.add(item.id);
    }
  }

  return errors;
}

export function validateRequirement(req: unknown, path: string): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return [diag("CORE_TYPE_ERROR", path, "Requirement must be an object")];
  }
  const r = req as Record<string, unknown>;
  errors.push(...rejectUnknownKeys(r, ["id", "asset", "right_type", "scope"], path));

  if (r.id !== undefined && (typeof r.id !== "string" || !isId(r.id))) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.id`, "Requirement id must match ^[A-Za-z0-9._-]+$"));
  }
  if (typeof r.asset !== "string" || !isId(r.asset)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.asset`, "asset must match ^[A-Za-z0-9._-]+$"));
  }
  if (typeof r.right_type !== "string" || r.right_type.length === 0) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.right_type`, "right_type must be a non-empty string"));
  }

  errors.push(...validateScope(r.scope, `${path}.scope`));
  return errors;
}

