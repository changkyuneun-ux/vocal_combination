# VCRL 시스템 통합 아키텍처 설계

- **문서 상태**: 설계 합의(브레인스토밍 승인) — 구현 계획 수립 전
- **작성일**: 2026-09-29
- **버전**: v1.0
- **상위·참조 문서**:
  - `VCRL_아키텍처_코어규격_설계_v1.0.md` (VCRL 코어 규격, 12절 구현 반영 사항 1~52)
  - `../권리정산인프라_20260927/보컬조합_권리관리_정산인프라_기획설계_v1.0.md` (이하 "기획")
  - `../데이터모델_v2.7.md` (이하 "v2.7")
  - `../검증_승인_권리스탬프_설계.md`, `../정책게이팅엔진_설계.md`, `../라이선스_정산_모니터링_백오피스_개념설계.md`
- **범위**: 레퍼런스 구현이 끝난 VCRL 엔진(`03_구현문서_코드/vcrl`, 서브프로젝트 1)을 보컬조합 권리관리·정산 시스템에 연결하는 통합 아키텍처. 이번 사이클은 설계문서만 작성하며 구현은 로드맵(7.3)의 구현 사이클에서 한다.

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
- `03_구현문서_코드/`를 npm workspaces 루트(`vcrl`, `rights-core`)로 하고, `rights-core`는 `vcrl`의 빌드된 `dist`를 workspace 의존성으로 쓴다(1-D 배포 경로 검증).
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

1. **운영자 run 무효화·재대기 API**: `VERIFIED`·`CALCULATED` run을 운영자가 `VOIDED`로 돌리고 이벤트를 다음 배치로 보내는 경로, 멈춘 `PENDING` run의 작업 재전송.
2. **결정적 실패 격리**: 같은 입력으로 반드시 다시 실패하는 run(예: 10.4의 단독 가창 조합 `ALLOC_INFEASIBLE`)의 이벤트를 매 배치 재시도하지 않도록 격리 상태·사유를 두고, 해소(정책 수정·수동 처리) 뒤에만 다시 후보로 올린다.
3. **미반영 환불 대사 쿼리**: 기록된 환불 중 run 순액(`settlement_run_event_refund`)·run 무효화·역분개(`reversal_run`) 어느 쪽에도 반영되지 않은 것을 찾는 점검 쿼리와 경보.
4. **배치 일괄 INSERT**: 배치 생성의 행 단위 INSERT(3만 건 10.9초, 그동안 환불 기록 대기)를 일괄 INSERT나 분할로 바꾼다.
5. **INSERT 경로 가드**: 0011 가드는 UPDATE·DELETE만 막는다. 끝 상태가 아닌 초기 상태로만 INSERT(`settlement_batch` `OPEN`, `settlement_run` `PENDING`, 확정·검증 필드 NULL), 확정된 배치에 run 추가 금지 등을 트리거로 강제한다.
6. **`source_revision` 대체 규칙**: 10.2-2의 `REVISION_UNSUPPORTED`를 대체(이전 revision 무효화·차액 역분개) 규칙으로 바꾼다.
7. **운영 마이그레이션·pg-boss 설치 스크립트**: 지금은 테스트 템플릿 DB를 만들 때만 마이그레이션과 pg-boss 스키마 설치(`installJobSchema`)를 돌린다. 운영 DB용 마이그레이션 실행·pg-boss 스키마 설치·`rc_app` 권한 부여 스크립트가 필요하다.
8. **커넥션 풀과 워커 동시 수**: 워커 기본값(배치 20·동시 4, 큐 4개 → 최대 16 핸들러)이 DB 풀(`max: 10`)을 HTTP·Outbox와 나눠 쓴다. 풀 크기를 환경 변수로 받거나 워커 동시 수에 맞춘다.
9. **어댑터 연결 순서**: 정정(revision)을 보내는 실제 결제 어댑터는 6번(대체 규칙) 이후에 붙인다(그 전에는 `REVISION_UNSUPPORTED`로 계속 거부된다).

---

## 11. I-2b 원장·지급 설계 결정 (2026-09-30)

### 11.1 범위

- 포함: 복식 원장(분개·전기, 확정 배치·역분개 반영), 보류 해제, 지급 지시(최소지급 이월·초기 지급 보류·원천징수), 지급 사업자(PSP) 연동 인터페이스와 가짜 어댑터(멱등 전송·결과 불명 재조회·webhook inbox), 권리자 명세 API, 발행 사전 검사와 발행 봉인 격리, 10.5 선행 과제(1 운영자 run 무효화·재큐잉, 3 미반영 환불 점검, 4 배치 일괄 INSERT, 5 INSERT 경로 가드, 6 `source_revision` 대체, 7 운영 마이그레이션·pg-boss 설치 스크립트, 8 DB 풀 크기).
- 제외: 실제 PSP·은행 연동과 계약, 세무 신고 파일, 다통화, 매출 채권의 대금 회수(collection) 대사, KMS·DB 차원 직무 분리·Outbox 재시도·봉인 조회 인증(I-2c), 10.5-9(어댑터 연결은 실제 어댑터 도입 때).

