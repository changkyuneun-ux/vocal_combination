# VCRL 시스템 통합 아키텍처 설계

- **문서 상태**: 설계 합의(브레인스토밍 승인) — 구현 계획 수립 전
- **작성일**: 2026-09-29
- **버전**: v1.0
- **상위·참조 문서**:
  - `VCRL_아키텍처_코어규격_설계_v1.0.md` (VCRL 코어 규격, 12절 구현 반영 사항 1~52)
  - `../권리정산인프라_20260927/보컬조합_권리관리_정산인프라_기획설계_v1.0.md` (이하 "기획")
  - `../데이터모델_v2.7.md` (이하 "v2.7")
  - `../검증_승인_권리스탬프_설계.md`, `../정책게이팅엔진_설계.md`, `../라이선스_정산_모니터링_백오피스_개념설계.md`
- **범위**: 레퍼런스 구현이 끝난 VCRL 엔진(`04_구현_소스코드/mdrl`, 서브프로젝트 1)을 보컬조합 권리관리·정산 시스템에 연결하는 통합 아키텍처. 이번 사이클은 설계문서만 작성하며 구현은 로드맵(7.3)의 구현 사이클에서 한다.

---

## 0. 결정 요약

| # | 결정 | 근거 |
|---|---|---|
| 1 | 이번 사이클은 통합 아키텍처 설계문서만 작성한다. | 사용자 결정 (2026-09-29) |
| 2 | 백엔드는 Node·TypeScript **모듈형 모놀리스**. PostgreSQL + 트랜잭션 Outbox + PostgreSQL 기반 작업 큐 + 오브젝트 저장소. VCRL은 라이브러리로 직접 호출한다. | 사용자 결정, 기획 9절(PostgreSQL 원본·Outbox·작업 큐), 인원 가정(백엔드 2명) |
| 3 | **관계형 행이 원본**이고, IR은 결정 시점(컴파일·활성화·발행·정산·공개)마다 행에서 결정적으로 만들어 digest로 **봉인한 스냅샷**이다. 결정에 쓰이는 입력은 봉인된 IR뿐이다. | 사용자 결정 |
| 4 | v2.7 대비 데이터모델 변경은 이 문서에 DDL 수준으로 적는다. `데이터모델_v2.8`에 전체 개정을 반영했다(2026-09-29). | 사용자 결정 |
| 5 | VCRL을 import하는 곳은 `engine-bridge` 모듈 하나뿐이다. 행↔IR 변환·봉인 저장·엔진 호출이 여기 모인다. | 접근안 1 채택 |
| 6 | VCRL 패키지는 백엔드와 같은 저장소의 workspace 패키지로 참조한다. 외부 파트너 검증용으로만 tarball(1-D `npm pack`)을 배포한다. | 코어 규격 12.51 "배포 채널은 시스템 통합에서 정한다" |
| 7 | 기획 1~2단계(권리 코어·정산 MVP)는 상세 설계, 3~4단계와 게이트·스탬프(서브프로젝트 2·3)는 확장 지점과 인터페이스만 정한다. | 범위 결정 |

---

## 1. 용어

| 용어 | 뜻 |
|---|---|
| **IR** (Intermediate Representation, 중간 표현) | 텍스트 문법·화면·DB 행을 엔진이 읽는 하나의 표준 JSON 형식으로 바꾼 것. 숫자는 모두 문자열이며 JSON number를 쓰지 않는다. |
| **facts IR** | 권리 사실 문서. party·work·recording·voice·stem 엔티티와 권리 주장(claim)·위임(mandate). 곡 1개 = facts 문서 1개(이 문서의 결정). |
| **allocation IR** (정책 IR) | 안분 정책 문서. tier1 버킷, tier2 split과 벡터 식, 반올림 규칙, `depends_on`(facts digest 고정). |
| **투영 IR** (`vcrl-projection/1`) | facts를 기준 시점(`as_of`·`known_at`)과 사용량(u)으로 투영한 역할별 기여 벡터와 경로. |
| **결과 IR** (`vcrl-allocation-result/1`) | 안분 평가 결과. `pool_lines`·`lines`·`holdings`·입력 digest·`result_digest`, 봉인 밖의 설명용 `trace`. |
| **digest** | IR을 RFC 8785(JCS)로 정규화한 바이트의 SHA-256. 표기 `vcrl:sha256:<64 hex>`. |
| **봉인(seal)** | 행→IR 변환 결과의 JCS 바이트와 digest를 불변 저장하는 것. 한 번 저장한 봉인은 바꾸지 않는다. |
| **서명(attestation)** | 역할을 가진 서명자가 digest에 대해 남기는 Ed25519 서명(`vcrl-attest/1` 문맥). |
| **기준 시점** | `as_of`(어느 시점의 권리 관계인가)와 `known_at`(그 시점까지 기록된 사실만 쓴다). 이중 시간축의 두 축. |
| **발행 봉인** (`issue_seal`) | 조합 발행 시 동결하는 facts·정책·투영·멤버 비율 digest 묶음. 정산의 유일한 입력. |
| **재고정(rebind)** | 정책 본문은 그대로 두고 `depends_on`의 facts digest만 새 봉인으로 바꾼 정책 버전을 만드는 절차(3.3). |

---

## 2. 아키텍처와 모듈 경계

### 2.1 전체 구조

```
          백오피스·파트너 포털(브라우저)          팬 앱
                    │  HTTPS API                     │
┌───────────────────▼────────────────────────────────▼──────────────────┐
│ Node·TypeScript 백엔드 (모듈형 모놀리스)                                │
│                                                                        │
│  registry ─┐   policy ─┐   issuance ─┐   revenue ─┐   settlement ─┐   │
│            │           │             │            │               │   │
│            └───────────┴──────┬──────┴────────────┴───────────────┘   │
│                               ▼                                        │
│                         engine-bridge ──► vcrl (workspace 패키지)      │
│                               │                                        │
│  ledger ◄── settlement        │           disclosure ◄── settlement    │
│                               ▼                                        │
│  platform: Outbox · 작업 큐 워커 · 오브젝트 저장소 · 감사 로그 · 서명 API │
└───────────────┬──────────────────────────────┬─────────────────────────┘
                ▼                              ▼
          PostgreSQL (원본)          오브젝트 저장소 (봉인 IR 원문, 계약서, 보고서)
                                     KMS/HSM (서명키), 비밀 저장소 (salt)
```

모듈 사이는 함수 인터페이스로 호출한다. 다른 모듈의 테이블을 직접 쓰지 않는다(읽기는 공개된 조회 함수로). 비동기 작업은 상태 변경과 같은 트랜잭션에 Outbox 레코드를 쓰고, 작업 큐 워커가 처리한다.

### 2.2 모듈

| 모듈 | 책임 | 소유 테이블(주요) | VCRL 관련 |
|---|---|---|---|
| `registry` 권리 등록소 | party·work·recording·voice·stem 편집, 권리 주장·위임의 이중 시간축 버전 추가, 분쟁 개시·종결 | `party`, `work`, `recording`, `voice`, `stem`, `right_claim`, `mandate`, `facts_scope`, `dispute` | facts의 원본 행 |
| `policy` 정책 레지스트리 | 안분 정책 작성(폼 또는 VCRL 텍스트), 컴파일, 시뮬레이션, 승인(직무 분리), 활성화, 재고정 | `policy_version`, (폼용) `settlement_policy`·`allocation_policy`·`alloc_layer`·`share_bucket*` | 정책 IR 봉인(S2) |
| `issuance` 발행 | 팩 활성화 검사, 발행 트랜잭션의 스냅샷 동결 | `vocal_pack`, `rights_snapshot`, `snapshot_*`, `issue_seal` | `checkActivation`, 투영 봉인(S3) |
| `revenue` 수익 수집·대사 | 이벤트 멱등 수집, 순매출 확정, 무결성 플래그, 발행 봉인 연결 | `revenue_event` | events 입력 |
| `settlement` 정산 실행 | 배치 선정·그룹화, 평가, 결과 봉인, 재계산 검증, 검토·확정 | `settlement_batch`, `settlement_run`, `settlement_run_event`, `pool_line`, `allocation_line`, `unallocated_holding` | `evaluate`, `verifyAllocationResult` |
| `ledger` 원장·지급 | 확정 라인의 복식 원장 반영, 보류 해제, 지급 지시·PSP 연동, 명세 | `payout_instruction`, 원장 테이블(v2.7·기획) | VCRL 밖 |
| `disclosure` 공개 | Rights Manifest 번들, 공개본(커밋먼트), 플랫폼 서명, `/verify` | `manifest`(3.1 G) | 공개본·검증 |
| `engine-bridge` 엔진 경계 | 행→IR 변환(순수 함수), 봉인 저장소, 엔진 호출, 결과→행 변환 | `sealed_document`, `attestation` | **VCRL을 import하는 유일한 모듈** |
| `platform` 공통 기반 | Outbox, 작업 큐, 오브젝트 저장소 접근, 감사 로그, 서명 API, 권한 | `outbox`, `audit_log`, `user_account`·역할 | — |

### 2.3 `engine-bridge` 인터페이스

다른 모듈은 아래 함수만 호출한다. 모든 함수는 결정적이며 현재 시각을 스스로 읽지 않는다(기준 시점은 인자로 받는다).

```ts
sealFacts(scopeId: string, knownAt: Instant): Promise<Sealed>                     // S1
compilePolicy(source: string, factsDigest: Digest): Promise<Result<Sealed>>        // S2 (텍스트 → IR → 검증 → 봉인)
checkPackActivation(policyDigest: Digest, declared: ClaimantEntry[]): Promise<Diagnostic[]>
sealIssue(input: { snapshotId: string; policyDigest: Digest; usageMs: Record<string, bigint>;
                   members: Record<string, number /* bps */>; issuedAt: Instant }): Promise<IssueSeal>  // S3
evaluateRun(input: { runId: string; issueSeal: IssueSeal; events: RevenueEventRow[] }): Promise<Result<RunResult>> // S4
verifyRun(runId: string): Promise<Diagnostic[]>                                    // 독립 재계산
publicBundle(runId: string): Promise<Sealed>                                        // S5
reverse(runId: string, eventId: string, refund: { id: string; reason: "REFUND" | "CORRECTION" | "FRAUD"; amount: bigint }): Promise<Result<ReversalRun>>  // 원 결과·이전 역분개 봉인을 읽어 vcrl reverse 호출(코어 규격 12.53~12.55)
```

`Sealed = { digest, kind, docId, docVersion, format }`. `RunResult`는 결과 digest와 행으로 변환한 라인·풀·보류 목록이다. `ReversalRun`은 역분개 결과 digest(`vcrl-reversal-result/1`)와 행으로 변환한 음수 풀 라인·REVERSAL 라인·음수 보류 목록이다.

---

## 3. 봉인 모델

### 3.1 원칙

1. 편집은 행에서 한다. 결정(활성화·발행·정산·공개)에 쓰이는 입력은 **봉인된 IR만** 넘긴다.
2. 봉인 = 행→IR 결정적 변환 결과의 JCS 바이트와 digest를 불변 저장.
3. **같은 행 + 같은 기준 시점 → 언제 다시 만들어도 같은 digest.** 변환기 정합성의 판정 기준이다.
4. 봉인은 내용 주소(digest)로만 참조한다. 도메인 행은 digest 컬럼으로 봉인을 가리킨다.

### 3.2 봉인 지점

| # | 시점 | 만드는 IR | 기준 시점 | 서명 |
|---|---|---|---|---|
| S1 | 정책 컴파일·재고정, 팩 활성화 검사 | **facts** (곡 1개 범위: 작품, 녹음, 스템, 보이스, 관련 party, claim, mandate) | `known_at` = 봉인 시각. `recorded_at ≤ known_at`인 행 버전만 포함하고, 그 뒤에 기록된 `superseded_at`은 비운다 | 없음 |
| S2 | 정책 컴파일 | **allocation 정책** (`depends_on`에 S1 digest 고정) | — | EDITOR·WORK_APPROVER(승인), ACTIVATOR(활성화) |
| S3 | 조합 발행 트랜잭션 | **투영 IR**, **멤버 비율**(`{members: …}`), 이를 묶은 `issue_seal` 행 | `as_of` = `known_at` = 발행 시각(9.3-6). 투영은 정책이 고정한 facts 봉인으로 계산하므로 결과는 그 봉인 상태와 같다 | 없음 |
| S4 | 정산 run | **events**(run에 포함된 이벤트 IR 배열), **결과 IR** | S3의 기준 시점 그대로 | 실행 워커(`SPACE_OPS`)가 `result_digest`에 서명, 검증 워커가 재계산 후 서명, 확정자(`SPACE_SETTLE`)가 서명 |
| S5 | 공개 | **facts 공개본**(커밋먼트), Manifest | — | 플랫폼 키 |

### 3.3 facts 변경과 정책 재고정

엔진은 정책의 `depends_on`에 적힌 facts digest와 평가에 쓰는 facts가 정확히 같아야 평가한다. 따라서 claim 하나가 검증돼도 facts digest가 바뀌고, 이후 발행에 쓰려면 정책을 새 facts 봉인에 다시 고정해야 한다.

- **가벼운 재고정**: 정책 본문이 같고, 새 facts로 투영한 청구권자 집합이 직전 고정 facts와 같고(`FACTS_CLAIMANT_DRIFT` 없음), 커버리지 검사와 `checkActivation`이 통과하면, ACTIVATOR 1인 서명으로 새 정책 버전(`rebind_of_version` 기록)을 만들어 즉시 ACTIVE로 바꾼다.
- **전체 재승인**: 청구권자 집합이 바뀌었거나 열린 분쟁이 있으면 F1 전체 절차(승인 → 활성화)를 다시 밟는다.
- 재고정은 발행되지 않은 미래 조합에만 영향을 준다. 이미 발행된 조합은 S3 봉인으로만 정산된다. 발행 후 facts 정정은 정정 흐름(5.7)에서 다룬다.
- `registry`는 facts 범위의 행이 바뀔 때 Outbox로 `facts_changed(scopeId)`를 내보내고, `policy`가 재고정 후보를 계산해 백오피스 작업 목록에 올린다(자동 실행하지 않는다).

### 3.4 결합 시점

MVP의 결합 시점은 `ISSUE_TIME` 하나다(v2.7 호환, 코어 규격 9절 13번). `USAGE_TIME`·`SALE_TIME`·`REPORT_PERIOD`는 정산 run에서 이벤트 시각으로 투영을 새로 만드는 방식이 되며, 확장 지점으로만 둔다(`evaluateRun`의 입력에 `bindTime`과 기준 시점 결정 함수를 추가).

