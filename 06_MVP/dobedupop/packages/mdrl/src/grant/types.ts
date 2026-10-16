import type { Scope } from "../core/scope.ts";
import type { Interval } from "../core/time.ts";
import type { EnumValue } from "../core/enums.ts";
import type { ErrorCode } from "../core/errors.ts";
import type { IrDocument } from "../core/envelope.ts";

/**
 * 결과물이 요구하는 이용 허락 단위 (규격 6.4.1절).
 * (자산, 권리 종류, 이용 범위)
 */
export interface Requirement {
  readonly id?: string;
  readonly asset: string;
  readonly right_type: string;
  readonly scope: Scope;
}

/**
 * 개별 허락 조항 (Grant Rule).
 */
export interface GrantRule {
  readonly id: string;
  readonly grantor: string;
  readonly grantee?: string;
  readonly asset: string;
  readonly right_type: string;
  readonly scope: Scope;
  readonly obligations?: readonly string[];
  readonly status: "VERIFIED" | "ASSERTED" | "DISPUTED" | "REVOKED";
  readonly valid: Interval;
  readonly recorded_at: string;
}

/**
 * Grant 문서의 본문 (Body).
 */
export interface GrantBody {
  readonly grants: readonly GrantRule[];
}

/**
 * Grant Envelope 문서.
 */
export type GrantDoc = IrDocument<GrantBody>;


/**
 * 이용허락 판정 추적 기록 (Trace).
 */
export interface GrantTrace {
  readonly requirement_id?: string;
  readonly asset: string;
  readonly right_type: string;
  readonly matched_grant_id?: string;
  readonly decision: EnumValue<"decision">;
  readonly reason_codes: readonly ErrorCode[];
  readonly effective_scope?: Scope;
  readonly obligations?: readonly string[];
}

/**
 * 이용허락 판정 입력.
 */
export interface GrantEvaluationInput {
  readonly requirements: readonly Requirement[];
  readonly grants: readonly GrantRule[];
  readonly as_of: string;
  readonly known_at: string;
  readonly revocation_epoch?: number;
}

/**
 * 이용허락 판정 출력 (규격 6.4.1절).
 */
export interface GrantDecisionOutput {
  readonly result: EnumValue<"decision">;
  readonly reason_codes: readonly ErrorCode[];
  readonly obligations: readonly string[];
  readonly trace: readonly GrantTrace[];
  readonly as_of: string;
  readonly known_at: string;
  readonly digest: string;
}
