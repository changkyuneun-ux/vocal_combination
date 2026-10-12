import type { Interval } from "./time.ts";
import { checkInterval, isInstant } from "./time.ts";
import type { Diagnostic } from "./errors.ts";

import { diag, fail } from "./errors.ts";
import { rejectUnknownKeys } from "./shape.ts";



/**
 * 마스터 규격 5.4절 및 6.4절에 정의된 5차원 이용 범위(Scope).
 * S = (A, R, M, P, U)
 * - actions: 허용 행위 집합 (A)
 * - territories: 허용 지역 집합 (R)
 * - media: 허용 매체 집합 (M)
 * - period: 허용 기간 반열린 구간 [from, to) (P)
 * - audience: 허용 대상 청중 집합 (U)
 */
export interface Scope {
  readonly actions: readonly string[];
  readonly territories: readonly string[];
  readonly media: readonly string[];
  readonly period: Interval;
  readonly audience: readonly string[];
}

const SCOPE_KNOWN_KEYS = ["actions", "territories", "media", "period", "audience"] as const;

export function isScope(v: unknown): v is Scope {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.actions) || !s.actions.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(s.territories) || !s.territories.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(s.media) || !s.media.every((x) => typeof x === "string")) return false;
  if (!Array.isArray(s.audience) || !s.audience.every((x) => typeof x === "string")) return false;
  if (typeof s.period !== "object" || s.period === null || Array.isArray(s.period)) return false;
  const p = s.period as Record<string, unknown>;
  if (!isInstant(p.from)) return false;
  if (p.to !== undefined && !isInstant(p.to)) return false;
  return true;
}

export function validateScope(v: unknown, path = "$"): Diagnostic[] {
  const errors: Diagnostic[] = [];
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return [diag("CORE_TYPE_ERROR", path, "Scope must be a non-null object")];
  }
  const s = v as Record<string, unknown>;
  errors.push(...rejectUnknownKeys(s, SCOPE_KNOWN_KEYS, path));

  const checkStringArray = (field: string, values: unknown) => {
    if (!Array.isArray(values)) {
      errors.push(diag("CORE_TYPE_ERROR", `${path}.${field}`, "Must be an array of strings"));
    } else {
      for (let i = 0; i < values.length; i++) {
        if (typeof values[i] !== "string") {
          errors.push(diag("CORE_TYPE_ERROR", `${path}.${field}[${i}]`, "Must be a string"));
        }
      }
    }
  };

  checkStringArray("actions", s.actions);
  checkStringArray("territories", s.territories);
  checkStringArray("media", s.media);
  checkStringArray("audience", s.audience);

  if (typeof s.period !== "object" || s.period === null || Array.isArray(s.period)) {
    errors.push(diag("CORE_TYPE_ERROR", `${path}.period`, "Period must be an Interval object"));
  } else {
    const p = s.period as Record<string, unknown>;
    errors.push(...rejectUnknownKeys(p, ["from", "to"], `${path}.period`));
    if (!isInstant(p.from)) {
      errors.push(diag("CORE_TYPE_ERROR", `${path}.period.from`, "Must be a canonical UTC instant"));
    }

    if (p.to !== undefined && !isInstant(p.to)) {
      errors.push(diag("CORE_TYPE_ERROR", `${path}.period.to`, "Must be a canonical UTC instant"));
    }
    if (isInstant(p.from) && (p.to === undefined || isInstant(p.to))) {
      errors.push(...checkInterval(p, `${path}.period`));
    }
  }


  return errors;
}

/**
 * 두 기간 반열린 구간 [from, to)의 교집합을 구한다.
 * 교집합이 없으면 null 반환.
 */
export function intersectInterval(a: Interval, b: Interval): Interval | null {
  const from = a.from > b.from ? a.from : b.from;
  let to: string | undefined;

  if (a.to === undefined) {
    to = b.to;
  } else if (b.to === undefined) {
    to = a.to;
  } else {
    to = a.to < b.to ? a.to : b.to;
  }

  if (to !== undefined && from >= to) {
    return null; // 빈 구간
  }
  return { from, to };
}

/**
 * aInterval ⊆ bInterval 검사.
 */
export function isSubInterval(sub: Interval, sup: Interval): boolean {
  if (sub.from < sup.from) return false;
  if (sup.to === undefined) return true;
  if (sub.to === undefined) return false; // sup는 기한이 있는데 sub는 무기한이면 포함 안 됨
  return sub.to <= sup.to;
}

/**
 * 두 배열의 교집합을 정렬된 고유 배열로 반환.
 */
function intersectSet(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const res = a.filter((x) => setB.has(x));
  return Array.from(new Set(res)).sort();
}

/**
 * a ⊆ b (a의 모든 원소가 b에 포함되는지) 검사.
 */
function isSubSet(sub: readonly string[], sup: readonly string[]): boolean {
  const setSup = new Set(sup);
  return sub.every((x) => setSup.has(x));
}

/**
 * 두 Scope의 교집합(S ⊓ T, meet)을 계산한다.
 * 어느 한 차원의 공통 부분이 비면 null(빈 범위)을 반환한다 (규격 5.4.1절).
 */
export function intersectScope(a: Scope, b: Scope): Scope | null {
  const actions = intersectSet(a.actions, b.actions);
  if (actions.length === 0) return null;

  const territories = intersectSet(a.territories, b.territories);
  if (territories.length === 0) return null;

  const media = intersectSet(a.media, b.media);
  if (media.length === 0) return null;

  const audience = intersectSet(a.audience, b.audience);
  if (audience.length === 0) return null;

  const period = intersectInterval(a.period, b.period);
  if (period === null) return null;

  return {
    actions,
    territories,
    media,
    period,
    audience,
  };
}

/**
 * subScope ⊑ superScope (subScope가 superScope에 온전히 포함되는지) 검사.
 */
export function isSubScope(sub: Scope, superScope: Scope): boolean {
  if (!isSubSet(sub.actions, superScope.actions)) return false;
  if (!isSubSet(sub.territories, superScope.territories)) return false;
  if (!isSubSet(sub.media, superScope.media)) return false;
  if (!isSubSet(sub.audience, superScope.audience)) return false;
  if (!isSubInterval(sub.period, superScope.period)) return false;
  return true;
}

/**
 * 하위 문서 또는 파생 조항의 범위가 상위 범위를 벗어나는지 검증.
 * 벗어날 경우 GRANT_SCOPE_WIDENING 예외 발생 ([N-5.4.2]).
 */
export function assertScopeNarrowing(parentScope: Scope, childScope: Scope, path = "$"): void {
  if (!isSubScope(childScope, parentScope)) {
    fail("GRANT_SCOPE_WIDENING", path, "Child scope must be a subset of parent scope (narrowing only)");
  }
}