---

## 4. 데이터모델 변경 (v2.7 대비)

### 4.1 표현 규칙

- 행에는 정수를 저장한다: 금액 `BIGINT`(최소 통화 단위, KRW는 원), 비율 `INT` bps(0~10000).
- IR로 바꿀 때 문자열로 만든다(`"10000"`, `"2500"`). 유리수 비율(`"n/d"`)은 행에 저장하지 않는다. 필요하면 봉인 문서에서 읽는다.
- 시각은 `TIMESTAMPTZ`로 저장하고 IR에서는 밀리초 3자리 UTC 문자열(`2026-06-01T00:00:00.000Z`)로 만든다. 저장 정밀도가 마이크로초라도 변환 시 밀리초로 자르며, 같은 밀리초에 두 버전이 기록되지 않도록 `recorded_at`은 서버가 밀리초 단위로 발급한다.
- id는 VCRL id 규칙(`^[A-Za-z0-9._-]+$`, `__proto__` 금지)을 DB `CHECK`로 강제한다.

### 4.2 추가 테이블

```sql
-- facts 범위: 곡 1개 = facts 문서 1개
CREATE TABLE facts_scope (
  facts_scope_id  TEXT PRIMARY KEY CHECK (facts_scope_id ~ '^[A-Za-z0-9._-]+$'),  -- facts IR의 id
  work_id         TEXT NOT NULL REFERENCES work(work_id),
  last_version    INT  NOT NULL DEFAULT 0,       -- S1 봉인 때마다 증가, facts IR의 version
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 보이스(사람·AI 목소리). v2.7에 없는 facts 엔티티
CREATE TABLE voice (
  voice_id        TEXT PRIMARY KEY,
  facts_scope_id  TEXT NOT NULL REFERENCES facts_scope,
  kind            TEXT NOT NULL CHECK (kind IN ('HUMAN','AI'))
);

-- 권리 주장: 이중 시간축, 추가만 허용(UPDATE·DELETE 금지, DB 역할로 강제)
CREATE TABLE right_claim (
  claim_id        TEXT NOT NULL,
  version         INT  NOT NULL,
  facts_scope_id  TEXT NOT NULL REFERENCES facts_scope,
  source_id       TEXT NOT NULL,                 -- stem·voice·recording·work id
  edge            TEXT NOT NULL CHECK (edge IN ('PERFORMED_BY','OWNED_BY','IN_SLOT','OF_RECORDING','PART_OF',
                                               'CONTROLLED_BY','OF_WORK','WRITTEN_BY','CONTRIBUTED_BY')),
  target_id       TEXT NOT NULL,                 -- voice 또는 party id
  share_bps       INT  NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  performer_role  TEXT NULL CHECK (performer_role IN ('FEATURED','NON_FEATURED')),
  role_detail     TEXT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from      TIMESTAMPTZ NOT NULL,
  valid_to        TIMESTAMPTZ NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  superseded_at   TIMESTAMPTZ NULL,              -- 다음 버전 기록 시각(같은 트랜잭션에서 설정하는 유일한 예외 갱신)
  evidence_digest TEXT NULL,                     -- 계약서 등 증빙 원문의 digest(오브젝트 저장소)
  visibility      TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref      TEXT NULL,                     -- 이행 출처(예: rights_image_party:<id>)
  PRIMARY KEY (claim_id, version)
);

-- 위임(신탁·대리): right_claim과 같은 이중 시간축 구조
CREATE TABLE mandate (
  mandate_id      TEXT NOT NULL,
  version         INT  NOT NULL,
  facts_scope_id  TEXT NOT NULL REFERENCES facts_scope,
  from_party_id   TEXT NOT NULL REFERENCES party,
  to_party_id     TEXT NOT NULL REFERENCES party,
  right_kind      TEXT NOT NULL CHECK (right_kind IN ('MASTER','WORK','PERFORMER')),
  share_bps       INT  NOT NULL CHECK (share_bps BETWEEN 0 AND 10000),
  status          TEXT NOT NULL CHECK (status IN ('ASSERTED','VERIFIED','DISPUTED','SUPERSEDED')),
  valid_from      TIMESTAMPTZ NOT NULL,
  valid_to        TIMESTAMPTZ NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  superseded_at   TIMESTAMPTZ NULL,
  visibility      TEXT NULL CHECK (visibility IN ('PUBLIC','PARTIES','PRIVATE')),
  source_ref      TEXT NULL,
  PRIMARY KEY (mandate_id, version)
);

-- 봉인 저장소: 내용 주소, 불변
CREATE TABLE sealed_document (
  digest       TEXT PRIMARY KEY CHECK (digest ~ '^vcrl:sha256:[0-9a-f]{64}$'),
  kind         TEXT NOT NULL CHECK (kind IN ('facts','allocation','projection','members','events',
                                             'allocation_result','public_facts','manifest')),
  doc_id       TEXT NULL,
  doc_version  TEXT NULL,
  format       TEXT NULL,                        -- vcrl-projection/1, vcrl-allocation-result/1 등
  byte_size    BIGINT NOT NULL,
  storage_uri  TEXT NOT NULL,                    -- JCS 바이트 원문(오브젝트 저장소)
  content      JSONB NULL,                       -- 64KiB 이하 문서의 조회용 사본(정본은 storage_uri)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 서명
CREATE TABLE attestation (
  digest       TEXT NOT NULL REFERENCES sealed_document,
  signer_id    TEXT NOT NULL,                    -- user_account id 또는 platform:<key>
  role         TEXT NOT NULL CHECK (role IN ('EDITOR','APPROVER','WORK_APPROVER','ACTIVATOR','SPACE_OPS','SPACE_SETTLE','PLATFORM')),
  key_version  TEXT NOT NULL,
  alg          TEXT NOT NULL DEFAULT 'Ed25519',
  signature    TEXT NOT NULL,
  signed_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (digest, signer_id, role)
);

-- 정책 버전(정본은 봉인된 IR)
CREATE TABLE policy_version (
  policy_id          TEXT NOT NULL,
  version            INT  NOT NULL,
  source_text        TEXT NOT NULL,              -- VCRL 텍스트(폼에서 생성했거나 직접 작성)
  policy_digest      TEXT NULL REFERENCES sealed_document,  -- COMPILED 이후
  facts_digest       TEXT NOT NULL REFERENCES sealed_document,
  status             TEXT NOT NULL CHECK (status IN ('DRAFT','COMPILED','APPROVED','ACTIVE','SUPERSEDED','TERMINATED')),
  rebind_of_version  INT  NULL,                  -- 가벼운 재고정의 원 버전
  pack_id            TEXT NULL REFERENCES vocal_pack,        -- 적용 범위(스코프의 pack)
  created_by         TEXT NOT NULL,
  activated_at       TIMESTAMPTZ NULL,
  PRIMARY KEY (policy_id, version)
);
CREATE UNIQUE INDEX policy_one_active ON policy_version (policy_id) WHERE status = 'ACTIVE';

-- 발행 봉인(S3): 정산의 유일한 입력
CREATE TABLE issue_seal (
  snapshot_id        TEXT PRIMARY KEY REFERENCES rights_snapshot,
  facts_digest       TEXT NOT NULL REFERENCES sealed_document,
  policy_digest      TEXT NOT NULL REFERENCES sealed_document,
  projection_digest  TEXT NOT NULL REFERENCES sealed_document,
  members_digest     TEXT NOT NULL REFERENCES sealed_document,
  as_of              TIMESTAMPTZ NOT NULL,
  known_at           TIMESTAMPTZ NOT NULL
);

-- 정산 run: evaluate 1회 = run 1개
CREATE TABLE settlement_run (
  run_id             TEXT PRIMARY KEY CHECK (run_id ~ '^[A-Za-z0-9._-]+$'),
  batch_id           TEXT NOT NULL REFERENCES settlement_batch,
  policy_digest      TEXT NOT NULL, projection_digest TEXT NOT NULL, members_digest TEXT NOT NULL,
  events_digest      TEXT NULL,  result_digest TEXT NULL REFERENCES sealed_document,
  status             TEXT NOT NULL CHECK (status IN ('PENDING','CALCULATED','VERIFIED','CONFIRMED','FAILED','VOIDED')),
  diagnostics        JSONB NULL,                 -- FAILED일 때 엔진 진단 전문
  executed_by        TEXT NOT NULL, verified_by TEXT NULL, confirmed_by TEXT NULL,
  CHECK (verified_by IS NULL OR verified_by <> executed_by),
  CHECK (confirmed_by IS NULL OR confirmed_by <> executed_by),
  UNIQUE (batch_id, projection_digest, policy_digest, members_digest)
);
CREATE TABLE settlement_run_event (
  run_id    TEXT NOT NULL REFERENCES settlement_run,
  event_id  TEXT NOT NULL REFERENCES revenue_event,
  active    BOOLEAN NOT NULL DEFAULT true,       -- run이 FAILED·VOIDED가 되면 false
  PRIMARY KEY (run_id, event_id)
);
-- 이벤트 하나는 살아 있는 run 하나에만 들어간다(중복 지급 방지)
CREATE UNIQUE INDEX run_event_once ON settlement_run_event (event_id) WHERE active;

-- 공개 Manifest
CREATE TABLE manifest (
  manifest_id     TEXT PRIMARY KEY,
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('ISSUE','RUN','BATCH')),
  subject_id      TEXT NOT NULL,
  bundle_digest   TEXT NOT NULL REFERENCES sealed_document,
  published_at    TIMESTAMPTZ NULL
);
```

`settlement_batch`에는 `batch_manifest_digest TEXT NULL`을 추가한다. 값은 배치에 속한 확정 run의 `result_digest`를 정렬한 배열의 digest다.

### 4.3 변경 테이블

| 테이블 | 변경 | 이유 |
|---|---|---|
| `pool_line` | 고정 3컬럼(`rights_pool_krw`·`platform_krw`·`fan_incentive_krw`) → `(run_id, event_id, bucket, amount_krw)`, PK `(run_id, event_id, bucket)`. 기존 형태는 뷰 `pool_line_v27`로 제공 | VCRL tier1 버킷은 이름이 임의 |
| `allocation_line` | `run_id`, `role`, `bucket`, `line_seq INT` 추가. 유일키 `(run_id, event_id, party_id, role, bucket, line_seq)`. `share_ratio NUMERIC(16,12)` 삭제. `base_breakdown_json`은 결과의 `trace`에서 생성(설명용). `line_kind`·`reversal_of_line_id`는 역분개용으로 유지 | 결과 IR 라인 키와 일치, 비율 손실 방지 |
| `unallocated_holding` | `run_id NULL`, `bucket NULL` 추가. `reason_code`에 `RIGHTS_DISPUTE` 추가 | 엔진 보류(`RIGHTS_DISPUTE`·`FRAUD_REVIEW`)를 그대로 기록 |
| `revenue_event` | `source_system`, `source_event_id`, `source_revision`, `currency CHAR(3)` 추가, UNIQUE `(source_system, source_event_id, source_revision)` | 기획 11절 중복 판정 키, 다통화 확장 |
| `rights_image_party`, `claimant` | 원본에서 **화면용 요약 캐시**로 격하. 발행 봉인의 투영에서 재생성. 드리프트는 `FACTS_CLAIMANT_DRIFT`로 감시 | 원본은 `right_claim`·`mandate` |
| `work.cmo_managed`, `share_bucket.member_source=CMO` | 화면용 요약으로만 유지. 실제 신탁 라우팅은 `mandate` | 코어 규격 9절 D05 |
| `settlement_policy`·`allocation_policy`·`alloc_layer`·`share_bucket*`·`settlement_rule` | 폼 편집용으로 유지. 저장 시 VCRL 텍스트를 생성해 `policy_version.source_text`에 넣는다. tier1 3풀은 VCRL tier1 버킷 `platform`·`rights`·`fan`으로 대응 | 정본은 봉인된 정책 IR |

### 4.4 행 → IR 변환 규칙(요지)

| IR 필드 | 행 출처 | 규칙 |
|---|---|---|
| facts `id`·`version` | `facts_scope.facts_scope_id`, `last_version` | S1마다 버전 증가 |
| `parties[]` | 범위 안 claim·mandate가 참조하는 `party` | `kind` = `party_type` 대응표(구현 사이클에서 확정), id 오름차순 |
| `claims[]` | `right_claim` 중 `recorded_at ≤ known_at`인 버전 | `share` = `share_bps` 문자열, `superseded_at > known_at`이면 비움 |
| `mandates[]` | `mandate` | claim과 같은 규칙 |
| 정책 IR | `policy_version.source_text` | `compileAllocation` 결과 그대로 |
| 사용량 u | `snapshot_stem_assignment.duration_ms` | 스템별 합계 문자열 |
| members | `snapshot_member_pct.pct_bps` | `{members: {party: "n/d"}}` (bps → 유리수, 합 1, 0 bps 멤버 제외) |
| events | `revenue_event` | `amount` = `net_amount_krw`, `type` = `PURCHASE→PRIMARY`, `RESALE→RESALE`, `integrity` = `FLAGGED→FLAGGED`, 그 밖 `CLEAR`. `ISSUE`(금액 0)는 제외, `REFUND_*`는 5.7 |

---

## 5. 핵심 흐름

### 5.1 F1 정책 작성 → 활성화

1. EDITOR가 폼 또는 VCRL 텍스트로 편집 → `DRAFT`.
2. 컴파일: `sealFacts(scope, now)`(S1) → 텍스트에 `uses facts … digest` 고정 → `compilePolicy` → `COMPILED`(S2).
3. 시뮬레이션 리포트: 최근 발행 봉인 N건과 그 이벤트를 새 정책으로 평가해 현 정책 결과와 비교(vcrl `shadowReport`, 코어 규격 12.56).
4. 승인: EDITOR와 다른 WORK_APPROVER가 정책 digest에 서명 → `APPROVED`.
5. 활성화: 승인자와 다른 ACTIVATOR가 `checkActivation` 통과 후 서명 → `ACTIVE`. 이전 ACTIVE는 `SUPERSEDED`. 활성화 이후 발행되는 조합부터 적용(소급 없음).
6. facts만 바뀌면 3.3 재고정.

### 5.2 F2 팩 활성화

팩은 활성 정책이 있고 `checkPackActivation`(선언 청구권자 = `rights_image_party` 캐시 vs 투영, 위임 경로까지 분쟁 없음)이 통과해야 활성화된다. `FACTS_DISPUTE_OPEN`이면 거부(코어 규격 12.20).

### 5.3 F3 조합 발행

v2.7 발행 원자 트랜잭션(스냅샷 동결 → 유일키 ISSUED → 스탬프 → 조합 ISSUED → `revenue_event(ISSUE)`)에 한 단계를 더한다.

