# VCRL(Vocal Combination Rights Language) 아키텍처 · 코어 규격 설계

- **문서 상태**: 설계 합의(브레인스토밍 승인) — 구현 계획 수립 전
- **작성일**: 2026-09-28
- **버전**: v1.0
- **상위·참조 문서**:
  - `../권리정산인프라_20260927/보컬조합_권리관리_정산인프라_기획설계_v1.0.md` (D01~D12 제안)
  - `../데이터모델_v2.7.md`
  - `../Stem2Work그래프_정산DSL_설계.md`, `../안분정책_AllocationPolicy_설계.md`, `../안분정책_Stem2Work그래프_정산DSL_통합요약.md`
  - `../정책게이팅엔진_설계.md`, `../검증_승인_권리스탬프_설계.md`, `../조합제약_유일키_설계.md`
- **대체 관계**: 본 문서 9절 "정본 결정"에 열거된 항목은 참조 문서의 해당 기술을 대체한다. 그 외 항목은 참조 문서의 결정을 유지한다.

---

## 1. 목적과 범위

### 1.1 문제

보컬조합 플랫폼의 권리·정산 규칙은 권리자, 권리 사실, 조합 제약, 이용허락·승인, 안분·정산의 다섯 영역에 걸쳐 있다. 현재는 다음 문제가 있다.

1. **DSL 범위가 좁다.** 기존 VC-DSL은 Tier 2 권리자 풀 내부 안분만 다룬다. 나머지 네 영역은 DB 스키마·ENUM·CHECK 제약이 곧 규칙이다.
2. **정본이 없다.** 같은 개념이 문서마다 다르게 정의되어 14건의 불일치가 확인되었다(9절).
3. **외부 검증 수단이 없다.** DDEX 등 표준은 사실·거래 보고를 운반하지만 조합 제약·안분 정책·승인 규칙을 표현하지 못한다. 이해관계자가 정산 결과를 독립적으로 재계산할 방법이 없다.

### 1.2 목표

- 다섯 영역의 규칙을 하나의 언어 패밀리 **VCRL**로 기술하고, VCRL IR을 **단일 정본(Single Source of Truth)** 으로 삼는다.
- **검증 가능한 공개**: 플랫폼이 VCRL 문서를 작성·공개하고, 이해관계자(레이블·기획사·신탁단체·유통사·AI 제공자)는 이를 읽고 **독립적으로 재계산해 digest를 대조**할 수 있다. 이해관계자의 직접 작성·공동 서명은 본 버전의 범위가 아니다.
- 공개 규격 + 레퍼런스 구현 + 공개 적합성 테스트 스위트를 제공한다.

### 1.3 범위 밖

- 벡터 DB·임베딩(음성 유사도, 의미 검색 등). 본 문서의 "벡터"는 **권리 그래프 경로로 계산되는 역할별 기여 지분 벡터**만을 뜻한다.
- 이해관계자의 VCRL 직접 작성·제출.
- 블록체인 스마트컨트랙트 실행. digest 앵커링은 선택 옵션으로 후순위.
- 개별 계약 권리 귀속 확정, 요율 협상, 세무 판단.

### 1.4 사이클 분해

| 순서 | 서브프로젝트 | 산출물 |
|---|---|---|
| 0 | **본 문서**: 전체 아키텍처 + 코어 규격 + 모듈 접점 + 정본 결정 | 설계 스펙 |
| 1 | core + facts + 그래프 투영/기여 벡터 + allocation | 상세 스펙 → 레퍼런스 구현 |
| 2 | constraint + grant (게이트 판정기) | 상세 스펙 → 구현 |
| 3 | approval (승인 체인·SoD·스탬프) | 상세 스펙 → 구현 |
| 4 | 공개 번들 포털·외부 어댑터(DDEX·ODRL) | 상세 스펙 → 구현 |

---

## 2. 전체 아키텍처

```
┌─ 저작 계층 ───────────────────────────────────────────────────┐
│ 백오피스 폼/슬라이더 ──(생성)──> VCRL 텍스트  <──(직접편집) 관리자 모드 │
└──────────────────────────────┬────────────────────────────────┘
                               ▼ parse → resolve → typecheck → static verify
┌─ 정본 계층 ───────────────────────────────────────────────────┐
│ VCRL-IR (정규 JSON, RFC 8785 JCS)  ── digest = sha256(JCS(IR)) │
│ 모듈: core · facts · constraint · grant · approval · allocation │
│ 레지스트리: 모듈별 불변 버전 · 서명 · 활성화(SoD)                │
└──────┬──────────────────┬───────────────────┬─────────────────┘
       ▼                  ▼                   ▼
  그래프 투영기        게이트 판정기         결정적 정산 평가기
  facts → DAG →       constraint + grant    allocation + 스냅샷
  PartyVector<Role>   → Decision            → allocation_line
       └────────┬─────────┴───────────┬───────┘
                ▼                     ▼
      Rights Manifest 번들       PostgreSQL 운영 스키마
      (공개·검증용)               (IR에서 파생, 수기 입력 금지)
                ▼
  외부 검증자: vcrl CLI / 레퍼런스 평가기로 재계산 → digest 대조
  외부 어댑터: DDEX(RIN·MWN·ERN·DSR), ISRC/ISWC/ISNI/IPI, ODRL 2.2
```

### 2.1 원칙

1. **IR이 정본이다.** 텍스트 문법, 백오피스 폼, DB 테이블, 설계 문서의 ENUM 표는 모두 IR에서 파생된다. 운영 DB의 규칙성 테이블(`allocation_policy`, `share_bucket`, `combination_constraint`, `*_credit`, `right_claim`, `mandate` 등)은 IR 컴파일 결과로만 생성되며 직접 UPDATE를 금지한다.
2. **사실과 정책의 분리.** `facts`는 계산식 없는 선언 데이터다. 나머지 모듈은 규칙이다.
3. **결정성.** 평가 과정에서 `now()`, 난수, 외부 I/O를 사용하지 않는다. 시점은 `as_of`, `known_at` 입력으로만 주어진다. 동일 IR과 동일 입력은 원 단위까지 동일한 결과와 동일한 digest를 낸다.
4. **공개 등급 분리.** 모든 IR 노드는 `visibility`를 가지며, 비공개 값은 해시 커밋먼트로 치환해 공개한다(3.4).
5. **기존 저장 스택 유지.** PostgreSQL이 저장소이고 그래프는 읽기 모델 투영이다. 그래프 DB는 탐색 병목이 실측될 때만 도입한다.

