import { digestOf } from "../core/digest.ts";
import { attempt, describe, diag, underPath, type Diagnostic } from "../core/errors.ts";
import { isPlainObject } from "../core/jcs.ts";
import type { Instant } from "../core/time.ts";
import type { Usage } from "../facts/project.ts";
import { projectToIr } from "../facts/result.ts";
import { evaluate, type EvaluationInput } from "./evaluate.ts";
import { ALLOCATION_RESULT_FORMAT } from "./types.ts";

/** 결과 검증 입력: 투영은 받지 않고 facts·usage·시점으로 다시 계산한다. */
export type VerificationInput = Omit<EvaluationInput, "projection"> & { usage: Usage; asOf: Instant; knownAt: Instant };

/**
 * 제공된 안분 결과를 신뢰하지 않고 입력으로 투영과 평가를 다시 계산해 대조한다(스펙 12.50).
 * 일치하면 빈 배열을 돌려주고, 예외를 던지지 않는다.
 */
export function verifyAllocationResult(input: VerificationInput, given: unknown): Diagnostic[] {
  if (!isPlainObject(input)) return [diag("CORE_TYPE_ERROR", "$", "verification input must be an object")];
  if (!isPlainObject(given)) return [diag("CORE_TYPE_ERROR", "$.result", "must be an object")];
  if (given.format !== ALLOCATION_RESULT_FORMAT) {
    return [diag("CORE_TYPE_ERROR", "$.result.format", `unsupported result format: ${describe(given.format)}`)];
  }
  const { usage, asOf, knownAt, ...rest } = input;
  const projection = projectToIr(rest.facts, usage, asOf, knownAt);
  if (!projection.ok) return projection.errors;
  const recomputed = evaluate({ ...rest, projection: projection.value });
  if (!recomputed.ok) return recomputed.errors;

  const out: Diagnostic[] = [];
  const expected = recomputed.value.result_digest;
  if (given.projection_digest !== projection.value.digest) {
    out.push(diag("CORE_DIGEST_MISMATCH", "$.result.projection_digest", describe(given.projection_digest)));
  }
  if (given.result_digest !== expected) out.push(diag("CORE_DIGEST_MISMATCH", "$.result.result_digest", describe(given.result_digest)));
  const content = attempt(() => digestOf({ ...given, result_digest: undefined, trace: undefined }));
  if (!content.ok) out.push(...underPath("$.result", content.errors));
  else if (content.value !== expected) out.push(diag("CORE_DIGEST_MISMATCH", "$.result", "result content does not match the recomputed result"));
  // trace는 봉인 밖이므로 있으면 재계산한 trace와 직접 대조한다.
  if (Object.hasOwn(given, "trace")) {
    const trace = attempt(() => digestOf(given.trace));
    if (!trace.ok) out.push(...underPath("$.result.trace", trace.errors));
    else if (trace.value !== digestOf(recomputed.value.trace)) {
      out.push(diag("CORE_DIGEST_MISMATCH", "$.result.trace", "trace does not match the recomputed trace"));
    }
  }
  return out;
}