- 발행은 **정책이 고정한 facts 봉인**을 쓴다(현재 행을 다시 읽지 않는다). 팬 발행은 실시간이라 승인을 기다릴 수 없기 때문이다.
- `sealIssue`: 사용량(`snapshot_stem_assignment` ms)과 멤버 비율로 투영을 계산해 봉인하고 `issue_seal`을 INSERT(S3). `as_of` = `known_at` = 발행 시각(9.3-6). facts는 정책이 고정한 봉인이므로 발행 시각을 `known_at`으로 써도 봉인 이후의 행은 들어가지 않는다.
- 투영은 곡 1개 규모에서 수 ms이며 게이트 p95(100/500ms, 기획 16절) 안이다. 투영 IR에는 `as_of`(발행 시각)가 들어가므로 투영 digest는 발행마다 다르고 봉인 자체는 재사용되지 않는다. 초과가 실측되면 봉인 전 단계의 계산 결과(벡터·경로)를 `(facts_digest, u_digest)` 키로 캐시하는 방안을 검토한다.

### 5.4 F4 수익 유입

어댑터(앱 결제, PSP, 이후 DSR)가 `revenue_event`를 중복 판정 키로 멱등 기록한다. `vc_id → rights_snapshot → issue_seal`로 연결한다. 연결할 발행 봉인이 없으면 `unallocated_holding(NO_ACTIVE_POLICY)`.

### 5.5 F5 정산 배치

1. 배치 `RUNNING`: 기간 내 미배정 이벤트를 발행 봉인별로 그룹화(같은 정책·투영·멤버여야 한 번에 평가 가능). 그룹 1개 = `settlement_run` 1개(`PENDING`).
2. 정산 워커(작업 큐, 병렬): events 봉인 → `evaluateRun` → 결과 봉인 → `pool_line`·`allocation_line`·`unallocated_holding` INSERT를 run 단위 트랜잭션으로 → `CALCULATED`. 엔진 진단이면 `FAILED` + 진단 저장, 해당 이벤트는 `active=false`로 풀려 다음 배치로.
3. 검증 워커(실행 워커와 다른 서비스 신원): `verifyRun` = `verifyAllocationResult` 재계산 → 불일치 0이면 서명 후 `VERIFIED`, 불일치면 `VOIDED` + 경보.
4. 검토·확정: 사람(`SPACE_SETTLE`, 실행자와 다름)이 배치 단위로 확정 → 모든 run `CONFIRMED`, `batch_manifest_digest` 기록 → `ledger`로 Outbox.
5. **규모 위험**: 조합마다 투영이 달라 run 수가 이벤트가 있는 조합 수에 비례한다(기획 16절의 1.5억 라인 경고와 같은 문제). MVP는 워커 병렬화와 결과 오브젝트 저장으로 대응하고, 정산 그룹 단위 집계는 3단계 실측 후 결정한다(8절 미결).

### 5.6 F6 분쟁

1. 분쟁 개시 → 해당 claim의 새 버전 `DISPUTED`(registry) → Outbox `dispute_opened(scope)` → 영향 팩 자동 일시정지(새 발행 차단).
2. 이미 발행된 조합은 봉인 facts에 분쟁이 없어 엔진이 보류하지 않는다. 그래서 **시스템 정산 게이트**가 막는다: 배치 그룹화 단계에서 열린 분쟁이 걸린 facts 범위의 이벤트는 run에 넣지 않고, 순매출 전액을 `unallocated_holding(RIGHTS_DISPUTE, run_id NULL)`로 보류한다(tier1 분리는 엔진 평가가 필요하므로 분쟁 종결 후 평가 때 한다). 자동 재정규화는 하지 않는다(기획 원칙).
3. 분쟁 종결:
   - 원 권리 관계 유지 → 보류 이벤트를 봉인 입력 그대로 다음 배치에서 평가하고 보류 해제.
   - 권리 관계 변경 → 5.7 정정 흐름.

### 5.7 F7 정정·환불

- 인터페이스: `engine-bridge.reverse`는 원 run의 결과 봉인과 같은 이벤트의 이전 역분개 봉인들을 읽어 vcrl `reverse`를 호출하고, 결과(`vcrl-reversal-result/1`)를 봉인해 `allocation_line(line_kind=REVERSAL, line_seq=k+1, reversal_of_line_id=원 라인)`·음수 `pool_line`·음수 `unallocated_holding`으로 기록한다. 부분 환불은 누적 상한까지(엔진이 `REV_EXCEEDS_REMAINING`으로 강제).
- 확정 전 환불은 이벤트를 run에서 제외하고(run을 다시 평가), 확정 후 환불·정정은 역분개로 처리한다.
- 엔진 역분개는 1-E에서 구현했다.
- 호출자 책임(엔진은 priors의 순서·일관성만 강제하고 완전성은 알 수 없다):
  - I-2는 `(original_run_id, event_id)`마다 역분개를 잠그고(동시 호출 방지), 그 이벤트의 이전 역분개 봉인을 빠짐없이 순서대로 `priors`로 넘긴다.
  - `(original_run_id, event_id, sequence)`에 유일 제약을 둔다.
  - 환불 id(`refund.id`)는 유일하다(멱등 키). 엔진도 같은 체인 안의 중복 id는 `REV_CHAIN_BROKEN`으로 거부한다.
  - 역분개 `run_id`는 원 `run_id`와 달라야 한다(`pool_line` PK 충돌 방지).
  - 이미 해제·지급된 보류를 역분개하면 음수 보류가 실제와 맞지 않는다 — 처리 규칙은 I-2 설계에서 정한다.

### 5.8 F8 공개

확정된 run·배치에 대해 Manifest 번들을 만든다: facts 공개본(커밋먼트), 정책 IR, 투영 IR, 결과 IR(`result_digest`, 봉인 밖 `trace`), 서명. 당사자별 salt는 비밀 저장소에 둔다(전달 방식은 서브프로젝트 4). `/verify`는 같은 `vcrl` 코드로 재계산한다(코어 규격 7.2).

---

## 6. 운영

### 6.1 결정성과 재실행

- `engine-bridge` 변환기는 순수 함수다. 현재 시각·난수·DB 정렬 순서에 의존하지 않고 id를 명시적으로 정렬한다(코드 유닛 비교). 기준 시점은 인자로 받는다.
- 같은 run을 다시 실행하면 같은 `result_digest`가 나와야 한다. 다르면 경보 후 run을 `VOIDED`.

### 6.2 멱등성

| 대상 | 키 |
|---|---|
| 수익 이벤트 | `(source_system, source_event_id, source_revision)` |
| 정산 run | `(batch_id, policy_digest, projection_digest, members_digest)` |
| 이벤트 배정 | `run_event_once` 부분 유일 인덱스 |
| 원장 반영 | `run_id` |
| 지급 | PSP 멱등키(기획 12절) |
| 봉인 | `digest` 기본키(중복 저장 무해) |

### 6.3 비동기와 장애

- 상태 변경과 Outbox 기록은 같은 트랜잭션. 작업 큐는 PostgreSQL 기반(graphile-worker·pg-boss 등, 구현 사이클에서 선택).
- 워커 작업은 재시도 안전해야 한다. 정산 워커 중단 시 봉인은 불변이고 라인 기록은 run 단위 트랜잭션이라 부분 기록이 남지 않는다.

### 6.4 키 관리

- 사용자 키(승인자·활성화 담당자·확정자 개인), 플랫폼 키(검증 워커·Manifest).
- 개인키는 KMS/HSM에 두고 서명 API만 노출한다. 백엔드 프로세스는 개인키를 읽지 않는다.
- salt는 party별로 비밀 저장소에 둔다. 키 교체·폐기는 `attestation.key_version`으로 추적한다.

### 6.5 권한과 직무 분리

| 역할 | 행위 | 겸직 금지 |
|---|---|---|
| EDITOR | 정책 편집·컴파일 | WORK_APPROVER, ACTIVATOR |
| WORK_APPROVER | 정책 승인 | EDITOR |
| ACTIVATOR | 정책 활성화·재고정 | EDITOR, WORK_APPROVER |
| SPACE_OPS | 배치 실행 | SPACE_SETTLE |
| 검증 워커 | 재계산 검증 | 실행 워커와 다른 서비스 신원 |
| SPACE_SETTLE | 배치 확정 | SPACE_OPS |

서명 시점에 서비스 검사와 DB `CHECK`·트리거로 이중 강제한다.

### 6.6 관측

run별 소요 시간·결과 digest, 사유별 보류 금액, 재계산 불일치 건수(0 목표), `FACTS_CLAIMANT_DRIFT` 경보, 분쟁 일시정지 팩 수, 재고정 대기 정책 수. 모든 봉인·서명 이벤트는 `audit_log`에 남긴다.

---

## 7. 테스트 · 이행 · 로드맵

### 7.1 테스트

1. **변환기 golden**: 픽스처 행 → IR → VCRL 적합성 케이스(`conformance/`)와 digest 일치.
2. **속성 테스트**: 행 삽입 순서·트랜잭션 순서를 바꿔도 digest 동일.
3. **흐름 통합(실제 PostgreSQL)**: F1~F6 시나리오, 직무 분리 위반 거부, 분쟁 중 팩 활성화 거부.
4. **재계산 감사**: 확정 run 전수를 독립 검증기로 재계산, 불일치 0.
5. **기획 출시 기준**: golden dataset, 보존식(Σ amount = R), 중복 지급 0, 재실행 동일성.

### 7.2 이행 (기획 17절 순서)

1. 테이블 추가(4.2) 및 변경(4.3).
2. v2.7 `rights_image_party`·크레딧에서 `right_claim`·`mandate` 초기 버전 생성(`source_ref`에 출처).
3. 섀도 계산: 기존 v2.7 정산과 VCRL 결과를 병행 비교, 차이 분류.
4. 신규 팩부터 VCRL 정산 활성화. 기존 발행분의 봉인은 다시 쓰지 않는다.

### 7.3 로드맵 (구현 사이클)

| 사이클 | 내용 | 기획 단계 |
|---|---|---|
| I-1 권리 코어 PoC | `registry`, `engine-bridge`, `policy`, `issuance`, 봉인 저장소, 서명 API(개발용 키). 곡 1개·1만 조합 재현 | 1단계 |
| 엔진 선행 | 역분개(REVERSAL), 섀도 시뮬레이션 리포트 — 완료(1-E) | — |
| I-2 정산 MVP | `revenue`, `settlement`, `ledger`, 지급 연동, 명세, F7 | 2단계 |
| I-3 공개·파트너 포털 | `disclosure`, salt 전달, 키 관리(서브프로젝트 4와 합류) | — |
| 이후 | 다중 채널(DSR 어댑터·다통화), 게이트·스탬프(서브프로젝트 2·3), B2B | 3~4단계 |

---

## 8. 미결 사항

| 항목 | 결정 시점 |
|---|---|
| ~~작업 큐 제품~~ **pg-boss로 결정**(10.2-1) | — |
| ~~`party_type` ↔ VCRL `party_kind` 대응표~~ **확정**(9.3, 데이터모델 v2.8 `party`) | — |
| 정산 그룹 단위 집계 전략(run 수 폭증 대응) | 3단계 성능 실측 후 |
| 비`ISSUE_TIME` 결합 시점의 기준 시점 결정 규칙 | 해당 채널 도입 시 |
| 시스템 판정 보류 코드(v2.7 7종)와 기획 예외 코드·엔진 보류 코드의 통합 목록 | I-2 구현 계획 |
| 스탬프 조항·승인 모드 어휘의 문서 개정(코어 규격 9절) | 서브프로젝트 2·3 |
| 사업 측 결정: 첫 계약 7개 항목, 파일럿 데이터 확보 책임자(기획 20.2) | 파일럿 전 |
| ~~`데이터모델_v2.8` 전체 개정~~ **완료**(`../데이터모델_v2.8.md`, 2026-09-29) | — |

---

## 9. I-1 권리 코어 PoC 설계 결정 (2026-09-29)

### 9.1 형태와 범위

- **형태**: 모듈 + 최소 HTTP API + 시나리오 러너. UI 없음.
- **포함**: `registry`, `engine-bridge`, `policy`, `issuance`, `platform`(마이그레이션·감사 로그·Outbox 인프로세스 폴러·개발용 서명 API·헤더 기반 개발용 신원), 최소 HTTP API, 시나리오 러너(합성 곡 1개·1만 조합).
- **제외**: 수익·정산·원장·공개, 동의·스탬프·게이트, 유일키 예약, 실제 인증·S3·KMS, UI, 작업 큐 제품 선택(I-2).
- **데이터**: 실제 계약 데이터 확보 전이므로 VCRL 적합성 케이스 `nova-debut-01`을 확장한 합성 곡으로 진행한다. 실제 곡은 픽스처 교체로 같은 러너에 넣는다.

### 9.2 기술 스택과 저장소 구조

- Node 24(TypeScript 직접 실행) + Fastify + node-postgres(`pg`) + 번호 붙은 SQL 마이그레이션 파일과 작은 실행기 + 직접 작성한 SQL. ORM은 쓰지 않는다(추가 전용·이중 시간축·부분 인덱스를 SQL 그대로 드러내기 위해).
- `04_구현_소스코드/`를 npm workspaces 루트(`vcrl`, `rights-core`)로 하고, `rights-core`는 `vcrl`의 빌드된 `dist`를 workspace 의존성으로 쓴다(1-D 배포 경로 검증).
- 개발·테스트 DB는 Docker Compose PostgreSQL 17. 테스트는 파일마다 템플릿 DB를 복제한 새 DB를 쓴다.
- 계층: `routes`(입력 검증·신원) → `service`(업무 규칙·직무 분리·트랜잭션) → `repo`(SQL). 서비스 함수는 트랜잭션 핸들과 `Clock`을 인자로 받는다. `vcrl` import는 `engine-bridge`만 한다(테스트로 강제).

### 9.3 세부 결정