---

## 3. 코어 규격 (`vcrl.core`)

### 3.1 타입 시스템

| 타입 | 정의 | 불변식 |
|---|---|---|
| `Bps` | 정수 0~10000 | 저장되는 비율은 항상 정수 bps. `%` 표기는 문법 설탕이며 `12.5%` → `1250bps`. bps로 떨어지지 않는 % 리터럴은 컴파일 오류 |
| `Ratio` | 유리수 `n/d` (BigInt 분자·분모, 기약분수 정규화) | 중간 계산 전용. 부동소수 금지 |
| `Money<C>` | BigInt, 통화 C의 최소 단위 | 통화가 다른 값끼리의 연산은 타입 오류 |
| `DurationMs` | 0 이상의 정수 | |
| `Instant` | UTC, 밀리초 정밀도, ISO 8601 문자열 | |
| `Interval` | `[from, to)` 반열린 구간. `to` 생략 = 무기한 | `from < to` |
| `Ref<T>` | `vc:<kind>/<id>@<version>` | IR 안에서 버전 없는 참조 금지 |
| `PartyVector<Role>` | `Map<PartyRef, Ratio>` | 합계 = 1. 역할별 독립 유지, 역할 간 사전 합산 금지 |
| `Scope` | `{ actions, territories, media, period, audience }` | 격자 구조. 합성은 `meet`(교집합)만 허용 |
| `Enum<Name>` | 코어 Enum 레지스트리 등록 열거형 | 모든 ENUM은 레지스트리 한 곳에서만 정의 |

### 3.2 코어 Enum 레지스트리

모든 모듈과 DB 스키마, 설계 문서는 아래 레지스트리의 값만 사용한다. 값 추가·변경은 레지스트리 버전을 올려서만 가능하다. 초기 등록 항목과 값은 9절 결정을 반영한다.

- `claimant_role`: `MASTER_OWNER | WORK_AUTHOR | CMO | PERFORMER_FEATURED | PERFORMER_NON_FEATURED | AGENCY | AI_PROVIDER | RECORDING_CONTRIBUTOR`
- `edge_type`: `PERFORMED_BY | OWNED_BY | IN_SLOT | OF_RECORDING | PART_OF | CONTROLLED_BY | OF_WORK | WRITTEN_BY | CONTRIBUTED_BY`
- `claim_status`: `ASSERTED | VERIFIED | DISPUTED | SUPERSEDED`
- `decision`: `PERMIT | PERMIT_WITH_OBLIGATION | DENY | REVIEW_REQUIRED`
- `approval_mode`: `AUTO | LABEL | AGENCY`
- `stamp_clause`: `PERSONAL_HOLD | PLATFORM_DISTRIBUTE | LIMITED_USE | COMMERCIAL | DOWNLOAD` (v2.7). `stamp_clause ⊂ action` 불변식을 코어가 강제한다
- `uniqueness_scope`: `PACK | FAN_PACK`
- `binding_time`: `ISSUE_TIME | USAGE_TIME | SALE_TIME | REPORT_PERIOD`
- `event_type`: `PRIMARY | RESALE | TRAFFIC`
- `pool_mode`: `USAGE_WEIGHTED | FIXED | HYBRID | MEMBER_PCT`
- `rounding_method`: `HIERARCHICAL_LRM_V1`
- `visibility`: `PUBLIC | PARTIES | PRIVATE`
- `action`: v2.7 통일 행위 코드 9종 `PREVIEW | COMBINE | PERSONAL_HOLD | SHARE_LINK | PLATFORM_DISTRIBUTE | LIMITED_USE | RESALE | COMMERCIAL | DOWNLOAD` + AI 축 2종(v2.7 정의 그대로). 게이팅 문서의 `ISSUE`, `PLAY`는 매핑표로 흡수한다(서브프로젝트 2에서 매핑표 확정).
- `vc_status`: v2.7의 8개 상태값을 그대로 등록한다.

### 3.3 정규형과 digest

- IR 문서 봉투:
  ```json
  { "vcrl": "1.0", "module": "allocation", "id": "VC-ALLOC-NOVA-02", "version": 1,
    "depends_on": [{ "ref": "vc:facts/nova-debut-01@3", "digest": "vcrl:sha256:ab12…" }],
    "visibility_default": "PARTIES", "body": { … } }
  ```
- 직렬화는 RFC 8785(JCS). 정수·BigInt·유리수는 모두 **문자열**로 표기한다(`"4500"`, `"3/7"`). JSON number 타입은 IR에서 사용하지 않는다.
- `digest = "vcrl:sha256:" + hex(sha256(UTF-8(JCS(IR))))`.
- 텍스트 → IR 변환은 결정적이다. 주석, 공백, 선언 순서는 digest에 영향을 주지 않는다. 순서가 의미를 갖지 않는 컬렉션은 IR에서 키 기준으로 정렬한다.

### 3.4 공개 등급과 커밋먼트

- 모든 노드는 `visibility`를 가질 수 있다. 생략 시 모듈의 `visibility_default`를 따른다. 모듈별 기본값: facts의 엔티티 존재·식별자 = `PUBLIC`, share 값·증빙 = `PARTIES`, allocation의 split 비율 = `PARTIES`, 결과 금액 = `PARTIES`.
- 공개본 생성 시 `PUBLIC`이 아닌 값은 `{ "commit": "vcrl:sha256:" + hex(sha256(salt ‖ JCS(value))) }`로 치환한다. salt는 값마다 32바이트 난수이며, 해당 값에 권리가 있는 당사자에게만 전달한다. salt 생성은 게시 시점의 1회성 작업이며 평가의 결정성과 무관하다.
- 공개 digest는 치환된 IR 기준으로 계산한다. 전체 IR의 digest와 공개 IR의 digest는 manifest에 함께 기록한다.
- 검증 수준:
  - 제3자: 구조, digest 체인, 서명, 공개된 합계 불변식, 결과 digest 존재를 검증한다.
  - 당사자: salt로 자신과 관련된 커밋먼트를 열어 원문을 복원하고, 자기 몫의 재계산까지 검증한다.

