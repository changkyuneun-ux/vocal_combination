# Stem-to-Work 그래프 · 정산 DSL 기술문서 (초안)

상태: 초안
상위: `안분정책_AllocationPolicy_설계.md`, `데이터모델.md`

두 가지를 다룬다.

1. **Stem-to-Work 그래프** — 조합에 쓰인 스템에서 출발해 실연자·마스터·작품 권리자까지 올라가는 권리 경로. “누가 청구자인가”와 “각 경로 가중이 얼마인가”를 계산한다.
2. **정산 DSL** — 그 결과를 입력으로 받아 권리자 풀을 나누는 규칙을 선언적으로 쓰는 언어. 컴파일 결과가 기존 `allocation_policy`를 대체·생성한다.

그래프는 **사실**, DSL은 **정책**이다. 섞지 않는다.

---

# A. Stem-to-Work 그래프

## A1. 노드

| 노드 | 키 | 비고 |
| --- | --- | --- |
| `STEM` | `stem_id` | 조합의 최소 단위 |
| `VOICE` | `voice_asset_id` | 멤버 음성 |
| `PACK` | `pack_id` | 마스터/보컬팩 |
| `WORK` | `work_id` | 저작물 |
| `PARTY` | `party_id` | 지급 가능 주체 |

## A2. 엣지

| 엣지 | 방향 | 속성 |
| --- | --- | --- |
| `PERFORMED_BY` | STEM → VOICE | `share_bps` (한 스템에 복수 실연자일 때) |
| `OWNED_BY` | VOICE → PARTY(MEMBER) | `share_bps` |
| `PART_OF` | STEM → PACK | 구조 |
| `CONTROLLED_BY` | PACK → PARTY(LABEL) | `share_bps` (공동제작 분할) |
| `OF_WORK` | PACK → WORK | 구조 |
| `WRITTEN_BY` | WORK → PARTY(작가/출판) | `share_bps` |
| `REPRESENTED_BY` | PARTY → PARTY(CMO/에이전시) | `share_bps`, 징수 대행 |

공통 속성: `edge_id`, `role`(`PERFORMER | MASTER | WORK`), `valid_from`, `valid_to`, `graph_version`.

## A3. 불변식

1. **DAG.** 상향 단방향. 사이클은 저장 시 거부.
2. 같은 `(source_node, edge_type)` 그룹의 `share_bps` 합 = 10000.
3. `REPRESENTED_BY`는 최대 2홉. 대행의 대행까지만.
4. 시점 질의(`as_of`)는 `valid_from <= as_of < valid_to`인 엣지만 본다.
5. 그래프 변경은 **새 `graph_version`**. 기존 버전 행은 수정하지 않는다.

## A4. 역할별 해석

입력: 스냅샷의 스템 사용 벡터 `u[stem] ∈ [0,1]`, 합 1. (`snapshot_stem_assignment.duration_ms` 기반 또는 균등)

각 역할마다 **경로 곱**으로 파티 벡터를 만든다.

```
PERFORMER : STEM -PERFORMED_BY-> VOICE -OWNED_BY-> PARTY [-REPRESENTED_BY-> PARTY]
MASTER    : STEM -PART_OF->      PACK  -CONTROLLED_BY-> PARTY [-REPRESENTED_BY->]
WORK      : STEM -PART_OF->      PACK  -OF_WORK->    WORK -WRITTEN_BY-> PARTY [-REPRESENTED_BY->]
```

```
w[role][party] = Σ_stem  u[stem] × Π_edge (share_bps / 10000)
```

역할별로 합이 1인 벡터 3개가 나온다. 한 파티가 두 역할에 나타나면 **벡터를 합치지 않는다**. 역할이 곧 청구 근거이고, 계약 버킷이 보통 역할 단위이기 때문이다.

## A5. 커버리지

`claimant` 집합(`grant_id` 기준)과 대조한다.

| 상황 | 처리 |
| --- | --- |
| 청구자인데 세 벡터 모두 0 | `GRAPH_UNCOVERED_CLAIMANT`. 발행·정산 홀드 |
| 경로 끊김 (엣지 누락) | `GRAPH_PATH_MISSING`. 해당 스템 제외 후 재정규화하고 로그 |
| 청구자가 아닌데 벡터에 등장 | 0으로 절단, 경고 |

## A6. 스냅샷

발행 시 `graph_version`과 **해석된 경로**를 복사한다. 정산은 그래프를 다시 걷지 않는다.

`snapshot_graph_path`