1. **facts 버전 번호**: facts IR `version` = 기준 시점까지 해당 범위에서 기록 변화(`recorded_at`·`superseded_at`)가 일어난 서로 다른 시각의 개수. 봉인마다 1씩 올리면 같은 행에서도 digest가 달라져 3.1 원칙 3이 깨지기 때문이다. 변화가 없는 두 기준 시점은 같은 digest가 되어 봉인을 재사용한다. `facts_scope.last_version`은 조회용 캐시다.
2. **정책의 facts 고정은 IR에서**: 작성자 텍스트의 `uses facts … digest` 줄은 신뢰하지 않는다. 컴파일 시 텍스트 → IR → `depends_on`을 현재 facts 봉인으로 덮어씀 → 검증 → 봉인. 저장하는 `source_text`는 VCRL 포매터의 정규 텍스트다(`parse(format(ir)) = ir`).
3. **`party_type` → `party_kind`**: `LABEL`·`AGENCY`·`PUBLISHER`·`CMO`·`AUTHOR`·`SESSION`·`AI_PROVIDER`는 같은 이름, `ARTIST`·`MEMBER` → `PERFORMER`, `FAN`·`PLATFORM`은 facts 불가. v2.8 `party_type`에 `AUTHOR`를 추가했다.
4. **권리 주장 엣지**: `right_claim.edge`는 VCRL의 지분 엣지 5종만 허용한다. 구조 관계는 `stem.slot_id`·`stem.recording_id`·`recording_version.work_id` 컬럼에서 facts 엔티티 필드로 만든다(v2.8 정정).
5. **facts 범위의 구성**: 범위의 작품 1개, 그 작품의 `recording_version` 전부, 그 녹음들의 스템 전부, 범위의 `voice`, 범위의 claim·mandate(기준 시점까지 기록된 버전), 그리고 claim 대상·mandate 양끝으로 참조되는 party. 외부 식별자는 `party.isni`→`ids.isni`, `party.ipi_no`→`ids.ipi`, `work.iswc`→`ids.iswc`, `recording_version.isrc`→`ids.isrc`(값이 있을 때만).
6. **발행 투영의 기준 시점**: `as_of = known_at = 발행 시각`. 발행 시각은 항상 facts 봉인 시각보다 늦으므로 봉인된 facts 상태와 같은 결과이며, facts 봉인 시각을 따로 저장하지 않는다.
7. **분쟁 동기 가드**: 발행 트랜잭션은 팩 상태와 별도로 해당 facts 범위에 열린 분쟁이 있는지 직접 확인해 거부한다(Outbox 일시정지 처리 전의 틈을 막는다).
8. **추가 전용 보호**: 트리거(UPDATE·DELETE 거부, `superseded_at`은 NULL에서 값으로 한 번, 그리고 후속 버전과 함께만 설정 — 같은 id에 `recorded_at = superseded_at`인 행이 있는지 커밋 시점에 검사하는 지연 제약 트리거, 마이그레이션 0008)와 앱 DB 역할 권한(INSERT·SELECT와 명시된 컬럼 UPDATE만) 두 겹.
9. **오류 → HTTP**: VCRL 진단 422(진단 목록 그대로), 직무 분리 403, 상태 충돌·분쟁 409, 없음 404.
10. **facts 봉인 울타리**: 같은 행·같은 `known_at` → 같은 digest(3.1-3)는 `known_at` 이전 시각을 잡고 아직 커밋하지 않은 쓰기가 봉인 뒤에 커밋되면 깨진다. 그래서 `facts_scope.sealed_through`를 둔다. 범위에 쓰는 쪽(claim·mandate 기록, voice·stem·recording 등록, 분쟁 개시·종결)은 범위 행을 `FOR SHARE`로 잠근 뒤 자기 시각(`recorded_at`·`created_at`·`opened_at`)이 `sealed_through`보다 엄격히 늦어야 쓰고, 아니면 409 `FACTS_SEALED_THROUGH`로 거부된다. `sealFacts`는 행을 읽기 전에 범위 행을 `FOR UPDATE`로 잠가 진행 중인 쓰기의 커밋을 기다린 뒤 읽고, `sealed_through = GREATEST(sealed_through, known_at)`으로 올린다. 잠금 순서는 팩 → 범위다(정책 컴파일·재고정·분쟁 개시 공통). 교착·직렬화 실패는 409 `RETRY`로 응답한다. 한 트랜잭션에서 같은 범위에 쓴 뒤 봉인하지 않는다(`FOR SHARE` → `FOR UPDATE` 승격은 교착할 수 있고 409 `RETRY`로 드러난다). DB 시계보다 늦은 `known_at`은 울타리를 앞당기므로 422 `INVALID_INSTANT`로 거부한다.

### 9.4 완료 기준

- VCRL 적합성 `facts/001-basic`을 행으로 등록해 봉인한 digest가 적합성 facts의 digest와 같다.
- 등록 순서를 섞어도 digest가 같다.
- 시나리오 러너가 합성 곡 1개로 1만 조합을 발행하고, 모든 발행 봉인을 행에서 다시 만들어 불일치 0.
- 로컬 발행 지연 p95 100ms 이하(넘으면 원인을 리포트에 기록하고 5.3의 계산 캐시를 검토).
- 분쟁 → 자동 일시정지·발행 거부 → 종결 → 가벼운 재고정 → 재활성화 → 발행 시나리오 통과.

### 9.5 I-1 PoC 결과 (2026-09-29)

| 항목 | 결과 |
|---|---|
| 적합성 facts/001-basic 행 등록 → 봉인 digest 일치 | 통과 |
| 등록 순서 무관(시드 3개) | 통과 |
| 1만 조합 발행 | 10000건, 총 35664ms |
| 발행 지연 p50 / p95 / max | 3.49 / 4.4 / 19.93 ms (목표 p95 ≤ 100ms: 충족) |
| 서로 다른 투영 digest / 서로 다른 벡터·경로 조합 | 10000개 / 81개 |
| 발행 봉인 전수 재도출 불일치 | 0건 |
| facts 재봉인 대조 | 통과 |
| 분쟁 → 일시정지 → 종결 → 재고정 → 재발행 | 통과 |
| 실행 환경 | macOS 26.6.2 · Node v26.7.0 · PostgreSQL 17.11 (Docker, Debian 17.11-1.pgdg13+2) |
| 최종 수정 후 재실행(봉인 울타리 등 반영) | 10000건, 총 36156ms, p50 / p95 / max 3.58 / 4.21 / 24.6 ms, 불일치 0, 분쟁 흐름 통과 |

- 측정 조건: 연결 1개로 발행을 순차 실행했고, 로컬 Docker PostgreSQL이다. 동시 발행·네트워크 지연·운영 DB 규모는 반영하지 않았으므로 p95는 게이트 판단의 하한 참고값이다.
- 적합성 digest 일치·등록 순서 무관 두 행의 근거는 `rights-core/test/engine-bridge/facts.test.ts`(`golden: …`, `property: registration order does not change the digest`)다. 나머지 행은 `npm run scenario`(`src/scenario/run.ts`) 출력이다.

### 9.6 I-2 선행 과제

I-1은 PoC라 다음을 의도적으로 남겼다. I-2 착수 전에 해소한다.

1. **KMS 서명**: `dev_signing_key`를 없애고 KMS/HSM으로 서명한다. 지금은 앱 역할 `rc_app`이 `private_pem`을 읽을 수 있어 어떤 사용자로도 서명할 수 있다.
2. **DB 차원의 직무 분리**: `rc_app`이 `attestation`·`portal_role`·`user_account`에 직접 INSERT할 수 있다. 서명·역할 부여는 별도 DB 역할 또는 SECURITY DEFINER 함수로만 하게 하고, 서명자·역할 제약을 DB에서 검사한다.
3. **Outbox 재시도·dead-letter**: 지금 폴러는 실패한 배치를 로그만 남기고 다음 주기에 다시 시도한다. 시도 횟수·백오프·dead-letter 테이블과 경보가 필요하다.
4. **`dispute_closed` 핸들러**: 종결 이벤트는 쌓이기만 한다. 재고정 후보 계산·백오피스 작업 목록(3.3)으로 연결한다.
5. **봉인 조회 인증**: `GET /seals/:digest`·`GET /issues/:id/audit`은 신원 없이 읽고 PRIVATE claim이 든 facts도 돌려준다(서버는 127.0.0.1 바인딩). 인증과 가시성 필터(공개본 S5)를 붙인다.
6. **울타리·직무 분리를 DB 트리거로**: 봉인 울타리와 서명 역할 검사는 서비스 코드에만 있다. `rc_app`은 `right_claim`·`mandate`에 과거 시각의 행을 직접 INSERT할 수 있으므로, `sealed_through` 검사와 직무 분리 검사를 트리거로 옮긴다.

---

## 10. I-2a 정산 코어 설계 결정 (2026-09-30)

### 10.1 범위

- I-2를 셋으로 나눈다: **I-2a 정산 코어**(수익 수집, 정산 배치·run, 역분개 연결), **I-2b 원장·지급**(복식 원장, 보류 해제, 지급 지시, 최소지급 이월, 원천징수, PSP, 명세), **I-2c 운영 보강**(9.6: KMS, DB 트리거 직무 분리·봉인 시점 차단, Outbox 재시도·실패 격리, 봉인 조회 인증).
- I-2a 포함: `revenue`(멱등 수집, 환불 한도), `settlement`(배치 생성·그룹화·건너뜀 기록, `settle-run`·`verify-run` 작업, 배치 확정), 역분개(`refund-recorded`·`reverse-event` 작업), 작업 큐, 최소 HTTP API, 시나리오 확장.
- I-2a 제외: 원장·보류 해제·지급·세무·명세(I-2b), 9.6 전체(I-2c), 수동 정정(`CORRECTION`)·부정 확정(`FRAUD`) 역분개 API(엔진은 지원, 시스템 API는 I-2b), `USAGE_TIME` 등 비`ISSUE_TIME` 결합.

### 10.2 결정

1. **작업 큐 = pg-boss**(8절 미결 해소). 스키마 `pgboss`는 템플릿 DB를 만들 때 소유자 역할로 설치하고 `rc_app`에 권한을 준다. 작업은 상태 변경과 **같은 트랜잭션**에서 보낸다(pg-boss `send`의 사용자 실행기 옵션, 지원되지 않으면 Outbox→작업 중계). 작업 이름: `settle-run`, `verify-run`, `refund-recorded`, `reverse-event`. 처리기는 순수한 서비스 함수이고 각자 트랜잭션을 연다(재시도 안전: 상태를 잠그고 확인한 뒤 이미 처리됐으면 아무것도 하지 않는다). 기존 Outbox 폴러는 그대로 두고 전환은 I-2c에서 한다.
2. **수익 이벤트**: `PURCHASE`(엔진 `PRIMARY`)·`RESALE`·`REFUND`, 통화 KRW만, 금액은 양의 정수(환불도 양수, 방향은 유형이 나타낸다). 멱등 키 `(source_system, source_event_id, source_revision)` — 같은 키·같은 내용이면 기존 id를 돌려주고, 같은 키·다른 내용이면 409 `IDEMPOTENCY_MISMATCH`. 환불은 `related_event_id`로 원 구매·재판매를 가리키고, 원 이벤트별 누적 환불 ≤ 원 금액(아니면 422 `REFUND_EXCEEDS_ORIGINAL`). 같은 원 이벤트의 환불은 트랜잭션 advisory lock으로 직렬화한다. **`source_revision`**: 대체(supersede) 규칙은 I-2b에서 정한다. 그 전에는 같은 `(source_system, source_event_id)`의 다른 revision이 이미 있으면 422 `REVISION_UNSUPPORTED`로 거부한다(두 revision이 모두 매출로 잡히는 이중 계상 방지). 판단은 revision을 뺀 source 키 advisory lock 아래에서 하고, 같은 키·같은 revision 재전송은 그대로 `created: false`다. 수집 함수는 환불 후속 처리 훅(`onRefund`)을 **필수 인자**로 받는다(생략하면 `refund-recorded`가 조용히 빠지므로, 필요 없는 호출자는 `noRefundHook`을 명시한다). HTTP 조립(`http/server.ts`)이 `refundHook(jobs)`를 넘기고, `revenue`는 `settlement`를 import하지 않는다(아키텍처 테스트).
3. **배치 생성**(`SPACE_OPS`): 기간 `[start, end)`의 구매·재판매 중 살아 있는 run에 속하지 않은 이벤트를 고른다. 순액 = 원 금액 − 그때까지 기록된 환불 합. 순액 0 → 건너뜀 `FULLY_REFUNDED`, `vc_id`의 발행 봉인 없음 → `NO_ISSUE_SEAL`, 그 facts 범위에 열린 분쟁 → `FACTS_DISPUTE_OPEN`. 건너뛴 이벤트는 `settlement_batch_skip`에 사유와 함께 남고 다음 배치의 후보로 남는다(보류 행은 만들지 않는다 — 시스템 보류의 원장 표현은 I-2b). 나머지를 **발행 봉인(스냅샷)별로 묶어** run 하나씩 만들고(`run_<batch>_<snapshot>`), 이벤트별 순액과 포함한 환불 합을 `settlement_run_event`에 고정한 뒤 `settle-run` 작업을 보낸다.
4. **배치 상태**는 `OPEN`/`CONFIRMED` 둘이다. 진행 상황(계산 중·검증 대기·확정 가능)은 run 상태에서 계산한다.
5. **`settle-run`**: run을 잠그고 `PENDING`이 아니면 끝낸다. 발행 봉인의 facts·정책·투영·멤버와 고정된 순액 이벤트(id 순)로 vcrl `evaluate` → events·결과 봉인 → 풀 라인·라인·보류 INSERT → `CALCULATED`, 실행 신원 `sys_settler`가 `result_digest`에 서명(`SPACE_OPS`) → `verify-run` 전송. 엔진 진단이면 `FAILED`와 진단 저장, 이벤트를 풀어 다음 배치로 보낸다.
6. **`verify-run`**: run을 잠그고 `CALCULATED`가 아니면 끝낸다. 봉인된 입력과 스냅샷 사용량·발행 봉인 기준 시점으로 vcrl `verifyAllocationResult` → 불일치 없으면 검증 신원 `sys_verifier`가 서명(`PLATFORM` — vcrl Enum `attestation_role` 값, 코어 규격 12.58)하고 `VERIFIED`, 있으면 `VOIDED`·진단·감사 경보, 이벤트를 푼다. `sys_verifier ≠ sys_settler`를 DB `CHECK`로 강제한다.
7. **배치 확정**(`SPACE_SETTLE`, 배치 생성자와 다른 사람): 살아 있는 run(`FAILED`·`VOIDED` 제외)이 하나 이상이고 모두 `VERIFIED`여야 한다. 모든 run → `CONFIRMED`, 배치 매니페스트(`{format: "rc-batch-manifest/1", batch_id, results: 정렬된 result_digest}`)를 봉인하고 확정자가 서명, `batch_manifest_digest` 기록. 확정된 run의 이벤트는 계속 "살아 있음"으로 남아 다시 배치되지 않는다.
8. **환불 처리**(`refund-recorded`): 원 이벤트가 살아 있는 run에 없으면 아무것도 하지 않는다(다음 배치가 순액으로 처리). 있으면 run을 잠그고, 그 run이 이미 이 환불까지 반영했으면 끝낸다. "이미 반영됨"은 합계 비교가 아니라 **환불 id**로 판단한다: 배치 생성이 순액에 포함한 환불 id를 `settlement_run_event_refund`에 기록하고, 이 환불 id가 거기 있으면 반영된 것이다(합계 비교는 지연된 작업이 뒤늦게 온 다른 환불과 섞여 이중 반영·누락을 낼 수 있다). run이 `CONFIRMED`가 아니면 `VOIDED`로 만들고 모든 이벤트를 풀어 다음 배치가 새 순액으로 다시 평가하게 한다. `CONFIRMED`면 `reverse-event`를 보낸다.
9. **역분개**(`reverse-event`): 환불 id로 이미 역분개했으면 끝낸다(멱등). 원 이벤트의 `settlement_run_event` 행을 잠가 같은 이벤트의 역분개를 직렬화하고, 그 이벤트의 이전 역분개 봉인을 순서대로 `priors`로 넘겨 vcrl `reverse`(`reason = REFUND`, 금액 = 환불액, `run_id = reversal_id`)를 호출한다. 결과를 봉인하고 `reversal_run(original_run_id, event_id, sequence, refund_event_id UNIQUE)`와 음수 풀 라인·`REVERSAL` 라인(`reversal_of_line_id` = 원 라인)·음수 보류를 기록한다. DB 행은 **원 run_id + `line_seq = sequence + 1` + `reversal_id`**로 키를 잡는다(원 run의 라인 유일키와 충돌하지 않는다). 확정된 run의 보류는 I-2a에서 해제되지 않으므로(모두 `HELD`), 이미 해제된 보류의 역분개 규칙은 I-2b에서 정한다.
10. **신원**: 역할에 `SPACE_OPS`·`SPACE_SETTLE`·`SYSTEM`을 더한다. 결제 어댑터는 `SYSTEM` 역할 신원(`sys_ingest`)으로 수익을 넣는다. 작업 처리 신원 `sys_settler`·`sys_verifier`는 개발용 서명키를 갖는다(운영은 KMS — I-2c).
11. **전역 배치 잠금**: `createBatch`는 트랜잭션 advisory lock `settlement:batching`을 EXCLUSIVE로, 환불 수집과 `refund-recorded`는 SHARED로 잡는다. 그러면 환불은 배치가 후보를 읽기 전에 커밋되어 순액에 포함되거나(id 기록, 10.2-8), 배치가 커밋된 뒤에 기록되어 그 `refund-recorded`가 살아 있는 run을 찾는다 — 배치가 읽은 순액과 동시 환불 사이의 틈이 없다. 이벤트별 잠금은 배치가 후보 수(시나리오 3만)만큼 잠금을 잡아 잠금 테이블(`max_locks_per_transaction`)을 넘기고 교착 순서 관리가 필요해 채택하지 않았다. 대가로 배치 생성 동안 환불 기록이 대기한다(10.4, 10.5).
12. **상태 전이 가드(`0011`)**: `settlement_batch`·`settlement_run`·`settlement_run_event`에 `BEFORE UPDATE` 트리거를 두어 위반을 RC001(409 `APPEND_ONLY`)로 거부한다. 배치는 `OPEN → CONFIRMED` 한 번, 확정 필드(`confirmed_by`·`confirmed_at`·`batch_manifest_digest`)는 NULL → 값 한 번, `CONFIRMED`는 세 필드가 모두 있어야 한다(`CHECK`). run은 `PENDING → CALCULATED|FAILED|VOIDED`, `CALCULATED → VERIFIED|VOIDED`, `VERIFIED → CONFIRMED|VOIDED`만, digest·검증자·검증 시각은 한 번만 쓰고 `diagnostics`는 `FAILED`·`VOIDED` 전이와 같은 UPDATE에서만 쓴다. run_event는 `active`만 `true → false` 한 번, 부모 run이 이미 `FAILED`·`VOIDED`일 때만 바꿀 수 있다. 세 테이블 모두 DELETE를 거부한다. INSERT 경로 가드는 I-2b(10.5).
13. **시스템 신원 보장**: 서버 시작 시 작업 워커를 붙이기 전에 `ensureSystemIdentities`가 `sys_ingest`·`sys_settler`·`sys_verifier`(`SYSTEM`)를 멱등으로 만든다(동시 시작은 advisory lock으로 직렬화). 워커 처리량은 `RC_JOB_BATCH_SIZE`·`RC_JOB_CONCURRENCY`(기본 20·4, 10.4)로 정한다.
14. **역분개 거부**: `reverse-event`에서 vcrl이 정산액 초과(`REFUND_EXCEEDS_SETTLED`)로 거부하면 — id 기반 반영 판단(10.2-8) 이후에는 버그 신호이고 결정적이라 재시도해도 같다 — 역분개를 쓰지 않고 별도 트랜잭션으로 `REVERSAL_REJECTED`를 환불 id당 **한 번만** 감사에 남긴 뒤 작업을 완료로 끝낸다(재시도 소진·반복 경보 없음). 시나리오 통과 조건은 이 감사 0건이다.