### 3.5 모듈·버전·참조

- 게시된 `(module, id, version)`은 불변이다. 수정은 새 version을 발급하고 이전 버전에 `superseded_by`를 기록한다.
- 의존은 `depends_on`에서 **digest로 고정**한다. 참조 대상의 새 버전이 나와도 기존 문서의 의미는 변하지 않는다.
- 모듈 의존 방향: `core ← facts ← {constraint, grant} ← approval ← allocation`. 역방향·순환 의존은 컴파일 오류(`CORE_DEP_CYCLE`).
- 언어 버전 `vcrl: "MAJOR.MINOR"`. 비호환 변경은 MAJOR를 올린다. 기존 VC-DSL v1 소스는 `dialect: legacy-v1` 변환기로 IR로 이관한다.

### 3.6 서명과 증명

- `attestations[]`: `{ signer: PartyRef, role: EDITOR | APPROVER | WORK_APPROVER | ACTIVATOR, over: digest, alg: "Ed25519", sig }`.
- 서명 공개키는 party 레지스트리에 등록한다.
- SoD 규칙은 `approval` 모듈이 선언하고 코어 검증기가 강제한다. 서브프로젝트 3 이전까지는 코어 검증기에 다음 두 규칙을 내장한다: `distinct(EDITOR, ACTIVATOR)`, `distinct(SPACE_OPS, SPACE_SETTLE)`.

### 3.7 오류 모델

- 모든 판정·검증 결과는 `{ result, reason_codes[], trace }` 형태다.
- 오류 코드는 `<MODULE>_<CODE>` 네임스페이스(`CORE_`, `FACTS_`, `CONSTRAINT_`, `GRANT_`, `APPROVAL_`, `ALLOC_`).
- 기존 코드 매핑: `DSL_SUM_MISMATCH → ALLOC_SUM_MISMATCH`, `DSL_WEIGHT_MISMATCH → ALLOC_WEIGHT_MISMATCH`, `DSL_UNCOVERED_CLAIMANT → ALLOC_UNCOVERED_CLAIMANT`, `DSL_TYPE_ERROR → CORE_TYPE_ERROR`, `DSL_UNKNOWN_REF → CORE_UNKNOWN_REF`, `GRAPH_UNCOVERED_CLAIMANT → FACTS_UNCOVERED_CLAIMANT`, `GRAPH_PATH_MISSING → FACTS_PATH_MISSING`, `GRAPH_UNKNOWN_PARTY → FACTS_UNKNOWN_PARTY`.

---

## 4. `facts` 모듈 · 그래프 투영 · 기여 벡터

### 4.1 문법 예시

```vcrl
facts "nova-debut-01" version 3 {
  party pty_label_x   { kind: LABEL;     ids: { isni: "0000000123456789" } }
  party pty_member_a  { kind: PERFORMER }
  party pty_author_b  { kind: AUTHOR }
  party pty_komca     { kind: CMO }

  work      wrk_01 { ids: { iswc: "T-123.456.789-0" } }
  recording rcd_01 { of: wrk_01; ids: { isrc: "KRA012600001" } }
  voice     vo_a   { kind: HUMAN }
  stem      stm_01 { of: rcd_01; slot: slt_v1; rights_bearing: true }

  claim c1: stm_01 PERFORMED_BY  vo_a         share 10000bps;
  claim c2: vo_a   OWNED_BY      pty_member_a share 10000bps;
  claim c3: rcd_01 CONTROLLED_BY pty_label_x  share 10000bps
            valid [2026-01-01, 2031-01-01) evidence ev_contract_17;
  claim c4: wrk_01 WRITTEN_BY    pty_author_b share 6000bps role LYRICS;
  mandate m1: pty_author_b -> pty_komca scope { right: WORK_PERF } valid [2026-01-01, );
}
```

(예시 값이며 규격 값이 아니다. c4 그룹의 나머지 4000bps는 예시에서 생략했다.)

### 4.2 권리 주장(claim) 모델

- 기획설계 v1.0의 `right_claim`을 정본으로 채택한다.
- 상태: `ASSERTED → VERIFIED | DISPUTED`, `* → SUPERSEDED`. **투영에는 `VERIFIED`만 포함한다.**
- 이중 시간축: 효력 구간 `valid [from, to)` + 기록 구간 `recorded_at / superseded_at`. 질의는 `(as_of, known_at)` 두 시점을 받으며, 두 값이 같으면 결과가 영구히 재현된다.
- `evidence`: 증빙 문서의 해시 참조. 기본 공개 등급 `PARTIES`.
- **`work.cmo_managed` Boolean을 폐지하고 `mandate`로 일원화한다(D05).**
- `mandate` 위임은 최대 2홉. 3홉 이상은 `FACTS_MANDATE_DEPTH`로 거부한다. 3홉 이상의 실제 위임은 등록 단계에서 단일 홉으로 평탄화한다.

### 4.3 정적 검증 불변식

1. 동일 시점에 유효한 `(source, edge_type, role)` 그룹의 share 합은 정확히 10000bps다(D03). 위반 시 `FACTS_SUM_MISMATCH`. 구조적 엣지(`IN_SLOT`, `OF_RECORDING`, `PART_OF`, `OF_WORK`)는 share가 없으므로 대상이 아니다.
2. 계산용 투영은 DAG다. 위반 시 `FACTS_CYCLE`.
3. 참조 party는 모두 레지스트리에 존재한다. 위반 시 `FACTS_UNKNOWN_PARTY`.
4. 그룹 안에 `DISPUTED` claim이 하나라도 있으면 그 그룹 전체를 보류한다. **자동 재정규화를 금지한다.** 보류분은 정산 시 `unallocated_holding(reason_code = RIGHTS_DISPUTE)`로 이동한다.

### 4.4 그래프 투영과 기여 벡터