| 컬럼 | 내용 |
| --- | --- |
| `snapshot_id`, `path_seq` | PK |
| `stem_id`, `role`, `party_id` | |
| `weight_bps` | 경로 곱 결과 |
| `edge_ids[]` | 감사·재현 |

`rights_snapshot.graph_version`을 함께 저장한다.

## A7. 저장 형태

노드 수가 팩당 수백 수준이므로 **관계형 + 재귀 CTE**로 충분하다. 전용 그래프 DB는 쓰지 않는다.

```sql
-- 개념 예시
WITH RECURSIVE up(node_id, role, weight_bps, depth) AS (...)
SELECT party_id, SUM(weight_bps) FROM up WHERE node_type='PARTY' GROUP BY party_id;
```

해석 결과는 `(pack_id, graph_version, u-digest)` 키로 캐시한다. 같은 조합 구성은 같은 결과다.

---

# B. 정산 DSL (VC-DSL)

## B1. 목표와 비목표

**목표**

- 안분 규칙을 사람이 읽고 리뷰할 수 있는 텍스트로 관리
- 컴파일 시 정적 검증(합 100%, 커버리지, 타입)
- 결정적 실행, 원 단위 재현

**비목표**

- 범용 계산 언어가 아니다. 루프·재귀·사용자 함수·IO 없음
- 3풀(권리자/플랫폼/팬) 산정은 `settlement_rule` 몫. DSL은 **권리자 풀 내부**만

## B2. 타입

| 타입 | 뜻 |
| --- | --- |
| `Ratio` | 0–1 유리수. 리터럴은 `%` |
| `Vector` | `party_id → Ratio`, 합 1 |
| `Bucket` | 이름 + 지분 + (선택) 하위 표현 |
| `Money` | 정수 원 |

## B3. 내장 함수

| 함수 | 반환 | 설명 |
| --- | --- | --- |
| `member_pct()` | Vector | 빌더 멤버 % (스냅샷) |
| `stem_time(include_locked: Bool)` | Vector | 배정 구간 초 기반 |
| `contract(...)` | Vector | 선언된 고정 지분 |
| `graph(role: PERFORMER\|MASTER\|WORK)` | Vector | A절 해석 결과 |
| `party("pty_…")` | Vector | 단일 파티 100% |
| `mix(a: w, b: w, …)` | Vector | 가중 선형 결합. 가중 합 100% |
| `layer(base) { bucket -> expr }` | Vector | 계층 분해 |
| `normalize(v)` | Vector | 0 아닌 성분만 재정규화 |
| `cap(v, party, max)` | Vector | 상한 후 나머지 비례 재분배 |

시간·난수·네트워크 함수는 없다. `as_of`는 스냅샷이 결정한다.

## B4. 문법 (EBNF 발췌)

```ebnf
program     = "policy" string "version" int "{" scope input buckets allocate guards rounding "}" ;
scope       = "scope" "{" "pack" ":" string ";" "event" ":" ("PRIMARY"|"RESALE") "}" ;
input       = "input" "{" "pool" ":" "rights_pool" "}" ;
buckets     = "buckets" "{" { bucket } "}" ;
bucket      = ident "=" expr ":" ratio ";" ;
allocate    = "allocate" "{" expr "}" ;
guards      = "guards" "{" { guard ";" } "}" ;
rounding    = "rounding" "{" "unit" ":" "KRW" ";" "remainder" ":" rem ";" "tie" ":" tie ";" "}" ;
expr        = call | ident | mix | layer ;
mix         = "mix" "(" ident ":" ratio { "," ident ":" ratio } ")" ;
layer       = "layer" "(" expr ")" "{" { ident "->" expr ";" } "}" ;
ratio       = number "%" ;
rem         = "LARGEST_SHARE" | "SMALLEST_ID" ;
guard       = "require_all_claimants_covered" | "sum_buckets" "==" ratio | "no_zero_claimant" ;
```

## B5. 예제

### 기본 템플릿 (계층 믹스)

```
policy "VC-ALLOC-DEFAULT" version 1 {
  scope  { pack: "pak_a01"; event: PRIMARY }
  input  { pool: rights_pool }

  buckets {
    label     = graph(role: MASTER)    : 40%;
    performer = graph(role: PERFORMER) : 50%;
    work      = graph(role: WORK)      : 10%;
  }

  allocate {
    layer(contract) {
      performer -> member_pct();
      work      -> graph(role: WORK);
    }
  }

  guards   { require_all_claimants_covered; sum_buckets == 100%; }
  rounding { unit: KRW; remainder: LARGEST_SHARE; tie: party_id_asc; }
}
```