### 10.3 완료 기준

- 멱등 수집·환불 한도, 그룹화·건너뜀, 분쟁 게이트, 직무 분리, 작업 재시도 안전, 검증 불일치 → `VOIDED`가 통합 테스트로 통과한다.
- 환불 3경로(배치 전 = 순액, 확정 전 = run 무효화 후 재평가, 확정 후 = 역분개)와 확정 후 부분 → 잔액 전액 환불의 순합 0.
- 시나리오: I-1의 1만 조합에 매출 약 3만 건·환불 일부를 더해 배치 하나를 끝까지 처리하고, 보존식(Σ 라인 + 보류 + 비권리 풀 = Σ 순매출), 모든 run 재계산 불일치 0, 역분개 순합, 처리 시간을 리포트한다.

### 10.4 I-2a 결과 (2026-09-30)

| 항목 | 결과 |
|---|---|
| 테스트 | rights-core 102개 통과, vcrl 277개 통과 (최종 리뷰 반영 후 110 / 278개) |
| 시나리오 매출 / 배치 전 환불 / 확정 후 환불 | 30000 / 1500 / 1278건 |
| run / 검증 통과 / 재계산 불일치 | 9490 / 9136 / 0 |
| 실패 run(진단) | 354건, 모두 `ALLOC_INFEASIBLE` (아래 제품 발견) |
| 보존식(풀 = 순매출, 권리 풀 = 라인 + 보류) | 통과(검증 통과 run의 이벤트 전수, 이벤트 단위) |
| 역분개 / 전액 환불 순합 0 | 1278건(거부 0) / 통과 |
| 배치 생성 / 정산·검증 처리 시간 | 10880 / 35729 ms |
| 매출·배치 전 환불 수집 / 확정 후 환불·역분개 처리 시간 | 7502 / 2920 ms |
| 실행 환경 | macOS 26.6.2 · Node v26.7.0 · PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) · pg-boss 12.35.0, 로컬 Docker, pg-boss 워커 단일 프로세스 |

- 실행: `npm run scenario -- --settle 30000`(시드 20260929). I-1 시나리오(1만 조합 발행, 총 33825ms, p50 / p95 / max 3.29 / 3.96 / 20.5 ms, 불일치 0)에 이어 `src/scenario/settlement.ts`가 돌고, 마지막 줄 `SCENARIO PASS`. 전체 1분 52초. 축소판(100 발행·300 매출)은 `test/scenario/settlement.test.ts`.
- 흐름: 발행 봉인이 있는 조합에서 시드 난수로 구매 3만 건(1,000~50,000원, 2026-03 안에서 증가, 1% `FLAGGED`) → 구매 5%에 배치 전 환불(약 30% 전액) → 배치 `bat_2026_03` 생성 → 실제 pg-boss로 `settle-run`·`verify-run` → 보존식 → `usr_settle` 확정 → 확정 이벤트 3%에 확정 후 환불(절반은 남은 순액을 두 번에 나눠 전액) → 역분개 → 전액 환불 이벤트의 풀·라인·보류 순합 0 확인. 재시도 소진 작업 0건.
- 통과 조건: 재계산 불일치 0, 보존식, 전액 환불 순합 0, 역분개 수 = 확정 후 환불 수·거부 0, `FAILED`가 아닌 run은 모두 `VERIFIED`(→ 확정), `FAILED` run의 진단은 `ALLOC_INFEASIBLE`뿐이고 **모든** `FAILED` run이 그 진단을 가진다(`failedReasons.ALLOC_INFEASIBLE = failedRuns`, 최종 리뷰에서 추가), 재시도 소진 작업 0.
- **제품 발견 — 단독 가창 조합은 정산 불가**: 합성 곡 정책의 `performer … |> cap(50%)`는 한 멤버에게 연주자 몫의 50%를 넘겨 줄 수 없는데, 한 멤버가 네 슬롯을 모두 부른 조합(81가지 중 3가지)은 나머지를 받을 연주자가 없어 분배가 존재하지 않는다(`ALLOC_INFEASIBLE`). 이 조합의 run 354건(3.7%)이 `FAILED`가 되고, 10.2-5에 따라 이벤트가 풀려 **다음 배치마다 다시 실패한다**. 발행은 막히지 않으므로(발행 시점에는 정산 가능성을 검사하지 않는다) 팔린 매출이 정산되지 않고 남는다. 시나리오는 이 조합을 구매에서 거르지 않고 실패 수를 그대로 기록했다. 해소 방향(정책 작성 시 단독 가창 조합 금지·발행 시점 정산 가능성 검사·cap 초과분의 명시적 귀속 규칙 중 선택)은 제품 결정으로 넘긴다.
- 최종 리뷰 반영 후 재실행(같은 시드): 매출·환불·run·검증·실패·역분개 수와 모든 통과 조건이 위 표와 같고 `SCENARIO PASS`. 처리 시간은 배치 생성 11504 ms, 정산·검증 36516 ms, 수집 7552 ms, 역분개 3027 ms.
- 처리량 조정: 워커는 큐마다 `batchSize` 20·`localConcurrency` 4·`burstWhenBatchFull`, 작업별 결과(`perJobResults`)로 돌렸다(기본값 1·1은 작업 하나마다 폴링 간격 0.5초를 쉬어 run 9490개에 두 작업이면 약 2.6시간). `drainIdle`은 `findJobs`(완료된 작업까지 전부 읽음) 대신 `pgboss.job`에서 `created`·`retry`·`active` 상태만 센다.
- 배치 생성은 후보 3만 건을 한 트랜잭션(전역 배치 잠금 EXCLUSIVE)에서 행 단위 INSERT로 처리해 10.9초 걸렸다. 그동안 환불 기록은 대기한다. 운영 규모에서는 일괄 INSERT나 분할이 필요하다(I-2b 이후 과제).

### 10.5 I-2b 선행 과제

I-2a 최종 리뷰에서 I-2b로 넘긴 항목이다.

1. `완료(I-2b)` **운영자 run 무효화·재대기 API**: `VERIFIED`·`CALCULATED` run을 운영자가 `VOIDED`로 돌리고 이벤트를 다음 배치로 보내는 경로, 멈춘 `PENDING` run의 작업 재전송.
2. `완료(I-2b)` **결정적 실패 격리**: 같은 입력으로 반드시 다시 실패하는 run(예: 10.4의 단독 가창 조합 `ALLOC_INFEASIBLE`)의 이벤트를 매 배치 재시도하지 않도록 격리 상태·사유를 두고, 해소(정책 수정·수동 처리) 뒤에만 다시 후보로 올린다.
3. `완료(I-2b)` **미반영 환불 대사 쿼리**: 기록된 환불 중 run 순액(`settlement_run_event_refund`)·run 무효화·역분개(`reversal_run`) 어느 쪽에도 반영되지 않은 것을 찾는 점검 쿼리와 경보.
4. `완료(I-2b)` **배치 일괄 INSERT**: 배치 생성의 행 단위 INSERT(3만 건 10.9초, 그동안 환불 기록 대기)를 일괄 INSERT나 분할로 바꾼다.
5. `완료(I-2b)` **INSERT 경로 가드**: 0011 가드는 UPDATE·DELETE만 막는다. 끝 상태가 아닌 초기 상태로만 INSERT(`settlement_batch` `OPEN`, `settlement_run` `PENDING`, 확정·검증 필드 NULL), 확정된 배치에 run 추가 금지 등을 트리거로 강제한다.
6. `완료(I-2b)` **`source_revision` 대체 규칙**: 10.2-2의 `REVISION_UNSUPPORTED`를 대체(이전 revision 무효화·차액 역분개) 규칙으로 바꾼다.
7. `완료(I-2b)` **운영 마이그레이션·pg-boss 설치 스크립트**: 지금은 테스트 템플릿 DB를 만들 때만 마이그레이션과 pg-boss 스키마 설치(`installJobSchema`)를 돌린다. 운영 DB용 마이그레이션 실행·pg-boss 스키마 설치·`rc_app` 권한 부여 스크립트가 필요하다.
8. `완료(I-2b)` **커넥션 풀과 워커 동시 수**: 워커 기본값(배치 20·동시 4, 큐 4개 → 최대 16 핸들러)이 DB 풀(`max: 10`)을 HTTP·Outbox와 나눠 쓴다. 풀 크기를 환경 변수로 받거나 워커 동시 수에 맞춘다.
9. **어댑터 연결 순서**: 정정(revision)을 보내는 실제 결제 어댑터는 6번(대체 규칙) 이후에 붙인다(그 전에는 `REVISION_UNSUPPORTED`로 계속 거부된다).

---

## 11. I-2b 원장·지급 설계 결정 (2026-09-30)

### 11.1 범위

- 포함: 복식 원장(분개·전기, 확정 배치·역분개 반영), 보류 해제, 지급 지시(최소지급 이월·초기 지급 보류·원천징수), 지급 사업자(PSP) 연동 인터페이스와 가짜 어댑터(멱등 전송·결과 불명 재조회·webhook inbox), 권리자 명세 API, 발행 사전 검사와 발행 봉인 격리, 10.5 선행 과제(1 운영자 run 무효화·재큐잉, 3 미반영 환불 점검, 4 배치 일괄 INSERT, 5 INSERT 경로 가드, 6 `source_revision` 대체, 7 운영 마이그레이션·pg-boss 설치 스크립트, 8 DB 풀 크기).
- 제외: 실제 PSP·은행 연동과 계약, 세무 신고 파일, 다통화, 매출 채권의 대금 회수(collection) 대사, KMS·DB 차원 직무 분리·Outbox 재시도·봉인 조회 인증(I-2c), 10.5-9(어댑터 연결은 실제 어댑터 도입 때).