- 입력: `facts@digest`, `(as_of, known_at)`, 사용량 벡터 `u`.
- `u[s]`: 스냅샷의 스템별 배정 시간 `ASSIGNED_LAYER_MS`를 전체 합으로 나눈 유리수(Σu = 1). `rights_bearing = true`인 잠금 스템은 분모·분자에 포함한다. 명칭은 `ASSIGNED_LAYER_MS`로 통일하고 `ASSIGNED_DURATION`은 폐기한다.
- 역할별 경로는 기존 Stem2Work 설계 A4의 경로 정의를 따른다(`REPRESENTED_BY`는 `mandate`로 대체).
- 계산:
  `w_role[p] = Σ_s u[s] · Π_{e ∈ path(s→p, role)} share(e) / 10000`
  행렬 표기 `W_role = u · M_role`. 모든 연산은 `Ratio`로 정확히 수행한다.
- 출력 IR: `{ vectors: {role: PartyVector}, paths: [{stem, role, party, weight, claim_ids[]}], facts_digest, as_of, known_at, u_digest, digest }`. 발행 시 `snapshot_graph_path`로 동결한다.
- 커버리지: facts에서 도출된 청구권자 집합과 팩의 `claimant` 목록을 대조한다. 누락은 `FACTS_UNCOVERED_CLAIMANT`로 팩 활성화를 거부한다.

### 4.5 저장 매핑

facts IR 컴파일 시 `party`, `work_credit`, `recording_credit`, `stem_credit`, `right_claim`, `mandate`, `rights_image_party` 행을 파생 생성한다. 기존 행은 UPDATE하지 않고 새 버전 행을 추가한다.

---

## 5. `allocation` 모듈 (VC-DSL/2 통합)

### 5.1 범위

Tier 1(순매출 → 3풀)과 Tier 2(권리자 풀 내부 안분)를 하나의 모듈에서 기술한다. 기존 `settlement_rule`(Tier 1)과 VC-DSL(Tier 2)을 통합한다.

### 5.2 문법 예시

```vcrl
allocation "VC-ALLOC-NOVA-02" version 1 {
  uses facts "nova-debut-01"@vcrl:sha256:ab12…;
  scope  { pack: pak_nova_summer_02; event: [PRIMARY, RESALE]; currency: KRW; }
  bind   { time: ISSUE_TIME; }

  tier1 {
    platform = 2500bps; ops = 500bps; rights = 7000bps;
  }
  tier2 rights {
    split {
      master    = graph(MASTER_OWNER)                             : 4500bps;
      performer = performance_pool(HYBRID,
                    fixed: 4000bps, usage: 6000bps,
                    featured_weight: 7000bps)
                  |> cap(5000bps) |> floor_guarantee(300bps)      : 4500bps;
      work      = graph(WORK_AUTHOR) via mandate                  : 1000bps;
    }
  }
  guard      { require covered(all_claimants); require sum(split) == 10000bps; }
  exceptions { on DISPUTED -> hold(AFFECTED_BUCKET); on FRAUD_FLAG -> hold(ALL); }
  rounding   { method: HIERARCHICAL_LRM_V1; tie: party_id_asc; }
}
```

(모든 비율은 예시 값이다.)

### 5.3 내장 벡터 함수

| 함수 | 반환 | 설명 |
|---|---|---|
| `graph(role)` | `PartyVector` | 4.4 투영 결과 |
| `graph(role) via mandate` | `PartyVector` | 수령 경로를 mandate 대상으로 라우팅 |
| `member_pct()` | `PartyVector` | 스냅샷의 팬 빌더 멤버 비율 |
| `usage_vector(ASSIGNED_LAYER_MS, featured_weight)` | `PartyVector` | 스템 배정 시간 기반 |
| `contract(party)` | `PartyVector` | 단일 파티 100% |
| `performance_pool(mode, …)` | `PartyVector` | 모드: `USAGE_WEIGHTED | FIXED | HYBRID | MEMBER_PCT` |
| `mix(v1: w1, …)` | `PartyVector` | Σw = 10000bps |
| `v |> cap(max)` | `PartyVector` | 초과분을 나머지에 비례 재분배 |
| `v |> floor_guarantee(min)` | `PartyVector` | 최저 보장 후 재정규화 |

### 5.4 정적 검증

- 모든 `tier1`, `split`, `mix` 합 = 10000bps (`ALLOC_SUM_MISMATCH`, `ALLOC_WEIGHT_MISMATCH`).
- facts에서 도출된 청구권자가 모든 역할에서 어떤 버킷에 커버됨 (`ALLOC_UNCOVERED_CLAIMANT`).
- 통화·역할 타입 일치 (`CORE_TYPE_ERROR`).
- 파이프 연산 후 벡터 합 = 1. `cap`·`floor_guarantee` 파라미터가 풀 인원수와 모순이면(예: 인원 × floor > 1) `ALLOC_INFEASIBLE`.
- `performance_pool`의 mode는 **반드시 명시**한다. 생략 시 `ALLOC_MODE_REQUIRED`.
- 템플릿 계승 시 범위 확대 금지 (`ALLOC_WIDENING`).

### 5.5 반올림 `HIERARCHICAL_LRM_V1`

각 층(Tier 1 → Tier 2 1층 버킷 → 2층 풀 → 파티)에서 상위 금액 `R`을 하위 항목 비율 `r_i`로 나눌 때:
1. `a_i = floor(R · r_i)` (정확한 유리수 곱 후 절사).
2. `Δ = R − Σ a_i`.
3. 소수부 `frac(R · r_i)` 내림차순, 동률이면 `party_id`(버킷 층에서는 버킷 이름) 오름차순으로 상위 Δ개 항목에 1씩 가산.
4. 층마다 `Σ a_i = R`을 검증한다. 불일치 시 결과 전체 무효.

### 5.6 레퍼런스 평가기 계약

```
evaluate(policy_IR, vectors_IR, snapshot, revenue_events[])
  → { lines[], holdings[], trace, result_digest }
```

- 순수 함수. 입력 digest가 같으면 `result_digest`가 같다.
- `lines[]`의 키: `(run_id, event_id, party_id, role, bucket, line_seq)`.
- `trace`: 층별 금액, 적용 벡터, 잔여 배분 순서. 기존 `allocation_line.base_breakdown_json`을 대체한다.
- **운영 정산 엔진은 레퍼런스 평가기 라이브러리를 그대로 사용한다.** 공개 검증용 구현과 운영 구현을 분리하지 않는다.