### 11.2 결정

1. **정산 불가 조합(제품 결정)**: 발행 트랜잭션에서 활성 정책과 발행 봉인으로 가상 이벤트(정책 범위의 첫 이벤트 유형, 금액 1,000,000)를 vcrl `evaluate`로 미리 평가해 진단이 나오면 422 `ISSUE_NOT_SETTLEABLE`로 발행을 거부한다(트랜잭션 롤백). 이미 발행된 조합의 run이 엔진 진단으로 `FAILED`가 되면 그 발행 봉인을 **격리**(`quarantine`)하고, 이후 배치는 그 봉인의 이벤트를 `ENGINE_FAILED`로 건너뛴다. 운영자(`SPACE_SETTLE`)가 격리를 해제하면 다시 후보가 된다. 봉인된 입력에 대한 엔진 진단은 결정적이므로 재평가해도 같은 결과다.
2. **복식 원장**: 계정(`ledger_account`) 종류 `RECEIVABLE`, `POOL_PLATFORM`, `POOL_OPS`, `POOL_FAN`, `POOL_OTHER`, `PARTY_PAYABLE`(권리자별), `HOLD`(사유별), `WITHHOLDING_TAX`, `PSP_CLEARING`, `CASH`. 금액 부호는 차변 +, 대변 −. 분개(`journal_entry`) 하나의 전기(`posting`) 합은 0이어야 하며 커밋 시점 지연 제약 트리거로 강제한다. 분개는 `source_ref` UNIQUE로 멱등이고 추가만 허용한다. 잔액은 전기의 합이다(부채 계정의 잔액은 −합).
3. **tier1 버킷 → 계정**: 권리 풀 버킷(`policy.body.tier1.rights`)은 라인·보류로 내려가므로 계정이 없다. 나머지는 `platform → POOL_PLATFORM`, `ops → POOL_OPS`, `fan → POOL_FAN`, 그 밖의 이름 → `POOL_OTHER`(계정 이름에 버킷 이름).
4. **원장 반영**: 배치 확정 트랜잭션이 `post-batch` 작업을 보내고, 처리기는 확정 run마다 분개 하나(`SETTLEMENT`, `source_ref = run:<run_id>`)를 쓴다. 이벤트마다 `RECEIVABLE +순매출`, 비권리 풀 `−금액`, 라인 `PARTY_PAYABLE(party) −금액`, 보류 `HOLD(reason) −금액`. 역분개는 `reverse-event` 트랜잭션 안에서 반대 부호 분개(`REVERSAL`, `source_ref = rev:<reversal_id>`)를 함께 쓴다.
5. **보류 해제**(`SPACE_SETTLE`): 운영자가 권리자별 배분(합 = 보류액)을 지정해 해제한다. `FRAUD_REVIEW`는 봉인 입력으로 무결성 `CLEAR`를 가정해 다시 평가한 배분을 제안하는 조회 API를 둔다(제안일 뿐 적용은 운영자). 분개 `HOLD_RELEASE`: `HOLD(reason) +보류액`, `PARTY_PAYABLE(p) −배분`. 보류 하나는 한 번만 해제된다. **해제된 보류를 나중에 역분개**하면 보류 계정 대신 해제 배분 비율(최대 잔여법, 동률 party_id 오름차순)로 해당 권리자 미지급금에서 뺀다.
6. **지급 지시**(`payout-run`, 운영자가 기준 시각을 지정): 권리자별 미지급금 잔액이 지급 대상액이다(이월은 잔액에 자연히 남는다). 다음이면 지시를 `CARRIED`(최소 지급액 미만·잔액 0 이하) 또는 `HELD`(첫 지급 가능 시각 + 초기 보류 일수 이전, 계좌 없음, KYC 미확인)로 남기고 분개하지 않는다. 지급할 때 원천징수 = ⌊총액 × 세율 bps / 10000 / 10⌋ × 10(10원 미만 절사), 분개 `PAYOUT`: `PARTY_PAYABLE +총액`, `WITHHOLDING_TAX −원천세`, `PSP_CLEARING −실지급액`. 기본 정책: 최소 지급액 10,000원, 초기 보류 30일, 세율 `DOMESTIC_INDIVIDUAL 330`·`DOMESTIC_CORP 0`·`FOREIGN 2200`·`EXEMPT 0` bps(설정 가능, **운영 전 세무 확인 필요**).
7. **PSP**: `PayoutProvider { submit(instruction, idempotencyKey) → ACCEPTED|PAID|FAILED|UNKNOWN; status(providerRef) }`. 지급 지시의 멱등 키는 `payout:<instruction_id>`. `submit-payout` 작업이 전송하고, `UNKNOWN`이면 새로 보내지 않고 `poll-payout`을 지연 전송해 재조회한다. webhook은 `psp_webhook_inbox`(`provider_event_id` UNIQUE)에 저장하고 `apply-psp-result`로 처리한다. `PAID` → 분개 `PAYOUT_SETTLED`(`PSP_CLEARING +실지급액`, `CASH −실지급액`), `FAILED` → 분개 `PAYOUT_FAILED`(`PAYOUT` 분개의 반대). 결과 적용은 지시 상태 전이 가드로 한 번만 일어난다. 가짜 어댑터는 금액·키에 따라 성공·실패·불명을 결정적으로 흉내 낸다.
8. **명세**: `GET /parties/:id/statements?from&to` — 기간 시작 잔액, 발생(정산), 역분개, 보류 해제 수령, 지급(총액·원천세·실지급), 지급 실패 복원, 기간 끝 잔액. 모두 전기에서 계산한다.
9. **운영자 run 조작**(`SPACE_SETTLE`): `POST /runs/:id/void`(`PENDING`·`CALCULATED`·`VERIFIED` → `VOIDED`, 이벤트 해제), `POST /runs/:id/requeue`(`PENDING` → `settle-run`, `CALCULATED` → `verify-run` 재전송).
10. **점검 API**: `GET /settlement/invariants` — (a) 반영되지 않은 환불(원 이벤트가 살아 있는 `CONFIRMED` run에 있는데 포함 환불 목록에도 역분개에도 없는 환불), (b) 원장 불변식(분개 합 0, `RECEIVABLE` 잔액 = 확정 순매출 − 역분개, 권리 풀 = 미지급금 + 보류 + 원천세 + PSP 정산 중 + 현금 − 비권리 풀 제외분), (c) 오래 멈춘 run(`PENDING`·`CALCULATED`가 기준 시간 초과).
11. **`source_revision` 대체**: 새 revision은 같은 유형·같은 `vc_id`여야 하고, 이전 revision에 환불이 있으면 422 `REVISION_HAS_REFUNDS`. 기록 시 `revenue_supersede(old, new)`를 남기고 `revision-recorded` 작업을 보낸다. 처리: 이전 revision이 살아 있는 run에 없으면 없음(배치는 대체된 이벤트를 후보에서 뺀다), 확정 전 run이면 run 무효화, 확정 run이면 이전 revision의 남은 정산액 전액을 `CORRECTION` 역분개(역분개 식별 이벤트 = 새 revision)하고 새 revision은 다음 배치에서 정산된다. 10.2-2의 `REVISION_UNSUPPORTED`는 이 규칙으로 대체한다.
12. **INSERT 경로 가드**: `settlement_batch`는 `OPEN`으로만, `settlement_run`은 `PENDING`·디지스트·검증 필드 NULL·배치 `OPEN`일 때만, `settlement_run_event`는 run이 `PENDING`일 때만, `line_seq = 1` 라인·보류는 run이 `PENDING`일 때만, `line_seq > 1`은 run이 `CONFIRMED`일 때만 INSERT된다.
13. **배치 일괄 INSERT**: run·run 이벤트·포함 환불을 `unnest` 배열로 한 번에 넣어 전역 배치 잠금 보유 시간을 줄인다.
14. **운영 스크립트·설정**: `npm run migrate`(소유자 역할로 마이그레이션, pg-boss 스키마 설치·큐 생성, `rc_app` 권한), DB 풀 크기 `RC_DB_POOL_MAX`(기본 20). 템플릿 DB 해시에 작업 이름 목록을 넣는다(큐가 템플릿에서 생성되므로).

### 11.3 완료 기준

- 원장: 모든 분개 합 0, 확정·역분개·해제·지급·성공·실패가 올바른 계정에 전기, `source_ref` 멱등.
- 보류 해제·해제 후 역분개, 지급(최소액 이월, 초기 보류, 원천징수 절사, 음수 잔액 이월, 멱등 재전송, webhook 중복, 불명 → 재조회, 실패 복원), 명세 합계 = 전기 합계.
- 사전 검사: 정산 불가 조합 발행 422. 격리: 이후 배치 건너뜀, 해제 후 재대상.
- 선행 과제 각각의 테스트. 시나리오: 3만 건 정산 뒤 원장 반영·보류 일부 해제·지급(가짜 PSP 성공·실패·불명 섞음) → 원장 불변식과 명세 합계 대조, 처리 시간 리포트.