### 11.2 결정

1. **정산 불가 조합(제품 결정)**: 발행 트랜잭션에서 활성 정책과 발행 봉인으로 가상 이벤트(정책 범위의 첫 이벤트 유형, 금액 1,000,000)를 vcrl `evaluate`로 미리 평가해 진단이 나오면 422 `ISSUE_NOT_SETTLEABLE`로 발행을 거부한다(트랜잭션 롤백). 이미 발행된 조합의 run이 엔진 진단으로 `FAILED`가 되면 그 발행 봉인을 **격리**(`quarantine`)하고, 이후 배치는 그 봉인의 이벤트를 `ENGINE_FAILED`로 건너뛴다. 운영자(`SPACE_SETTLE`)가 격리를 해제하면 다시 후보가 된다. 봉인된 입력에 대한 엔진 진단은 결정적이므로 재평가해도 같은 결과다. 격리 행의 키는 `quarantine_id`(BIGSERIAL)이고, 해제되지 않은 격리는 봉인당 하나(부분 UNIQUE `snapshot_id WHERE released_at IS NULL`)다. 해제(`released_by`·`released_at`, 한 번만 함께 쓴다) 뒤 다시 FAILED가 되면 새 격리 행이 생긴다(재격리 허용, 격리 이력이 쌓인다). FAILED 경로의 삽입은 `ON CONFLICT (snapshot_id) WHERE released_at IS NULL DO NOTHING`.
2. **복식 원장**: 계정(`ledger_account`) 종류 `RECEIVABLE`, `POOL_PLATFORM`, `POOL_OPS`, `POOL_FAN`, `POOL_OTHER`, `PARTY_PAYABLE`(권리자별), `HOLD`(사유별), `WITHHOLDING_TAX`, `PSP_CLEARING`, `CASH`. 금액 부호는 차변 +, 대변 −. 분개(`journal_entry`) 하나의 전기(`posting`) 합은 0이어야 하며 커밋 시점 지연 제약 트리거로 강제한다. 분개는 `source_ref` UNIQUE로 멱등이고 추가만 허용한다. 잔액은 전기의 합이다(부채 계정의 잔액은 −합).
3. **tier1 버킷 → 계정**: 권리 풀 버킷(`policy.body.tier1.rights`)은 라인·보류로 내려가므로 계정이 없다. 나머지는 `platform → POOL_PLATFORM`, `ops → POOL_OPS`, `fan → POOL_FAN`, 그 밖의 이름 → `POOL_OTHER`(계정 이름에 버킷 이름).
4. **원장 반영**: 배치 확정 트랜잭션이 `post-batch` 작업을 보내고, 처리기는 확정 run마다 분개 하나(`SETTLEMENT`, `source_ref = run:<run_id>`)를 쓴다. 이벤트마다 `RECEIVABLE +순매출`, 비권리 풀 `−금액`, 라인 `PARTY_PAYABLE(party) −금액`, 보류 `HOLD(reason) −금액`. 역분개는 `reverse-event` 트랜잭션 안에서 반대 부호 분개(`REVERSAL`, `source_ref = rev:<reversal_id>`)를 함께 쓴다.
5. **보류 해제**(`SPACE_SETTLE`): 운영자가 권리자별 배분(합 = 보류액)을 지정해 해제한다. `FRAUD_REVIEW`는 봉인 입력으로 무결성 `CLEAR`를 가정해 다시 평가한 배분을 제안하는 조회 API를 둔다(제안일 뿐 적용은 운영자). 분개 `HOLD_RELEASE`: `HOLD(reason) +보류액`, `PARTY_PAYABLE(p) −배분`. 보류 하나는 한 번만 해제된다. **해제된 보류를 나중에 역분개**하면 보류 계정 대신 해당 권리자 미지급금에서 뺀다. 가중치는 권리자별 **남은 해제액**(해제 배분 − 앞선 역분개들이 그 권리자에게서 이미 되돌린 누적액, `hold_release_reversal`)이고, 되돌릴 금액을 이 가중치로 최대 잔여법(동률 party_id 오름차순)으로 나눈다. 원 배분 비율을 매번 다시 쓰지 않으므로 여러 번 부분 역분개해도 한 권리자에게서 해제받은 것보다 많이 되돌리지 않는다.
6. **지급 지시**(`payout-run`, 운영자가 기준 시각을 지정): 권리자별 미지급금 잔액이 지급 대상액이다(이월은 잔액에 자연히 남는다). 다음이면 지시를 `CARRIED`(최소 지급액 미만·잔액 0 이하) 또는 `HELD`로 남기고 분개하지 않는다. `HELD` 사유(판정 순서): `NO_PROFILE`(지급 프로필 없음), `NO_ACCOUNT`(계좌 토큰 없음), `KYC_REQUIRED`(KYC 미확인), `ACCOUNT_COOLING`(계좌 토큰 변경 뒤 `payout_policy.account_cooling_hours`(기본 72시간)가 기준 시각까지 지나지 않음 — 기준 시각보다 뒤의 변경 포함), `ACCOUNT_SOD`(지급 실행자가 그 권리자의 계좌 토큰을 마지막으로 바꾼 사용자 — 직무 분리), `INITIAL_HOLD`(첫 지급 가능 시각 + 초기 보류 일수 이전). **계좌 변경 통제**: 프로필의 `account_changed_at`·`account_changed_by`는 계좌 토큰이 바뀔 때만(처음 등록·지움 포함) 지금·변경자로 갱신된다(토큰이 그대로면 바꿀 수 없다 — 트리거 RC001). 감사 `PAYOUT_PROFILE_SET`에 이전·새 계좌 토큰(PSP 토큰, 원문 계좌번호 아님)·세금 유형·KYC를 남긴다. 지급 실행은 프로필을 `FOR SHARE`로 읽고(판정 중 토큰 변경은 실행이 끝날 때까지 기다린다), `PENDING` 지시에 판정한 토큰을 `decided_account_ref`(INSERT 때 한 번, `PENDING`에만 — INSERT 가드·CHECK, 이후 불변)로 적는다. 프로필 변경은 행 잠금 뒤에 시각을 읽는다. 전송 전 현재 토큰이 `decided_account_ref`와 다르면 `submit-payout`은 PSP를 부르지 않고 지시를 `FAILED`(`ACCOUNT_CHANGED`, 잔액 복원)로 끝낸다 — 시각이 아니라 토큰을 비교하므로 동시 변경·시계 차이에도 냉각·직무 분리 판정을 거치지 않은 토큰으로 보내지 않는다(한 번 보낸 뒤의 재전송은 `submitted_account_ref`를 쓴다). 지급할 때 원천징수 = ⌊총액 × 세율 bps / 10000 / 10⌋ × 10(10원 미만 절사), 분개 `PAYOUT`: `PARTY_PAYABLE +총액`, `WITHHOLDING_TAX −원천세`, `PSP_CLEARING −실지급액`. 기본 정책: 최소 지급액 10,000원, 초기 보류 30일, 세율 `DOMESTIC_INDIVIDUAL 330`·`DOMESTIC_CORP 0`·`FOREIGN 2200`·`EXEMPT 0` bps(설정 가능, **운영 전 세무 확인 필요**).
7. **PSP**: `PayoutProvider { submit(instruction, idempotencyKey) → ACCEPTED|PAID|FAILED|UNKNOWN; status(providerRef, idempotencyKey) }`(참조를 아직 모르면 빈 `providerRef`와 멱등 키로 조회한다). 지급 지시의 멱등 키는 `payout:<instruction_id>`. `submit-payout` 작업이 전송하고, `UNKNOWN`이면 새로 보내지 않고 `poll-payout`을 지연 전송해 재조회한다. webhook은 `psp_webhook_inbox`(`provider_event_id` UNIQUE)에 저장하고 `apply-psp-result`로 처리한다. `PAID` → 분개 `PAYOUT_SETTLED`(`PSP_CLEARING +실지급액`, `CASH −실지급액`), `FAILED` → 분개 `PAYOUT_FAILED`(`PAYOUT` 분개의 반대). 결과 적용은 지시 상태 전이 가드로 한 번만 일어난다. 가짜 어댑터는 금액·키에 따라 성공·실패·불명을 결정적으로 흉내 낸다.
8. **명세**: `GET /parties/:id/statements?from&to` — 기간 시작 잔액, 발생(정산), 역분개, 보류 해제 수령, 지급(총액·원천세·실지급), 지급 실패 복원, 기간 끝 잔액. 모두 전기에서 계산한다. 원천세·실지급(`withholding`·`payoutNet`)은 그 기간에 `PAYOUT` 분개가 쓰인 지시(실패 포함, 총액과 같은 범위)의 합이고, 그 기간에 실패한 지시의 원천세·실지급을 `withholdingRestored`·`netRestored`로 따로 보인다(합 = 지급 실패 복원). 권리자에게 보이는 실제 원천세·실지급 = `withholding − withholdingRestored`·`payoutNet − netRestored`. 항등식은 그대로다.
9. **운영자 run 조작**(`SPACE_SETTLE`): `POST /runs/:id/void`(`PENDING`·`CALCULATED`·`VERIFIED` → `VOIDED`, 이벤트 해제, 사유는 1~500자 — 어긋나면 400), `POST /runs/:id/requeue`(`PENDING` → `settle-run`, `CALCULATED` → `verify-run` 재전송).
10. **점검 API**: `GET /settlement/invariants` — (a) 반영되지 않은 환불(원 이벤트가 살아 있는 `CONFIRMED` run에 있는데 포함 환불 목록에도 역분개에도 없는 환불)과 반영되지 않은 대체(이전 revision이 살아 있는 `CONFIRMED` run에 남은 정산액 > 0으로 있는데 새 revision의 `CORRECTION` 역분개가 없음, 11번), (b) 원장 불변식(분개 합 0, `RECEIVABLE` 잔액 = 확정 순매출 − 역분개, 권리 풀 = 미지급금 + 보류 + 원천세 + PSP 정산 중 + 현금 − 비권리 풀 제외분), (c) 오래 멈춘 run(`PENDING`·`CALCULATED`가 기준 시간 초과), (d) 지급 대사(`payouts`, `src/payout/reconcile.ts` — 점검은 settlement → payout 방향으로만 import한다): 멈춘 지시(`PENDING`은 전송 표식(없으면 생성 시각)이 run과 같은 기준 시간(`stuckAfterMinutes`, 기본 60분) 초과, `SUBMITTED`는 전송 표식이 `payoutStuckAfterMinutes`(기본 1440분 — PSP 처리 대기) 초과이거나, `PAYOUT_STUCK` 감사가 있는 것), 결과 충돌(`PAYOUT_RESULT_CONFLICT` 감사가 있는 지시 — 예: `FAILED`로 끝난 뒤 `PAID` 결과, 이중 지급 위험), `−PSP_CLEARING = Σ 열린(PENDING·SUBMITTED, 분개된) 지시 실지급액`, `−CASH = Σ PAID 실지급액`, `−WITHHOLDING_TAX = Σ 분개됐고 FAILED가 아닌 지시의 원천세`, 기준 시간보다 오래된 미처리 webhook 수. 정상 흐름에서 멈춤·충돌·미처리는 0, 대조는 모두 true.
11. **`source_revision` 대체**: 같은 `(source_system, source_event_id)`의 더 높은 revision은 최신 revision을 대체한다. 최신보다 낮거나 같은 번호의 새 revision은 422 `REVISION_OUT_OF_ORDER`(이미 기록된 revision의 재전송은 기존 멱등 규칙). 새 revision은 같은 유형·같은 `vc_id`여야 하고(422 `REVISION_MISMATCH`, 환불의 revision은 받지 않는다 — 환불은 원 이벤트를 따르므로 같은 코드로 거부), 이전 revision에 환불이 있으면 422 `REVISION_HAS_REFUNDS`(원 이벤트별 환불 잠금 아래에서 판단). 대체된 이벤트를 대상으로 한 환불은 422 `EVENT_SUPERSEDED`. 기록 시 `revenue_supersede(old, new)`를 남기고 `revision-recorded` 작업을 보낸다. 처리(전역 배치 잠금 SHARED 먼저): 이전 revision이 살아 있는 run에 없으면 없음(배치는 대체된 이벤트를 후보에서 뺀다), 확정 전 run이면 run 무효화(`SUPERSEDED_BEFORE_CONFIRMATION`·이벤트 해제), 확정 run이면 이전 revision의 남은 정산액(run 이벤트 순액 + 앞선 역분개 풀 합) 전액을 `CORRECTION` 역분개(역분개 식별 이벤트 = 새 revision, `reversal_run.refund_event_id` = 새 revision, `reversal_id = rev_<새 revision>`)하고 새 revision은 다음 배치에서 정산된다. 확정 run은 끝 상태이므로 잠그지 않고 run 이벤트 행만 잠근다(보류 해제·`reverse-event`와 같은 잠금 순서, run은 확정 전 무효화 경로에서만 `FOR UPDATE`). 배치는 새 revision을, 같은 source 이벤트의 앞선 revision이 확정 전 run에 살아 있거나 확정 run에 남은 정산액 > 0으로 있는데 그 대체의 `CORRECTION` 역분개가 아직 없으면 `REVISION_PENDING`으로 건너뛴다(이중 계상 방지). `CORRECTION`이 정산액 초과로 거부되면(`CORRECTION_EXCEEDS_SETTLED`, 버그 신호) 역분개를 쓰지 않고 감사 `CORRECTION_REJECTED`를 한 번만 남긴 뒤 작업을 끝낸다. 점검 API는 이를 반영되지 않은 대체(`unreflectedRevisions`, 거부 여부 표시)로 보고한다. 10.2-2의 `REVISION_UNSUPPORTED`는 이 규칙으로 대체한다.
12. **INSERT 경로 가드**: `settlement_batch`는 `OPEN`으로만, `settlement_run`은 `PENDING`·디지스트·검증 필드 NULL·배치 `OPEN`일 때만, `settlement_run_event`는 run이 `PENDING`일 때만, `line_seq = 1` 라인·보류는 run이 `PENDING`일 때만, `line_seq > 1`은 run이 `CONFIRMED`일 때만 INSERT된다. `payout_instruction`은 `PENDING`·`CARRIED`·`HELD`로만, `provider_ref`·`settled_entry_id`·`submit_attempted_at`·`submit_unknown_at`·`submitted_account_ref`가 NULL일 때만 INSERT된다. webhook 본문은 `providerEventId`·`providerRef` 1~200자, `status` `PAID`|`FAILED`(아니면 400).
13. **배치 일괄 INSERT**: run·run 이벤트·포함 환불을 `unnest` 배열로 한 번에 넣어 전역 배치 잠금 보유 시간을 줄인다.
14. **운영 스크립트·설정**: `npm run migrate`(소유자 역할로 마이그레이션, pg-boss 스키마 설치·큐 생성, `rc_app` 권한), DB 풀 크기 `RC_DB_POOL_MAX`(기본 40). 워커가 동시에 쥐는 연결 ≈ 큐 수(`JOB_NAMES` 9) × `RC_JOB_CONCURRENCY`(기본 4) + `post-batch`의 추가 동시 분개(`POST_CONCURRENCY` − 1 = 3) = 39이고 HTTP 요청·outbox 폴러가 더해진다. `RC_JOB_CONCURRENCY`를 올리면 이 식으로 `RC_DB_POOL_MAX`도 올린다(pg-boss는 자기 풀을 따로 쓴다). 템플릿 DB 해시에 작업 이름 목록을 넣는다(큐가 템플릿에서 생성되므로).