### 5.7 거버넌스 흐름

`DRAFT → COMPILED`(AST → IR → digest) `→` 섀도 시뮬레이션(최근 발행 스냅샷 N건 차액 리포트) `→ APPROVED`(EDITOR + WORK_APPROVER 서명) `→ ACTIVE`(EDITOR와 다른 ACTIVATOR 서명) `→ SUPERSEDED | TERMINATED`.

---

## 6. `constraint` · `grant` · `approval` 접점

세 모듈의 문법 세부와 판정기는 서브프로젝트 2·3에서 상세화한다. 본 절은 IR 형태, 의존, 판정 의미만 확정한다.

### 6.1 `constraint`

```vcrl
constraint "img_nova_L0" version 2 {
  forbid co_occurrence    { parties: [pty_a, pty_b] };
  forbid adjacent         { from: pty_a; to: pty_c; directed: true };
  forbid consecutive_swap { parties: [pty_a, pty_b]; mode: NO_SWAP };
  inherit to PACK { slots: SUBSET; locks: LOCK_ONLY_ADD; duration: WITHIN_RANGE };
}
```

- 제약 파라미터는 party 목록 + `position ANY | FROM | TO` 구조이며 v2.7 `combination_constraint_party` 행과 1:1 대응한다.
- 인접 판정 순서: `(start_ms, stem.sort_order, stem_id)`, 미배정 슬롯은 건너뜀.
- 조합 지문: `sha256(JCS(combination_manifest))`. 유일성 범위 `PACK | FAN_PACK`(기본 PACK), 충돌 시 `CONSTRAINT_IDENTITY_COLLISION`.
- 계승 연산자: `SUBSET | LE | GE | SUPERSET | WITHIN_RANGE | LOCK_ONLY_ADD | EQUAL` (v2.7 `inheritance_rule`).

### 6.2 `grant`

- 요구사항 `Requirement(asset, right_type, scope)` 간 AND, 동일 요구를 충족하는 대체 허락 간 OR.
- 범위 합성: `grant ⊓ stamp_clause ⊓ ops` (meet만). 부정 우선(deny-overrides), 의무 합집합, 범위 확대 시 `GRANT_SCOPE_WIDENING`.
- 결과: `PERMIT | PERMIT_WITH_OBLIGATION | DENY | REVIEW_REQUIRED` + `reason_codes` + `trace`.
- 판정 불가 시 `DENY`(fail-closed). 철회는 `revocation_epoch`로 전파.
- 횟수 제한: 평가 → 원자적 예약 → 실행 → 소비/해제.
- grant의 `action`과 스탬프 조항은 같은 통일 행위 코드 체계를 공유한다. 스탬프 조항은 grant·동의 등급이 허용한 행위의 부분집합이어야 한다.

### 6.3 `approval`

- 승인 체인 선언: 예) `require signer(role: WORK_APPROVER) where bucket = work`.
- SoD 선언: `distinct(EDITOR, ACTIVATOR)`, `distinct(SPACE_OPS, SPACE_SETTLE)`.
- 승인 모드 `AUTO | LABEL | AGENCY`. 플랫폼 개입은 승인 모드가 아니라 `REVIEW_REQUIRED` 경로로 처리한다.
- 승인자는 `eligible_clauses`의 부분집합만 승인할 수 있다(축소 전용).
- 스탬프 조항 `PERSONAL_HOLD | PLATFORM_DISTRIBUTE | LIMITED_USE | COMMERCIAL | DOWNLOAD`(v2.7). `COMMERCIAL`·`DOWNLOAD` 조항은 `export_watermark_id`·`fingerprint_ref` 필수(v2.7 유출 관문). 기간 한정은 `PACK_WINDOW`.
- 스탬프 발행과 `ISSUED` 전환은 단일 트랜잭션.

---

## 7. Rights Manifest 공개 번들

### 7.1 단위와 구성

공개 단위는 **발행된 조합 1건** 및 **정산 1회차**다.

```
manifest/
  manifest.json      { vcrl, subject, as_of, known_at,
                       parts: [{ module, id, version, digest, public_digest }],
                       result_digest, attestations[] }
  facts.ir.json      공개본(커밋먼트 치환)
  constraint.ir.json · grant.ir.json · approval.ir.json · allocation.ir.json
  snapshot.json      u 벡터, combination_manifest, 지문
  vectors.json       역할별 PartyVector, paths
  settlement.json    lines, holdings, trace (금액은 PARTIES 등급)
```

### 7.2 3단계 검증

1. **구조**: JSON 스키마, digest 체인(`depends_on`), 서명.
2. **불변식**: 공개 범위 안의 합계 10000bps, `Σ amount = R`, 커버리지.
3. **재계산**: 레퍼런스 평가기 재실행 → `result_digest` 대조. 당사자는 salt로 커밋먼트를 열어 자기 몫까지 재계산.

### 7.3 공개 채널

- 파트너 포털 + API: `GET /manifests/{id}`, `GET /manifests/{id}/verify`.
- digest 블록체인 앵커링은 선택 옵션(후순위).

---

## 8. 외부 어댑터

어댑터는 형식 변환만 수행하고 규칙을 판정하지 않는다.

| 방향 | 표준 | 매핑 |
|---|---|---|
| 입력 | DDEX RIN, MWN/LRAW | → `facts` claim (`ASSERTED` 상태로 진입, 검증 후 `VERIFIED`) |
| 출력 | DDEX ERN | 결과 녹음·Release. ISRC 발급. proprietary namespace에 manifest digest 기재 |
| 입력 | DDEX DSR | → `revenue_event` (매칭·대사 단계 경유) |
| 출력 | ODRL 2.2 | `grant` → Policy/Permission/Duty. 단방향, 손실 항목 명시 |
| 식별자 | ISRC, ISWC, ISNI, IPI | 내부 ID 우선, 외부 ID는 `ids{}` 매핑 |

---

## 9. 정본 결정 (기존 문서 불일치 해소)