`label` 버킷은 하위 표현이 없으므로 1층 벡터를 그대로 쓴다.

### 실연자 풀만 시간+구성 혼합

```
  allocate {
    layer(contract) {
      performer -> mix(member_pct: 70%, stem_time: 30%);
    }
  }
```

### 2차 재판매 (단독 계약)

```
policy "VC-ALLOC-RESALE" version 1 {
  scope   { pack: "pak_a01"; event: RESALE }
  input   { pool: rights_pool }
  buckets { label = graph(role: MASTER) : 60%;
            performer = graph(role: PERFORMER) : 30%;
            work = graph(role: WORK) : 10%; }
  allocate { layer(contract) { } }
  guards   { require_all_claimants_covered; sum_buckets == 100%; }
  rounding { unit: KRW; remainder: LARGEST_SHARE; tie: party_id_asc; }
}
```

## B6. 컴파일

```
소스 → 파싱(AST) → 정적 검증 → 실행 플랜 → digest → 저장
```

정적 검증:

| 검사 | 실패 코드 |
| --- | --- |
| 버킷 지분 합 100% | `DSL_SUM_MISMATCH` |
| `mix` 가중 합 100%, 음수 없음 | `DSL_WEIGHT_MISMATCH` |
| 타입 일치 (Vector 자리에 Ratio 등) | `DSL_TYPE_ERROR` |
| 미지의 `party_id`·`role` | `DSL_UNKNOWN_REF` |
| 청구자 집합이 이론상 커버 불가 | `DSL_UNCOVERED_CLAIMANT` |
| 연산 수·파티 수 한도 초과 | `DSL_LIMIT_EXCEEDED` |

`digest = sha256(정규화된 AST)`. 소스·플랜·digest를 `allocation_policy_source`에 저장하고, 기존 `allocation_policy`·`alloc_layer`·`share_bucket` 행은 **컴파일 산출물**로 함께 쓴다. 기존 엔진과 백오피스 화면은 그대로 동작한다.

## B7. 실행 시맨틱

1. 스냅샷에서 베이스 벡터 로드 (`member_pct`, `stem_time`, `snapshot_graph_path`)
2. 플랜 실행. 중간 계산은 `NUMERIC(38,18)` 유리수
3. **반올림은 마지막 한 번.** `floor(R × s)` 후 잔여를 `remainder` 규칙으로 1원씩
4. `sum(amount) == R` 검증 실패 시 배치 중단
5. `allocation_line.breakdown_json`에 역할 벡터·경로·가중치 기록

환불은 같은 플랜에 음수 풀을 넣지 않고, 원 라인의 **부호 반전**으로 만든다(정합성 보장).

## B8. 테스트

| 종류 | 내용 |
| --- | --- |
| 골든 | 팩별 대표 조합 N건의 기대 금액 고정 |
| 속성 | 합 보존, 파티 순서 무관, 스케일 선형성(2R → 각 2배 ±1원), 역분개 = −1배 |
| 섀도 | 신규 버전을 최근 배치에 무저장 실행, 차액 리포트 |
| 퍼즈 | 0% 멤버, 단일 파티, 경로 누락, 잔여 라운딩 경계 |

활성화 전 **섀도 실행 필수**. 차액이 임계 초과면 승인 화면에 경고.

## B9. 보안·한도

- 루프·재귀·사용자 정의 함수 없음 → 정지성 보장
- 파서 깊이·노드 수 상한, 파티 수 상한
- DSL은 데이터만 읽는다. 쓰기·외부 호출 API 없음
- 편집자와 활성화 승인자 분리(`SPACE_EDITOR` ≠ `SPACE_SETTLE`)

## B10. 마이그레이션

1. 현행 `VC-ALLOC-DEFAULT-V1`(계층 믹스, 2층 멤버 %)을 DSL로 **그대로** 표현
2. 섀도 실행으로 기존 엔진과 원 단위 일치 확인
3. 신규 정책만 DSL로 작성, 기존 행은 컴파일 산출물로 유지
4. 그래프 해석을 켜면 `contract` 고정 지분 대신 `graph(role: …)`로 점진 대체

---

## C. 미결

- `stem_time`의 분모에 잠금 스템 포함 여부를 DSL 인자로 둘지, 팩 설정으로 고정할지
- `REPRESENTED_BY` 2홉 제한이 해외 서브퍼블리셔 구조에 충분한지
- 그래프 버전 교체 시 미발행 초안의 재검증 범위
- DSL 편집 UI를 텍스트로 열지, 폼에서 생성만 할지
