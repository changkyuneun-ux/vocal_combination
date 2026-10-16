import { contains } from "../core/time.ts";
import { isSubScope, intersectScope } from "../core/scope.ts";
import type { ErrorCode } from "../core/errors.ts";
import type { EnumValue } from "../core/enums.ts";
import { digestOf } from "../core/digest.ts";

import type {
  GrantEvaluationInput,
  GrantDecisionOutput,
  GrantTrace,
  GrantRule,
  Requirement,
} from "./types.ts";


/**
 * 마스터 규격 6.4절 및 5.4절/5.9절에 따른 이용허락 판정 엔진.
 * 불확실 시 거부 원칙 (Fail-Closed)과 범위 대수 (Scope Narrowing)를 적용한다.
 */
export function evaluateGrant(input: GrantEvaluationInput): GrantDecisionOutput {
  const { requirements, grants, as_of, known_at } = input;
  const traces: GrantTrace[] = [];
  const allReasonCodes: ErrorCode[] = [];
  const aggregatedObligations = new Set<string>();

  let hasDeny = false;
  let hasReview = false;

  for (const req of requirements) {
    const trace = evaluateRequirement(req, grants, as_of, known_at);
    traces.push(trace);


    for (const code of trace.reason_codes) {
      if (!allReasonCodes.includes(code)) {
        allReasonCodes.push(code);
      }
    }

    if (trace.decision === "DENY") {
      hasDeny = true;
    } else if (trace.decision === "REVIEW_REQUIRED") {
      hasReview = true;
    }

    if (trace.obligations) {
      for (const ob of trace.obligations) {
        aggregatedObligations.add(ob);
      }
    }
  }

  let finalDecision: EnumValue<"decision">;
  if (hasDeny || requirements.length === 0) {
    finalDecision = "DENY";
    if (requirements.length === 0 && allReasonCodes.length === 0) {
      allReasonCodes.push("GRANT_REQUIREMENT_UNMET");
    }
  } else if (hasReview) {
    finalDecision = "REVIEW_REQUIRED";
  } else if (aggregatedObligations.size > 0) {
    finalDecision = "PERMIT_WITH_OBLIGATION";
  } else {
    finalDecision = "PERMIT";
  }

  const obligationsList = Array.from(aggregatedObligations).sort();

  const irForDigest = {
    as_of,
    known_at,
    result: finalDecision,
    reason_codes: allReasonCodes,
    obligations: obligationsList,
    traces: traces.map((t) => ({
      requirement_id: t.requirement_id,
      asset: t.asset,
      right_type: t.right_type,
      matched_grant_id: t.matched_grant_id,
      decision: t.decision,
      reason_codes: t.reason_codes,
      obligations: t.obligations,
    })),
  };

  const digest = digestOf(irForDigest);

  return {
    result: finalDecision,
    reason_codes: allReasonCodes,
    obligations: obligationsList,
    trace: traces,
    as_of,
    known_at,
    digest,
  };
}

function evaluateRequirement(
  req: Requirement,
  grants: readonly GrantRule[],
  as_of: string,
  known_at: string
): GrantTrace {
  // 1. asset, right_type이 일치하는 grant 검색
  const matchingGrants = grants.filter(
    (g) => g.asset === req.asset && g.right_type === req.right_type
  );

  if (matchingGrants.length === 0) {
    return {
      requirement_id: req.id,
      asset: req.asset,
      right_type: req.right_type,
      decision: "DENY",
      reason_codes: ["GRANT_REQUIREMENT_UNMET"],
    };
  }

  // 2. 시간축 필터링 (as_of in valid, recorded_at <= known_at)
  const temporalGrants = matchingGrants.filter(
    (g) => contains(g.valid, as_of) && g.recorded_at <= known_at
  );

  if (temporalGrants.length === 0) {
    return {
      requirement_id: req.id,
      asset: req.asset,
      right_type: req.right_type,
      decision: "DENY",
      reason_codes: ["GRANT_REQUIREMENT_UNMET"],
    };
  }

  // 3. 상태 검사 (REVOKED, DISPUTED, ASSERTED, VERIFIED)
  const hasRevoked = temporalGrants.some((g) => g.status === "REVOKED");
  if (hasRevoked) {
    return {
      requirement_id: req.id,
      asset: req.asset,
      right_type: req.right_type,
      decision: "DENY",
      reason_codes: ["GRANT_REVOKED"],
    };
  }

  const hasDisputed = temporalGrants.some((g) => g.status === "DISPUTED");
  if (hasDisputed) {
    return {
      requirement_id: req.id,
      asset: req.asset,
      right_type: req.right_type,
      decision: "REVIEW_REQUIRED",
      reason_codes: ["GRANT_CONFLICT"],
    };
  }

  const verifiedGrants = temporalGrants.filter((g) => g.status === "VERIFIED");
  if (verifiedGrants.length === 0) {
    return {
      requirement_id: req.id,
      asset: req.asset,
      right_type: req.right_type,
      decision: "DENY",
      reason_codes: ["GRANT_NO_EVIDENCE"],
    };
  }

  // 4. Scope 검사 (Scope Narrowing / Inclusion)
  for (const grant of verifiedGrants) {
    if (isSubScope(req.scope, grant.scope)) {
      const obligations = grant.obligations ? Array.from(grant.obligations).sort() : [];
      return {
        requirement_id: req.id,
        asset: req.asset,
        right_type: req.right_type,
        matched_grant_id: grant.id,
        decision: obligations.length > 0 ? "PERMIT_WITH_OBLIGATION" : "PERMIT",
        reason_codes: [],
        effective_scope: req.scope,
        obligations,
      };
    }
  }

  // Scope가 Grant 범위를 벗어남 (Scope Widening)
  return {
    requirement_id: req.id,
    asset: req.asset,
    right_type: req.right_type,
    decision: "DENY",
    reason_codes: ["GRANT_SCOPE_WIDENING"],
  };
}