| # | 쟁점 | 기존 상태 | 결정 |
|---|---|---|---|
| 1 | 승인 모드 | 스탬프 문서 `AUTO\|LABEL\|SPACE` / v2.7 `AUTO\|LABEL\|AGENCY` | `AUTO\|LABEL\|AGENCY`. 플랫폼 개입은 `REVIEW_REQUIRED` 경로 |
| 2 | 스탬프 조항 | 스탬프 문서 3종 / v2.7 5종(COMMERCIAL·DOWNLOAD 포함) | v2.7 5종 유지. 스탬프 조항은 통일 행위 코드의 부분집합이며, 유출 관문 워터마크가 `COMMERCIAL`·`DOWNLOAD` 스탬프에 의존하므로 스탬프 문서를 v2.7에 맞춰 개정 |
| 3 | 유일성 범위 | 유일키 문서 `CAMPAIGN\|PACK\|FAN_CAMPAIGN` / v2.7 `PACK\|FAN_PACK` | `PACK\|FAN_PACK`, 기본 PACK. `campaign` 참조 전면 폐기, 기간 한정은 `PACK_WINDOW` |
| 4 | 제약 파라미터 | 배열 파라미터 / `combination_constraint_party` 행 | party 목록 + `position ANY\|FROM\|TO` (v2.7 행 모델과 1:1) |
| 5 | VC 상태값 | 4개 / 8개 | v2.7 8개 |
| 6 | 판정 결과·행위 코드 | 3값, `ISSUE`/`PLAY` / 4값, 통일 행위 9종 | 4값(`REVIEW_REQUIRED` 포함), 행위는 v2.7 통일 코드. `ISSUE`/`PLAY`는 매핑표로 흡수 |
| 7 | 실연 풀 기본 모드 | `MEMBER_PCT` / `USAGE_WEIGHTED` / `계약 버킷+HYBRID` | 언어 기본값 없음, mode 명시 필수. 파일럿 템플릿은 `계약 버킷 + HYBRID` |
| 8 | allocation_policy 상태 | `SUPERSEDED` 포함 / `EXPIRED\|TERMINATED` | `DRAFT→COMPILED→APPROVED→ACTIVE→SUPERSEDED\|TERMINATED` |
| 9 | 시간 기준 명칭 | `ASSIGNED_DURATION` / `ASSIGNED_LAYER_MS` | `ASSIGNED_LAYER_MS` |
| 10 | 크레딧 결손 처리 | 제외 후 재정규화+보류 / 자동 재정규화 금지 | 자동 재정규화 금지, 그룹 보류 |
| 11 | 반올림 | 최대 지분자 가산 / 예시상 분할 / `HIERARCHICAL_LRM_V1` 제안 | `HIERARCHICAL_LRM_V1` (5.5) |
| 12 | 예시 비율 | 문서마다 상이 | 규격 문서에 값을 두지 않음. 모든 예시에 "예시 값" 표기 의무 |
| 13 | 스냅샷 원칙 | v2.7 발행 시 스냅샷만 / D02 수정 제안 | `bind.time` 명시. 기본 `ISSUE_TIME`(v2.7 호환), 나머지 선택. D03(모든 그룹 10000bps), D05(`cmo_managed` → `mandate`) 채택 |
| 14 | allocation_line 유일키 | `(event_id, party_id, line_kind)` | `(run_id, event_id, party_id, role, bucket, line_seq)` |

이 결정에 따라 `데이터모델_v2.7.md` 및 개별 설계 문서의 개정이 필요하다. 개정은 서브프로젝트 1의 구현 계획에 포함한다.

---

## 10. 레퍼런스 구현 (서브프로젝트 1 범위)

### 10.1 기술 선택

- **TypeScript(ESM), 런타임 의존성 0, 네이티브 BigInt.** 같은 코드가 백오피스(브라우저), CLI(Node), 운영 정산 엔진에서 동작한다.
- 성능 요구가 생기면 Rust/WASM 포팅을 허용하되, 적합성 스위트 통과로 동등성을 보장한다.

### 10.2 패키지

| 패키지 | 책임 |
|---|---|
| `@vcrl/core` | 타입(Bps, Ratio, Money), Enum 레지스트리, JCS, digest, 커밋먼트, Ed25519 검증, 오류 모델 |
| `@vcrl/parser` | 재귀 하강 파서, 텍스트 → AST → IR, `legacy-v1` 변환기 |
| `@vcrl/facts` | facts 정적 검증, 그래프 투영, 기여 벡터 계산 |
| `@vcrl/allocation` | allocation 정적 검증, 평가기, `HIERARCHICAL_LRM_V1` |
| `vcrl` (CLI) | `compile`, `verify`, `evaluate`, `diff` |

### 10.3 테스트 전략

- **공개 적합성 스위트 `conformance/`**: `(입력 IR, 기대 결과, 기대 digest)` 골든 벡터. 외부 구현도 이 스위트로 검증한다.
- **속성 기반 테스트**: 무작위 facts·정책 생성 → `Σ amount = R`, 벡터 합 = 1, 결정성(같은 입력 → 같은 digest), 공백·선언 순서 불변성.
- **오류 테스트**: 모든 오류 코드별 최소 재현 케이스.
- **회귀 테스트**: 기존 설계 문서의 계산 예시를 골든 케이스로 편입. 예시가 틀린 경우 문서를 정정한다.

---

## 11. 후속 과제

- 서브프로젝트 1 상세 스펙: 텍스트 문법 EBNF 전체, IR JSON 스키마, 오류 코드 전체 목록.
- 행위 코드 매핑표(`ISSUE`, `PLAY` → v2.7 통일 코드) — 서브프로젝트 2.
- 정책게이팅엔진 미결 4건(오프라인 재생 토큰과 `CONSUME_USE`, VPN·프록시 판정, 미성년 보호 층 위치, explain 공개 범위) — 서브프로젝트 2.
- 파트너 포털에서의 salt 전달 방식과 키 관리 — 서브프로젝트 4.
- 기획설계 20.2 "첫 계약에서 확정할 7개 항목"과 파일럿 계약 데이터 확보 책임자 지정 — 사업 측 결정 사항.

---

## 12. 구현 반영 사항 (계획 1-A, 레퍼런스 구현 `03_구현문서_코드/vcrl`)