### 11.3 완료 기준

- 원장: 모든 분개 합 0, 확정·역분개·해제·지급·성공·실패가 올바른 계정에 전기, `source_ref` 멱등.
- 보류 해제·해제 후 역분개, 지급(최소액 이월, 초기 보류, 원천징수 절사, 음수 잔액 이월, 멱등 재전송, webhook 중복, 불명 → 재조회, 실패 복원), 명세 합계 = 전기 합계.
- 사전 검사: 정산 불가 조합 발행 422. 격리: 이후 배치 건너뜀, 해제 후 재대상.
- 선행 과제 각각의 테스트. 시나리오: 3만 건 정산 뒤 원장 반영·보류 일부 해제·지급(가짜 PSP 성공·실패·불명 섞음) → 원장 불변식과 명세 합계 대조, 처리 시간 리포트.

### 11.4 I-2b 결과 (2026-09-30)

| 항목 | 결과 |
|---|---|
| 테스트 | rights-core 231개 통과(최종 검토 반영 후), vcrl 278개 통과 |
| 시나리오 발행 / 사전 검사 거부 | 10000 / 396건(단독 가창 조합, 11.2-1) |
| 매출 / 배치 전 환불 / 확정 후 환불 | 30000 / 1500 / 1331건 |
| run / 검증 통과 / 실패 run / 재계산 불일치 | 9490 / 9490 / 0 / 0 |
| 분개 / 전기 | 10973 / 291390건 (`SETTLEMENT` 9490, `REVERSAL` 1331, `HOLD_RELEASE` 138, `PAYOUT` 7, `PAYOUT_SETTLED` 6, `PAYOUT_FAILED` 1) |
| `FRAUD_REVIEW` 보류 / 해제 시도(절반) / 제안대로 해제 | 282 / 141 / 138건(2,519,222원), 건너뜀 3건(확정 후 전액 환불로 남은 보류 0) |
| 권리자(미지급금 계정) / 프로필 | 7명 / 개인 5 · KYC 미확인 1 · 법인 1 |
| 지급 지시 최종 상태(2회 실행 합) | `PAID` 6 · `FAILED` 1 · `CARRIED` 5 · `HELD` 2(`KYC_REQUIRED`) |
| 원천징수 합 / 실지급 합 | 7,701,430원 / 426,413,859원(`PAID` 지시, = −`WITHHOLDING_TAX` / −`CASH` 잔액) |
| PSP 전송 / 재조회 / 결과 불명 | 7 / 1 / 1건 |
| webhook 전송 / 중복 / 중복 무시 / 미처리 | 11 / 4 / 4 / 0건 |
| 결과 중복 적용 / 결과 충돌 / 멈춤·참조 불일치 경보 | 0 / 0 / 0 |
| 점검 API | 미반영 환불 0, 미반영 대체 0, 분개 합 위반 0, `RECEIVABLE` 대조 true, 권리 풀 보존 true, 미분개 run·역분개 0, 풀 합 불일치 0, 멈춘 run 0, 지급 대사(멈춘 지시 0·결과 충돌 0·`PSP_CLEARING`·`CASH`·`WITHHOLDING_TAX` 대조 true·미처리 webhook 0, 최종 검토 반영 후 재실행) |
| 명세 | 7명 전원 항등식 성립·기말 = 실제 부채 잔액, 명세 지급 총액 합 = 지시 총액 합 484,302,985원, 원천세 합 9,357,620원(실패 지시 포함) 일치 |
| 처리 시간(ms) | 원장 반영(`post-batch`) 7488, 보류 해제 168, 1차 지급(생성·전송) 353, 결과 반영(webhook·재조회) 1535, 2차 지급 1469, 점검 244, 전원 명세 243, 최다 전기 권리자 명세 14.1 |
| I-2a 단계 처리 시간(ms) | 수집 7090, 배치 생성 4496, 정산·검증 35516, 확정 후 환불·역분개 4204 |
| 실행 환경 | macOS 26.6.2 · Node v26.7.0 · PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) · pg-boss 12.35.0, 로컬 Docker, pg-boss 워커 단일 프로세스 |

- 실행: `npm run scenario -- --settle 30000`(시드 20260929). I-1 시나리오(1만 조합 발행, 총 62055 ms, p50 / p95 / max 5.68 / 8.07 / 19.69 ms, 불일치 0) → I-2a 정산 시나리오 → `src/scenario/ledger.ts`, 마지막 줄 `SCENARIO PASS`. 전체 2분 20초. 같은 시드로 다시 돌리면 처리 시간 외의 값이 모두 같다(재실행에서 확인). 축소판(100 발행·300 매출)은 `test/scenario/ledger.test.ts`.
- 흐름: 확정 직후 `post-batch`를 실제 pg-boss로 처리(`postMs`, 정산 시나리오 안에서 확정 후 환불 전에 잰다) → 확정 후 환불·역분개(`REVERSAL` 분개) → 확정 run의 `FRAUD_REVIEW` 보류를 (run, 이벤트) 순으로 시드 난수로 섞어 절반을 `suggestFraudRelease` 제안대로 해제(남은 보류 0이면 건너뜀, `SUGGESTION_HAS_DISPUTE`도 건너뜀으로 센다 — 이번 실행 0건) → 미지급금 계정이 있는 권리자에게 프로필(10% KYC 미확인, 10% 법인, 나머지 개인, 모두 계좌 토큰, `first_payable_at` 2026-01-01) → 1차 지급 실행(`asOf` = 시나리오 시계 2026-05-01) → `submit-payout`이 끝난 뒤 전송된 지시마다 webhook, 짝수 번째는 두 번(`recordWebhook`) → `drainIdle` → 2차 지급 실행(실패로 복원된 잔액 1건만 다시 지급, 지급된 권리자 5명은 잔액 0으로 `CARRIED`, KYC 미확인은 계속 `HELD`) → 점검 API → 권리자별 명세.
- 가짜 PSP 결과는 시나리오가 정한다(`fakeProvider({ outcome })`): 1차 실행에서 개인 한 명은 `FAILED`, 한 명은 첫 전송 `UNKNOWN` → 재조회로 `PAID`, 나머지는 `PAID`. 권리자가 7명뿐이라 기본 금액 규칙(97·89의 배수)으로는 실패·불명이 거의 나오지 않기 때문이다. `poll-payout` 지연은 작업 의존성 `pollDelaySeconds`로 1초로 줄였다(기본 60초면 지급 실행마다 1분을 쉰다, 운영 기본값은 그대로).
- 통과 조건(I-2a 조건에 더해): 점검 API의 모든 항목, 명세 항등식(closing = opening + 정산 + 역분개 + 해제 + 조정 − 지급 총액 + 실패 복원, 지급 총액 = 실지급 + 원천세)·기말 = 실제 부채 잔액·명세 지급 총액·원천세 합 = 지시 합, 계정 대조(`PSP_CLEARING` 0, `CASH`·`WITHHOLDING_TAX` = `PAID` 지시 합, 결과 분개 수 = 끝 상태 수), webhook 중복 전부 무시, 결과 중복 적용·충돌·경보 0, 열린 지시·미처리 webhook·재시도 소진 작업 0, 그리고 해제·성공·실패·불명·보류·이월 경로가 모두 한 번 이상 지나갔을 것.
- **느린 단계와 수정**: (1) `post-batch`가 run 9490개를 한 줄로 트랜잭션마다 분개해 21.6초 걸렸다 → run 분개를 동시 4개 트랜잭션으로 나눴다(`POST_CONCURRENCY`, 한 run이 실패하면 남은 run을 시작하지 않고 작업 실패 — 재시도는 멱등). 동시에 새 계정을 만드는 트랜잭션이 교착하지 않도록 `ensureAccounts`는 계정 id 순으로 넣는다. 7.5초. (2) 확정 후 역분개가 9.1초(I-2a 3.0초)였다 → 원인은 `postReversal`이 역분개 id로 `pool_line`·`allocation_line`·`unallocated_holding`을 읽는데 인덱스가 없어 역분개마다 순차 스캔한 것. 부분 인덱스 3개(`0016_reversal_indexes.sql`, `reversal_id IS NOT NULL`)를 더했고, `postConfirmedRun`은 이미 쓴 분개면 run 행을 다시 읽지 않고 끝낸다(역분개·해제가 매번 부르는 보장 호출). 4.2초.
- 점검 API(`invariants`, REPEATABLE READ 한 트랜잭션)는 분개 1만·전기 29만 건에서 160~244 ms(수정 전 첫 실행 한 번은 1454 ms — 통계가 갱신되기 전으로 보인다), 전기 30737건인 `pty_agency`의 명세는 14 ms.
- **최종 검토 반영**(같은 시드로 재실행, `SCENARIO PASS`, 처리 시간 외 값 동일): 점검 API에 지급 대사(11.2-10 (d)), 계좌 변경 통제(냉각 72시간·직무 분리·실행 뒤 변경 시 전송 안 함, 11.2-6 — 시나리오는 계좌 토큰을 `usr_settle2`가 등록하고 지급은 `usr_settle`이 실행한다), 명세의 실패 복원 원천세·실지급(11.2-8), 지급 지시 INSERT 가드·webhook 본문 길이·무효화 사유 길이(11.2-9·12), DB 풀 기본 40(11.2-14). 남은 것은 11.5.
- I-1 발행 지연(p50 5.7 ms)은 같은 날 앞선 실행(4.1 ms)보다 느렸는데, 발행 경로는 이번에 바뀌지 않아 실행 환경의 변동으로 본다.

### 11.5 I-2c 선행 과제

I-2b 최종 검토에서 남긴 것. I-2c 착수 전에 해소한다.

1. **webhook 서명**: 지금은 공유 비밀 헤더(`x-psp-secret`) 비교뿐이다. PSP의 HMAC 서명(본문·타임스탬프, 재전송 창)을 검증한다.
2. **결과 충돌 시 권리자 자동 정지**: `PAYOUT_RESULT_CONFLICT`(예: `FAILED` 뒤 `PAID` — 이중 지급 위험)는 감사와 점검 API에만 남는다. 그 권리자의 다음 지급을 자동으로 보류하고 운영자 확인 뒤 푼다.
3. **지시 생성 뒤 KYC 철회**: 지급 실행 뒤 전송 전에 KYC가 철회돼도 지금은 보낸다(토큰 변경만 `ACCOUNT_CHANGED`로 막는다). 전송 직전에 KYC도 다시 확인한다.
4. **`payout_policy` 변경 감사**: 정책은 소유자 역할이 SQL로 바꾸고 감사가 없다. 변경 경로(API 또는 SECURITY DEFINER 함수)와 감사·이력을 둔다.
5. **`CARRIED`·`HELD` 지시 잡음**: 잔액 0인 권리자도 실행마다 지시 행이 생긴다(보류 사유가 먼저 판정되면 잔액 0도 `HELD`). 잔액 0은 행을 만들지 않거나 요약으로 줄인다.
6. **`provider_ref` 충돌 처리**: 다른 지시가 이미 쓴 참조를 PSP가 돌려주면 부분 UNIQUE 인덱스 위반으로 작업이 실패·재시도된다. 감사·경보와 운영자 경로를 둔다.
7. **마이그레이션 동시 실행 검증**: `npm run migrate`를 두 프로세스가 동시에 돌릴 때의 잠금·멱등을 테스트로 확인한다.
8. **9.6에서 이어진 것**: KMS 서명, DB 차원의 직무 분리, Outbox 재시도·dead-letter, 봉인 조회 인증.

---

## 12. 백오피스 E2E 검증 설계 결정 (2026-10-01)

### 12.1 범위

- 포함: rights-core(I-1·I-2a·I-2b) 전체 흐름을 사람이 브라우저로 처음부터 끝까지 조작해 검증하는 **검증용 백오피스 앱**(`04_구현_소스코드/backoffice`), 이를 위한 rights-core 모듈별 조회 API, 개발 전용 기능(`src/dev/`: 가상 시계·개발 사용자·PSP 시뮬레이터·합성 곡 불러오기·검증 DB 초기화), Playwright E2E.
- 제외: 실제 로그인·인증(9.6-5), 권리자·파트너 포털(I-3), 실제 PSP, 제품 수준 디자인. 11.5 I-2c 선행 과제.
- 기존 시안(`dobedupop-backoffice-prototype_v2.7.html` 등)은 목업 데이터의 정적 HTML이고 데이터 구조가 v2.7이라 연결하지 않는다. 색·밀도 등 시각 스타일만 따른다.

### 12.2 결정

