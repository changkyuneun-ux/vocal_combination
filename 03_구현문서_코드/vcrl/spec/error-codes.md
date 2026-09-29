# VCRL 오류 코드 (정본)

이 표는 `src/core/errors.ts`의 `ERROR_CODES`와 테스트로 동기화된다. 코드를 추가·삭제할 때 두 곳을 함께 고친다.

| 코드 | 의미 | 발생 위치 |
|---|---|---|
| `CORE_TYPE_ERROR` | 값의 타입 또는 형식이 규격과 다르다 | 모든 파서·검증기 |
| `CORE_NUMBER_IN_IR` | IR에 JSON number가 있다 | `canonicalize`, `validateEnvelope` |
| `CORE_ENUM_UNKNOWN` | 코어 Enum 레지스트리에 없는 값 | 모든 검증기 |
| `CORE_UNKNOWN_REF` | 참조 대상 없음 | `checkDependencies`, `checkAttestations` |
| `CORE_DEP_DIRECTION` | 허용되지 않는 방향의 모듈 의존(순환 포함) | `checkDependencies` |
| `CORE_DIGEST_MISMATCH` | digest 불일치 | `checkDependencies`, `checkAttestations` |
| `CORE_SIGNATURE_INVALID` | 서명 검증 실패 | `checkAttestations` |
| `CORE_SOD_VIOLATION` | 직무 분리 위반 | `checkSod` |
| `FACTS_DUPLICATE_ID` | facts 식별자 중복 | `validateFactsStructure` |
| `FACTS_UNKNOWN_ENTITY` | work·recording·voice·stem 참조 없음 | `validateFactsStructure` |
| `FACTS_UNKNOWN_PARTY` | party 참조 없음 | `validateFactsStructure` |
| `FACTS_EDGE_KIND` | 엣지와 source·target 종류 불일치 | `validateFactsStructure` |
| `FACTS_SUM_MISMATCH` | 그룹 share 합 ≠ 10000bps (위임은 > 10000bps) | `checkClaimSums`, `checkMandates`, `projectVectors` |
| `FACTS_CYCLE` | 위임 순환 | `checkMandates` |
| `FACTS_MANDATE_DEPTH` | 위임 2홉 초과 | `checkMandates`, `routeVector` |
| `FACTS_PATH_MISSING` | 필수 권리 경로 단절 | `projectVectors` |
| `FACTS_USAGE_INVALID` | 사용량 벡터 오류 | `projectVectors` |
| `FACTS_UNCOVERED_CLAIMANT` | 선언 청구권자가 도출되지 않음 | `checkClaimantCoverage` |
| `FACTS_CLAIMANT_DRIFT` | 도출 청구권자가 선언 목록에 없음 | `checkClaimantCoverage` |
| `FACTS_DISPUTE_OPEN` | 분쟁 중인 claim·mandate가 있어 팩 활성화 불가 | `checkActivation` |
| `ALLOC_SUM_MISMATCH` | tier1·tier2 버킷 bps 합 ≠ 10000 | `validateAllocation` |
| `ALLOC_WEIGHT_MISMATCH` | mix·HYBRID 가중치 합 ≠ 10000bps, 벡터 합 ≠ 1 | `validateAllocation`, `parseVector`, `splitLrm` |
| `ALLOC_MODE_REQUIRED` | performance_pool의 mode·필수 가중치 누락 | `validateAllocation` |
| `ALLOC_DUPLICATE_NAME` | 버킷 이름·배분 키 중복 | `validateAllocation`, `splitLrm` |
| `ALLOC_UNCOVERED_CLAIMANT` | 투영 역할을 다루는 버킷 없음, 또는 실연자가 멤버·사용량 기반 소스 어디에도 없음 | `evaluate` |
| `ALLOC_INFEASIBLE` | cap·floor_guarantee 불가능 | `validateAllocation`, `capVector`, `floorGuarantee` |
| `ALLOC_SCOPE_MISMATCH` | 이벤트 유형·통화가 정책 범위 밖 | `evaluate` |
| `ALLOC_EMPTY_VECTOR` | 배분할 벡터가 비어 있음 | `parseVector`, `fixedVector`, `usageVector`, `evalVector`, `splitLrm` |
| `ALLOC_ROUNDING_INVARIANT` | 층별 배분 합 ≠ 상위 금액 | `splitLrm` |
| `REV_ORIGINAL_DIGEST` | 원 안분 결과의 result_digest 불일치 | `reverse` |
| `REV_ORIGINAL_INCONSISTENT` | 원 결과의 권리 풀 ≠ 라인·보류 합 | `reverse` |
| `REV_UNKNOWN_EVENT` | 원 결과에 역분개할 이벤트 없음 | `reverse` |
| `REV_CHAIN_BROKEN` | 이전 역분개 체인이 재도출되지 않음 | `reverse` |
| `REV_EXCEEDS_REMAINING` | 누적 역분개액 > 원 이벤트 금액 | `reverse` |
| `REV_AMOUNT` | 역분개 금액이 양의 정수 문자열이 아님 | `reverse` |
| `PARSE_SYNTAX` | 텍스트 문법 오류(경로 `@줄:열`) | `tokenize`, `parseAllocation` |
| `PARSE_ROLE_REQUIRED` | 버킷 역할 추론 불가, `as <ROLE>` 필요 | `parseAllocation` |
| `PARSE_UNSUPPORTED` | 고정 의미와 다른 guard·exceptions 문장 | `parseAllocation` |

## 기존 코드 매핑

| 기존 코드 | VCRL 코드 |
|---|---|
| DSL_TYPE_ERROR | `CORE_TYPE_ERROR` |
| DSL_UNKNOWN_REF | `CORE_UNKNOWN_REF` |
| GRAPH_UNCOVERED_CLAIMANT | `FACTS_UNCOVERED_CLAIMANT` |
| GRAPH_PATH_MISSING | `FACTS_PATH_MISSING` |
| GRAPH_UNKNOWN_PARTY | `FACTS_UNKNOWN_PARTY` |
| CLAIMANT_DRIFT | `FACTS_CLAIMANT_DRIFT` |
| DSL_SUM_MISMATCH | `ALLOC_SUM_MISMATCH` |
| DSL_WEIGHT_MISMATCH | `ALLOC_WEIGHT_MISMATCH` |
| DSL_UNCOVERED_CLAIMANT | `ALLOC_UNCOVERED_CLAIMANT` |