1. **패키지 구성**: 10.2의 다중 패키지 대신 단일 패키지 `vcrl`에 subpath export(`vcrl/core`, `vcrl/facts`)를 둔다. 외부 배포 시점에 분리한다.
2. **Enum 레지스트리 추가 항목**: `module`, `party_kind`, `voice_kind`, `performer_role`, `mandate_right`(`MASTER|WORK|PERFORMER`), `attestation_role`(`SPACE_OPS`, `SPACE_SETTLE` 포함). 정본은 `src/core/enums.ts`.
3. **IR 수치 표기**: 봉투의 `version`도 문자열이다(`"1"`). 유리수는 기약분수 `"n/d"`(정수도 `"1/1"`).
4. **의존 순환**: 의존은 낮은 rank로만 허용하므로 순환은 `CORE_DEP_DIRECTION`으로 보고한다. `CORE_DEP_CYCLE`은 두지 않는다.
5. **오류 코드 정본**: `spec/error-codes.md`. `FACTS_DUPLICATE_ID`, `FACTS_UNKNOWN_ENTITY`, `FACTS_EDGE_KIND`, `FACTS_USAGE_INVALID`, `FACTS_CLAIMANT_DRIFT`(v2.7 `CLAIMANT_DRIFT` 대응)를 추가했다.
6. **claim 그룹 키**: `(source, edge)`, 단 `PERFORMED_BY`는 `(source, edge, performer_role)`. `performer_role`은 `PERFORMED_BY`에 필수다.
7. **기여 벡터 정규화**: 역할별 분모는 그 역할 경로가 있는 스템의 `ASSIGNED_LAYER_MS × 경로 가중치 합`이다. 분쟁 그룹의 몫은 `@hold` 키로 벡터에 남아 합계 1이 유지된다(재정규화 없음).
8. **위임**: `mandate.share`는 위임인이 받을 몫 중 수임인이 수령하는 비율이다. 위임인별·권리별 합은 10000bps 이하. 분쟁 위임의 몫은 `@hold`.
9. **정적 검증 시점**: share 합·위임 불변식은 현재 지식(미대체 레코드) 기준으로 모든 유효기간 경계 시점에서 검사한다.
10. **알 수 없는 키**: 봉투와 facts의 모든 객체에서 JSON Schema가 `additionalProperties: false`로 막는 키는 코드 검증기도 `CORE_TYPE_ERROR`("unknown key")로 거부한다.
11. **facts 공개본의 기본 등급(3.4 명확화)**: claim·mandate에 `visibility`가 없으면 문서의 `visibility_default`와 무관하게 `share`·`evidence`는 `PARTIES`로 취급해 커밋먼트로 치환한다. 원문 공개는 항목별로 `visibility: PUBLIC`을 명시해야 한다. 문서 단위 설정 실수로 계약 지분이 노출되는 것을 막기 위한 결정이다.
12. **증명 서명 대상**: 서명 메시지는 `JCS({ctx:"vcrl-attest/1", signer, role, over, alg})`의 UTF-8 바이트다. digest만 서명하면 역할·서명자 바꿔치기가 가능하므로 함께 묶는다. `alg`는 `Ed25519`, 공개키도 Ed25519여야 한다.
13. **분쟁 그룹의 합 검사**: DISPUTED claim이 하나라도 있는 그룹은 10000bps 합 검사에서 제외한다(몫 전체가 `@hold`). 정적 검증과 투영이 같은 규칙을 쓴다.
14. **정규형**: facts의 7개 엔티티 배열은 id 오름차순(코드 유닛 비교)이어야 하며 검증기가 강제한다(`CORE_TYPE_ERROR` "not sorted by id"). id와 참조 필드는 `^[A-Za-z0-9._-]+$`다. `u_digest`는 정규화된 u(스템별 `"n/d"`, 0 제외)에 대한 digest다.
15. **투영 IR 생성**: 투영 IR은 `projectToIr` 하나로 생성한다(입력과 결과의 불일치 방지). `as_of`·`known_at`은 Instant 형식을 검증한다.
16. **위임 수령인의 청구권자 역할**: CMO→`CMO`, AGENCY→`AGENCY`, 그 외 kind는 원래 역할(예: WORK_AUTHOR 몫을 받는 PUBLISHER는 `WORK_AUTHOR`). 가중치 0인 party와 `@hold`는 청구권자가 아니다. 위임인의 위임 합이 10000bps를 넘으면 라우팅은 `FACTS_SUM_MISMATCH`로 실패한다.
17. **공개본 검증 `validatePublicFacts`**: 구조 규칙은 원문 검증과 같고, `claim.share`·`claim.evidence`·`mandate.share`·`party.ids`는 원문 또는 커밋먼트를 허용한다. 합 불변식은 검사하지 않는다. `PRIVATE` party는 id·kind만 공개하고 `ids`는 커밋먼트로 치환한다(salt 경로 `$.body.parties.<id>.ids`).
18. **문자열 인코딩**: 모든 문자열(값과 키)은 올바른 UTF-16이어야 한다. 고립 서로게이트는 `CORE_TYPE_ERROR`로 거부한다.
19. **투영의 빈 역할과 보수적 합 검사**: 경로가 없는 역할은 `vectors`에 키가 없다(빈 벡터로 취급). 사용량이 없는 스템이나 무관한 그룹의 합 불일치도 투영을 막는다(의도된 보수적 규칙).
20. **권리 분쟁 중 팩 활성화 금지(사용자 결정, 2026-09-28)**: 팩이 사용하는 스템의 권리 경로에 `DISPUTED` claim 또는 mandate가 하나라도 유효하면 팩을 활성화할 수 없다. 현재(1-A)는 분쟁 당사자가 청구권자로 도출되지 않아 커버리지 검사(`FACTS_UNCOVERED_CLAIMANT`)로 간접 차단된다. 1-B에서는 활성화 판정에 전용 사유 코드(예: `FACTS_DISPUTE_OPEN`, 분쟁 claim·mandate id 목록 포함)를 추가해 차단 이유를 명시한다. 이미 발행된 조합의 정산은 기존대로 분쟁 몫을 `@hold`(`unallocated_holding`, `RIGHTS_DISPUTE`)로 보류한다.
21. **allocation IR 형태(계획 1-B)**: `body = { scope{pack, events[], currency}, bind{time}, tier1{buckets[{name,bps}], rights}, tier2{split[{name,bps,role,vector}]}, rounding{method,tie} }`. 벡터 식은 `fn` 7종(`graph{role, via_mandate?}`, `contract{party}`, `member_pct`, `performance_pool{mode, fixed?, usage?, featured_weight?}`, `mix{parts[{weight, of}]}`, `cap{max, of}`, `floor_guarantee{min, of}`)이며 비율 인자는 bps 문자열이다. 스키마는 `spec/schema/allocation.ir.schema.json`. 텍스트 문법(5.2의 예시)은 1-C 파서가 이 IR로 변환한다.
22. **실연 풀 의미**: 풀 멤버는 발행 스냅샷 `members`(멤버 비율, 합 1)의 키다. `MEMBER_PCT` = 멤버 비율, `FIXED` = 멤버 균등, `USAGE_WEIGHTED` = `featured_weight·F + (1−featured_weight)·N`(F·N은 투영의 PERFORMER_FEATURED·NON_FEATURED 벡터, 한쪽만 있으면 그 벡터), `HYBRID` = `fixed·FIXED + usage·USAGE_WEIGHTED`.
23. **cap·floor_guarantee**: 반복 수위 채우기로 정확히 계산한다. `@hold`는 제한·보장·재분배 대상이 아니다. floor의 영역은 스냅샷 멤버와 벡터의 party 합집합이다. 조건을 만족하는 분배가 없으면 `ALLOC_INFEASIBLE`.
24. **라인 역할과 순번**: line의 role은 party kind가 CMO·AGENCY면 그 kind, 아니면 버킷 role이다(12.16과 같은 규칙). `line_seq`는 `"1"`이며 역분개(REVERSAL)는 후속 계획에서 다룬다.
25. **보류 규칙**: 벡터의 `@hold` 몫은 `holding(RIGHTS_DISPUTE)`. `integrity = FLAGGED` 이벤트는 tier1은 그대로 기록하고 권리자 풀 전액을 `holding(bucket = tier1.rights, FRAUD_REVIEW)`로 보낸다. pool_line은 0원도 기록하고, 0원 line·holding은 만들지 않는다(trace에는 남는다).
26. **이벤트 정규형**: 이벤트 배열은 id 엄격 오름차순, amount는 양의 정수 문자열(최소 통화 단위), type과 currency는 정책 scope 안이어야 한다(`ALLOC_SCOPE_MISMATCH`).
27. **입력 결합**: `policy.depends_on`에 `vc:facts/<id>@<version>`과 그 facts digest가 있어야 하고, `projection.facts_digest`와 투영 자기 digest가 일치해야 한다(`CORE_DIGEST_MISMATCH`). `bind.time`은 결과에 기록되며, 어떤 시점으로 투영할지는 호출자가 그 규칙대로 `as_of`를 정한다.
28. **안분 커버리지**: 실제 권리자가 있는 투영 역할마다 그 역할을 다루는 버킷이 있어야 한다(`graph(role)`; `performance_pool`·`member_pct`는 실연 두 역할). 없으면 `ALLOC_UNCOVERED_CLAIMANT`.
29. **활성화 판정 `checkActivation`**: 12.20의 규칙을 구현한다. 분쟁 claim·mandate id 목록을 담은 `FACTS_DISPUTE_OPEN`과 청구권자 커버리지 결과를 함께 반환하며, 빈 결과일 때만 활성화할 수 있다. 분쟁 위임은 투영된 권리자에서 출발해 역할별 위임 체인을 최대 2홉까지 따라가며 찾으므로, 체인 중간의 분쟁도 활성화를 막는다.
30. **1-B 범위 밖**: 템플릿 계승(`ALLOC_WIDENING`), 역분개(`REVERSAL`), 다통화 정산, 섀도 시뮬레이션 리포트는 후속 계획에서 다룬다.
31. **출력 순서 규칙**: pool_lines는 이벤트 순서 → tier1 버킷 순서, lines·holdings는 이벤트 순서 → tier2 버킷 순서 → party id 코드 유닛 오름차순, trace는 이벤트 순서 → `tier1`, `tier2`, `bucket:<name>`(split 순서). JS 객체 키 순서에 의존하지 않는다.
32. **버킷 역할 일치**: graph 잎의 역할은 버킷 역할과 같아야 하고, 실연 풀·멤버 비율·실연 graph가 있으면 버킷 역할은 실연 역할이어야 한다. 위임 권리가 없는 역할에 via_mandate는 쓸 수 없다(`CORE_TYPE_ERROR`).
33. **실연 커버리지(권리자 단위, 사용자 결정)**: 투영에서 실연 역할 R로 지분이 있는 실연자는 스냅샷 멤버이거나 R에 도달하는 사용량 기반 실연 소스로 배분되어야 한다. `graph(PERFORMER_X)`는 역할 X에만 도달하고, `USAGE_WEIGHTED`·`HYBRID` 풀은 두 실연 역할 모두에 도달한다. 아니면 `ALLOC_UNCOVERED_CLAIMANT`(detail `R:party`, 역할 → party id 코드 유닛 오름차순, (역할, party) 쌍마다 한 번). 도달 판정은 구조적이다: 정책 작성자가 명시적으로 0으로 둔 가중치(예: HYBRID `usage: "0"`, `featured_weight: "10000"`, mix part `"0"`)는 의도된 정책으로 존중하며 오류로 보지 않는다.
34. **실연 라인 역할(사용자 결정)**: 실연 버킷의 라인 역할은 투영에서 그 권리자가 가진 실연 역할(주실연/부실연)이며, 둘 다이거나 없으면 버킷 역할. CMO·AGENCY kind 규칙이 우선한다.
35. **입력 검증**: 투영의 `as_of`·`known_at`은 Instant, digest류는 digest 형식이어야 한다. 진단 경로는 입력별 접두사(`$.facts`, `$.projection`, `$.snapshot`, `$.events[i]`)를 쓴다.
36. **식별자**: `constructor` 등 Object.prototype 이름도 유효한 id이며, 구현은 키 조회에 소유 속성만 사용한다(`__proto__`만 금지).