1. **앱 형태**: React + Vite + TypeScript, 서버 상태는 TanStack Query(캐시·비동기 상태 자동 갱신·실행 뒤 재조회), 라우팅 react-router, UI 라이브러리 없이 CSS 변수. npm 워크스페이스에 `backoffice`를 추가한다. Vite 개발 서버가 `/api`를 rights-core(`127.0.0.1:8080`)로 프록시한다. API 타입은 손으로 쓰고 계약 테스트(8번)로 실제 응답과 맞춘다.
2. **신원**: 상단 드롭다운으로 개발 사용자를 바꾸고 모든 요청에 `x-actor`를 붙인다(지금 백엔드 방식). 선택한 사용자만 `localStorage`에 기억한다. 직무 분리 거부(승인·활성화, 계좌 등록·지급 실행)를 화면에서 확인할 수 있도록 역할별 개발 사용자를 서버 시작 때 만든다: `usr_editor`(RIGHTS_EDITOR·EDITOR), `usr_approver`(WORK_APPROVER), `usr_activator`(ACTIVATOR), `usr_issuer`(ISSUER), `usr_ops`(SPACE_OPS), `usr_settle`·`usr_settle2`(SPACE_SETTLE).
3. **화면 구성**(메뉴 = 데이터 흐름 순서): 0 개요(대시보드: 단계별 건수·최근 감사·점검 결과·권장 검증 순서 체크리스트), 1 권리 등록(권리자·곡/녹음/슬롯/스템/보이스·권리·위임·분쟁, facts 범위 봉인 상태), 2 정책(VCRL 편집기·컴파일 오류·승인·활성화·재고정), 3 팩·발행(팩·권리자 선언·활성화, 슬롯별 보이스 선택 발행, 봉인 digest·분배 결과·재도출 대조), 4 매출(구매·환불·정정), 5 정산(배치 생성·run 진행·검증·확정, run 무효화·재대기, 격리 해제, 보류 해제 제안·실행), 6 원장(시산표·분개·전기), 7 지급(프로필·냉각 표시·지급 실행·지시·재전송), 8 명세(기간 항등식·기말 대조), 9 개발 도구(PSP 시뮬레이터·데이터). 상단 헤더에 사용자 전환·가상 시계·점검 배지(`/settlement/invariants`, 빨강을 누르면 위반 항목)를 둔다. 오류는 백엔드 오류 코드와 메시지를 그대로 보여 준다(거부 경로도 검증 대상). 비동기 상태(run·지급 지시)는 몇 초마다 다시 읽는다.
4. **조회 API**(모듈별 `routes.ts`, 역할 검사 포함, 목록은 `?limit=&after=` 커서와 상태·키 필터, 응답 `{items, next}`): platform `GET /me`·`/users`·`/audit`, registry `GET /parties`·`/works`·`/scopes/:id`(봉인 상태)·`/scopes/:id/facts`·`/disputes`, policy `GET /policies`·`/policies/:id/versions`·`/policies/:id/versions/:v`, issuance `GET /packs`·`/packs/:id`·`/issues?pack=`, revenue `GET /revenue-events`, settlement `GET /batches`·`/batches/:id/runs`·`/quarantine`·`/holds`·`/reversals`, ledger `GET /ledger/accounts`·`/ledger/entries`·`/ledger/entries/:id`, payout `GET /parties/:id/payout-profile`·`/payout-policy`·`/payout-runs`·`/payout-runs/:id/instructions`·`/payouts/:id`. 기존 단건 조회는 그대로 쓴다. 조회 쿼리도 각 모듈 안에 두어 계층 규칙(아키텍처 테스트)을 지킨다.
5. **개발 전용 기능**(`src/dev/`): 개발 기능은 개발 진입점(`npm run dev` = `src/dev/main.ts`, `RC_DEV` 기본 1)으로만 켜고 그때만 `/dev/*`를 등록한다(운영 진입점 `npm run serve`는 `RC_DEV`와 무관하게 개발 기능을 등록하지 않는다 — 404). 개발 진입점은 DB 이름이 `rights_core_dev`가 아니거나, `RC_PSP`가 가짜가 아니거나, `DATABASE_URL`과 `RC_ADMIN_URL`이 같은 호스트·포트·DB가 아니면 시작을 거부한다. 기능: 가상 시계(`GET /dev/clock`, `POST /dev/clock/advance {ms}`, `POST /dev/clock/set {at}`), PSP 시뮬레이터(`GET /dev/psp/requests`, `PUT /dev/psp/outcomes/:instructionId` — 그 지시의 다음 결과 `PAID`|`FAILED`|`UNKNOWN`, `POST /dev/psp/webhook {instructionId, status?, repeat}` — 실제 `/psp/webhook` 경로로 비밀 헤더를 붙여 보내고 `repeat`만큼 같은 `providerEventId`로 중복 전송. `status`(`PAID`|`FAILED`)를 주면 그 결과로 보내고 가짜 PSP의 재조회 결과도 맞춘다 — 전송된 지시가 webhook으로 실패해 잔액이 복원되는 경로를 재현한다. 없으면 첫 submit 때 정해진 결과. 지시별 결과 지정은 첫 submit 전에만 의미가 있다), 합성 곡 불러오기(`POST /dev/seed/synthetic-song` — 시나리오 곡의 권리자·곡·녹음·슬롯·스템·보이스·권리·위임·팩·권리자 선언까지, 정책 컴파일·승인·활성화와 팩 활성화는 UI에서 하도록 남긴다. 이미 있으면 409 `ALREADY_SEEDED`. 읽기 전용 `GET /dev/seed/synthetic-song`은 아무것도 쓰지 않고 같은 응답(`packId`·`policyId`·`policyText` 등)을 돌려준다 — 정책 편집기의 "합성 곡 정책 불러오기"가 쓴다), 검증 DB 초기화(`POST /dev/reset` — 관리자 연결로 DB 이름이 `rights_core_dev`인지 다시 확인한 뒤 `schema_migrations`를 뺀 모든 테이블을 `TRUNCATE … RESTART IDENTITY CASCADE`(행 트리거를 부르지 않으므로 추가 전용 규칙을 우회 — 개발 DB만), pg-boss 작업 삭제, 마이그레이션이 넣은 시드 행(예: `payout_policy` 기본값) 복원, 시계를 초기값으로, 개발 사용자 재생성). 거부 경로 재현용으로 작업 일시정지(`POST /dev/jobs/pause|resume {name}` — 그 큐만 처리를 멈춘다)와 권리자별 PSP 결과 지정(`PUT /dev/psp/outcomes/party/:partyId` — 지급 실행 전에 지정, 지시별 지정이 우선)을 둔다.
6. **가상 시계**: 가상 시각 = 기준 시각 + (실제 현재 − 설정한 실제 시각). 기준은 `dev_clock` 테이블(개발 DB에만 — `migrations-dev/`의 개발 전용 마이그레이션, 운영 `npm run migrate`는 적용하지 않는다)에 두어 재시작해도 이어진다. 앞으로만 간다(지급 기준 시각 단조성·봉인 울타리와 맞춤, 뒤로 가는 요청은 409 `CLOCK_REGRESSED`). 실제 시각을 넘을 수 없다(엔진이 DB 시계보다 늦은 `knownAt`을 422로 거부 — 9.3-10 봉인 울타리, 넘기려 하면 409 `CLOCK_AHEAD_OF_REAL`). 그래서 초기화 때 시계를 2026-01-01T00:00:00.000Z(합성 곡 기준일)로 둔다. 개발 모드의 서비스·작업 핸들러·Outbox 폴러는 `systemClock` 대신 이 시계를 주입받는다(서비스 코드 변경 없음). pg-boss 작업 지연(예: PSP 재조회)은 실제 시간 기준으로 남는다.
7. **실행**: `docker compose up -d` → `npm run dev:db -w rights-core`(개발 DB 생성·마이그레이션·pg-boss 스키마, 처음 한 번) → `npm run dev -w rights-core`(`RC_DEV=1 RC_PSP=fake`, :8080) → `npm run dev -w backoffice`(:5173). 루트 `npm run dev`로 둘을 함께 띄운다. 기존 테스트 템플릿 DB·시나리오와 분리한다.
8. **테스트**: rights-core에 새 조회 API(형태·페이지·필터·역할 거부)와 `/dev/*`(꺼짐 404·DB 이름 검사·시계 단조·실제 시각 상한) 테스트, 계약 테스트(실제 서버의 각 목록 API 응답 ↔ 백오피스 타입), backoffice 단위(Vitest, 형식 변환·오류 표시), **Playwright E2E**: 실제 rights-core·개발 DB·브라우저로 권장 검증 순서 11단계(합성 곡 → 정책 컴파일·승인·활성화 → 팩 활성화 → 발행 → 매출·환불 → 시계 이동·배치·확정 → 확정 후 환불·역분개 → 보류 해제 → 지급 프로필·시계 +3일 → 지급 실행·PSP 결과 → 명세 대조·점검 초록)와 거부 경로 5개(정산 불가 조합 422, 같은 사용자 승인·활성화 거부, 냉각 중 `HELD`, 계좌 변경 뒤 `ACCOUNT_CHANGED`, 중복 webhook 무시). 테스트마다 `/dev/reset`으로 시작한다.

### 12.3 완료 기준

- 사람이 백오피스만으로 권장 검증 순서 11단계를 끝까지 진행할 수 있다(단계별 관찰값을 12.4에 남긴다. 화면 캡처는 진행 중 확인용으로만 쓰고 저장소에 넣지 않는다 — 계획 Task 12 결정).
- Playwright E2E(정상 경로 + 거부 경로 5개) 통과.
- rights-core 기존 테스트·새 조회·개발 API 테스트·tsc·3만 건 시나리오 통과, vcrl 테스트·smoke 통과.
- 결과를 12.4에 기록한다.

### 12.4 백오피스 E2E 검증 결과 (2026-10-01)

| 항목 | 결과 |
|---|---|
| 테스트 | rights-core 292개(I-2b 232 → +60: 개발 모드·조회 API), vcrl 278개, 백오피스 단위 73개(Vitest), Playwright E2E 15개(계약 9 · 정상 경로 1 · 거부 경로 5) — 전체 3회 연속 통과(30~32초) |
| 회귀 | rights-core·백오피스 tsc, 백오피스 build, vcrl smoke(`5dc63e54…`), `npm run scenario -- --settle 30000` PASS |
| 수동 진행(브라우저, 화면만) | 11단계 모두 완료 — 권리자 8 → 정책 v1 ACTIVE → 팩 ACTIVE → 발행 3 → 구매 4(FLAGGED 1)·배치 전 부분 환불 1 → 시계 +30일·+3일 → 배치 `bat_202601_1` run 3 VERIFIED → `usr_settle` 확정·원장 반영 3/3 → 확정 후 전액 환불 → 역분개 1 → FRAUD_REVIEW 보류 35,000원 제안대로 해제(RELEASED) → `usr_settle2` 프로필 7명(냉각 표시) → `pty_label` PSP 결과 FAILED 지정·시계 +30일 → `usr_settle` 지급 run: PAID 3 · FAILED 1(`pty_label` 37,800원 복원) · CARRIED 3, 원천징수 ⌊총액×330/10000/10⌋×10 일치, 중복 webhook 1건만 저장 → 명세 대조(PAID·FAILED·CARRIED 권리자) 항등식·부채 잔액 모두 일치, 분개 13건, 점검 배지 정상, 대시보드 체크리스트 11/11 완료 |
| E2E 정상 경로 관찰값 | 발행 3, run 3, SETTLEMENT 분개 3, 지시 PAID 2 · FAILED 1 · CARRIED 4, 명세 대조 일치 |
| 거부 경로(E2E) | 정산 불가 조합 422 `ISSUE_NOT_SETTLEABLE`, 승인자의 활성화 403 `ROLE_REQUIRED`, 냉각 중 `HELD`/`ACCOUNT_COOLING`, 판정 뒤 계좌 변경 `FAILED`/`ACCOUNT_CHANGED`(PSP submit 없음 — `submit-payout` 일시정지로 재현), 중복 webhook 201→200 · 이력 1 · `PAYOUT_SETTLED` 1 |
| 실행 환경 | macOS 26.6.2 · Node v26.7.0 · PostgreSQL 17.11(Docker) · pg-boss 12.35.0 · React 19.3 · Vite 7.3 · Playwright 1.63(Chromium) |

- 실행: `docker compose up -d` → `npm run dev:db -w rights-core`(처음 한 번) → `npm run dev -w rights-core`(:8080) → `npm run dev -w backoffice`(:5173), 또는 `.claude/launch.json`의 두 설정. E2E는 `npm run e2e -w backoffice`(실행 중인 두 서버를 재사용하고 테스트마다 `/dev/reset`).
- **12.2와 달라진 점**: (1) 정책 편집기는 시드하지 않고 읽기 전용 `GET /dev/seed/synthetic-song`을 쓴다(12.2-5 반영). (2) `first_payable_at`은 입력이 아니라 프로필 첫 등록 시각이다 — 정상 경로는 프로필 등록 뒤 +30일(초기 보류 30일·냉각 72시간). (3) 매출 화면의 정산 상태 펼침은 현재 사용자로 읽고 권한이 없으면 403과 안내를 보인다. 대리 조회는 두 곳뿐이고 둘 다 화면에 밝힌다 — 헤더 점검 배지(툴팁)와 대시보드 감사·9단계(`usr_settle`). (4) 거부 경로 2는 `ROLE_REQUIRED`만 단언한다 — `SOD_VIOLATION`은 승인·활성화 역할을 함께 가진 개발 사용자가 없어 도달할 수 없다. (5) webhook 응답은 첫 수신 201, 중복 200. (6) 격리(quarantine)는 발행 사전 검사 뒤로 API로 만들 경로가 없어 계약 테스트에서 선택적이다.
- **발견해 고친 결함**(태스크 리뷰·수동 진행): 가상 시계의 커밋 후 반영을 클라이언트 몽키패치에서 `db.tx`의 `onCommit` 훅으로, 초기화 이름 검사 우회 경로 제거·초기화 중 전체 큐 일시정지, 정책 목록 팩 필터가 집계를 왜곡, 한 연결 동시 쿼리(pg 경고), 사용자 전환이 반응하지 않음·캐시 키 오염, 정책 편집기가 시드, 매출 eventId 기본값 충돌(409), 대리 조회, 보류 해제 기준액(남은 보류액)·역분개 행에 작업 노출, 배치 생성 메시지 id, 접근성 이름 부분 문자열 충돌(여러 화면), 해제된 보류가 HELD로 보임, PSP 재조회(실시간 60초) 경쟁, 그리고 수동 진행에서만 드러난 3건 — 빈/없는 저장 사용자로 복구 불가, 폼 기본 시각이 헤더 시계 변경을 따르지 않음, 사용자 전환 뒤 원장 반영 진행이 멈춤.
- **남은 것**: 12.1 제외 항목(실제 로그인·인증 9.6-5, 권리자·파트너 포털 I-3, 실제 PSP, 제품 디자인), 11.5 I-2c 선행 과제. 최종 리뷰에서 `GET /batches/:id`·`GET /runs/:id`(I-2a 라우트, 인증 없음)에 SPACE_OPS·SPACE_SETTLE 검사를 붙였다. 남은 것: `GET /users`가 로그인한 누구에게나 사용자·역할 목록을 준다(9.6-5 인증 도입 때 역할 검사 또는 개발 전용으로), 백오피스 안내 섹션·시각 헬퍼 중복과 접근성 이름 규칙 문서화(정리 과제), `GET /runs/:id`는 합계만 준다(이벤트별 상세는 배치 run 표의 진단으로 대신), 여러 화면의 선택 목록·중복 검사가 첫 페이지(50~200건)만 본다, 진행 기록의 태스크별 Minor 목록.

