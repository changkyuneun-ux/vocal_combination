# 3부-B 계약서 불러오기 · 읽기 틀 · 권리 확인서 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 원본 계약서를 불러오면 다음이 이어지게 한다.
1. 계약 양식별 **읽기 틀**이 권리 정보 후보를 채운다.
2. 사람이 후보를 확인하고, IR에 필요한 것 중 빠진 것을 입력한다.
3. **권리 확인서**(레이블용·작가용)에 서명하면 권리 주장이 서명본을 근거로 바로 `VERIFIED`가 된다.

결정 CT1~CT5, 진행 CT-S2~S4.

**Architecture:**
- 코어
  - 읽기 틀(`contract_reading_frame`)과 불러오기 세션(`contract_import`, 후보 값 `import_value`)을 더한다.
  - 표준 계약 템플릿에 새 기록 종류 `CLAIM_CONFIRM`을 더한다. 이 종류의 `plan()`은 권리 주장(작가 지분 `WRITTEN_BY`, 마스터 보유 `CONTROLLED_BY`)을 만든다.
  - 서명이 끝나 "기록 반영"을 하면 기존 길 B(`apply`)로 `recordClaim(status VERIFIED, evidence = 서명본 + 원본)`을 부른다.
  - 같은 주장이 `ASSERTED`로 있으면 새 버전으로 대체하고, 열린 확인 요청을 닫는다.
- 값 읽기는 **사람이 지정한 위치의 텍스트를 사람이 확인하는 방식**이다.
  - 원본 PDF 텍스트를 서버에서 뽑지 않는다(자동 추출 없음, CT1).
  - 읽기 틀은 "이 양식의 몇 쪽 몇 조 = 어느 IR 항목"과 **값 모양(예: `작가 갑의 지분은 {bps}퍼센트`)**을 담는다.
  - 불러오기 때 사용자가 그 조항의 인용 문장을 붙여 넣으면(또는 이전 같은 양식 계약의 값을 기본값으로 쓰면) 모양에 맞춰 값을 뽑아 후보로 만든다.
  - PDF 텍스트 레이어 읽기는 범위 밖이다. 가능 여부만 보고한다.
- 화면: 3부-A의 포털 틀 위에 `Song-Import`·`Song-ClaimConfirm` 화면과 계약 템플릿 화면의 읽기 틀 표를 만든다.

**Tech Stack:** rights-core(Fastify, PostgreSQL, node:test), backoffice(React 19, react-query 5, react-router 7, vitest, Playwright)

**시안(엄격 준수):** `06_MVP/mockup/console/project/Song-Import.dc.html`, `Song-ClaimConfirm.dc.html`, `Ops-Templates.dc.html`(읽기 틀 표, 권리 확인서 행). 마크업 기준은 `tools/gen_ops_mockups.py`(`ws_page`, `steps`, `check`, `field`, `chips`).

**결정:** `00_프로젝트_개요/계약서_불러오기와_목록_쪽나눔_검토_20261023.md` 1부(CT1~CT5).
- 원천 문서 설계의 D2(자동 추출 안 함)는 CT1로 다시 열었다. 외부 반출 없이 읽기 틀 방식으로 간다.

**선행:** 3부-A(`2026-10-23-portal-sidebar-ops-paging.md`)가 `feat/works-ui`에 끝나 있어야 한다(사이드 메뉴 틀, `PageNav`).

## Global Constraints

- 브랜치 `feat/works-ui`(3부-A 뒤). master를 먼저 합친다
- 계약서 원본은 플랫폼 밖으로 보내지 않는다. 외부 모델이나 외부 API 호출은 금지(CT1)
- 원천 문서·조항·확인 기록은 지금처럼 바꿀 수 없다(트리거 `rc_reject_mutation`). 읽기 틀도 승인 뒤에는 바꿀 수 없고 새 버전으로 바꾼다
- 읽기 틀: 권리 테넌트가 등록(`contract.draft`)하고 플랫폼이 승인(플랫폼 소속, 권한 `contract.template.approve`가 없으면 새로 만든다). 직무 분리는 꺼짐(RD6)이라 총괄 한 사람이 둘 다 할 수 있다
- 권리 확인서 템플릿 2종은 플랫폼 법무 템플릿이다. 시드는 `seeded=true`, `APPROVED` v1
- 위탁 작가(플랫폼 밖 당사자)는 서명 대신 운영 원문 대조로 확인한다(CT4). 지금 `platformVerify` 흐름을 확인서 서명자 상태와 이어 붙인다
- 확인서는 원본을 대체하지 않는다(CT3). 서명본 원천 문서의 근거 목록에 원본 문서와 조항을 함께 건다
- 기존 길 A(업로드 + 조항 표시)와 길 B(표준 계약)는 그대로 동작해야 한다
- 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 데이터

```sql
-- 계약 양식 읽기 틀. 승인 뒤 바꿀 수 없고 새 버전으로.
contract_reading_frame (frame_id, version, owner_tenant_id, title, document_kind /* PUBLISHING·MASTER_CONTRACT */,
  fields JSONB /* [{key, label, irItem: 'WORK_TITLE'|'AUTHOR'|'AUTHOR_SHARE'|'EFFECTIVE_FROM'|'RECORDING'|'MASTER_OWNER', page, clause, pattern}] */,
  status /* DRAFT·APPROVED·RETIRED */, authored_by, authored_at, approved_by, approved_at, PRIMARY KEY (frame_id, version))
-- 불러오기 한 번. 문서 하나, 곡 하나.
contract_import (import_id, facts_scope_id, document_id, document_version, frame_id NULL, frame_version NULL,
  step /* VALUES·GAPS·READY·CONFIRM_SENT·DONE */, created_by, created_at, contract_id NULL /* 만든 권리 확인서 */)
-- 후보 값. 사람이 확인하거나 고친다(행은 추가만, 고치면 새 행).
import_value (import_id, key, seq, value JSONB, page, clause, quote, origin /* FRAME·MANUAL */, compared /* SAME·NEW·DIFFERENT */,
  confirmed_by NULL, confirmed_at NULL, PRIMARY KEY (import_id, key, seq))
```

- `irItem`은 1.4 표의 항목 이름과 맞춘다. 빠진 것 입력값(이용 범위·지역·기간)도 `import_value`(origin MANUAL)로 남긴다.

## 파일 구조

| 파일 | 할 일 |
| --- | --- |
| `services/rights-core/migrations/0044_contract_import.sql`(새) | 위 세 표, RLS(소유 테넌트·플랫폼), 불변 트리거, `contract_template.record_kind`에 `CLAIM_CONFIRM` 추가, 권리 확인서 템플릿 2종 시드 |
| `services/rights-core/src/contracts/frames.ts`(새) | 읽기 틀 등록·승인·목록·적용(`applyFrame(frame, quotes) → 후보 값`) |
| `services/rights-core/src/contracts/imports.ts`(새) | 불러오기 시작·후보 확인·빠진 것 입력·IR 대조·확인서 만들기 |
| `services/rights-core/src/contracts/service.ts` | `plan()`에 `CLAIM_CONFIRM`, `apply()`에 `recordClaim` 길, 위탁 작가 서명자 처리 |
| `services/rights-core/src/registry/readiness.ts` | `irGaps(scope)` — 1.4 표 기준 채움·빠짐·진행 중(CT-S4) |
| `services/rights-core/src/contracts/routes.ts` | API(아래) |
| `apps/backoffice/src/pages/works/tabs/ContractImport.tsx`(새) | 시안 `Song-Import` |
| `apps/backoffice/src/pages/works/tabs/ClaimConfirm.tsx`(새) | 시안 `Song-ClaimConfirm` |
| `apps/backoffice/src/pages/ops/Templates.tsx` | 권리 확인서 행, 읽기 틀 표, "+ 읽기 틀 등록" |
| `apps/backoffice/src/pages/works/tabs/Contracts.tsx` | 표준 계약 카드 머리의 "계약서 불러오기" 보조 버튼(시안 `Song-Contracts`, 2026-10-23 추가) → 불러오기 화면 |
| `apps/backoffice/e2e/stack-contract-import.spec.ts`(새) | Dynamite 퍼블리싱 계약서 불러오기 → 확인서 → 운영 대조 → 경고 2 닫힘 |

## API

| 메서드 · 경로 | 하는 일 |
| --- | --- |
| `GET /reading-frames?page` · `POST /reading-frames` · `POST /reading-frames/:id/versions/:v/approve` | 읽기 틀 |
| `POST /scopes/:id/imports` `{documentId, frameId?}` | 불러오기 시작. 틀이 있으면 이전 같은 양식 값과 틀 위치로 후보를 만든다 |
| `GET /imports/:id` | 단계, 후보 값(근거·비교·확인), IR 대조, 빠진 것 |
| `POST /imports/:id/values/:key` `{value?, quote?, confirm: true}` | 후보 확인·고침 |
| `POST /imports/:id/gaps` `{usage, territory, validTo}` | 빠진 것 입력 |
| `POST /imports/:id/confirmation` `{kind: "AUTHOR"\|"LABEL"}` | 권리 확인서 계약 만들기(템플릿 변수를 후보 값으로 채움 → 기존 `prepare`/`send`) |
| `GET /scopes/:id/claim-confirmations` | 이 곡의 확인서 목록(레이블용·작가용 상태) |

## Tasks

### Task 0: master 합치기, 3부-A 끝 확인
- [ ] `git merge master`를 하고 3부-A 시험이 통과하는지 확인한다.

### Task 1: 마이그레이션 0044와 템플릿 시드
- [ ] 실패하는 시험을 먼저 쓴다: 표·RLS·불변·`CLAIM_CONFIRM` 템플릿 2종 `APPROVED` 시드.
- [ ] 구현하고 통과시킨다.
- [ ] 확인서 조항 문구는 시안 `Song-ClaimConfirm` 미리보기의 제1조~제5조 그대로 쓴다.
- [ ] 커밋한다.

### Task 2: 읽기 틀
- [ ] `applyFrame` 순수 함수 시험부터 쓴다.
  - `pattern`의 `{bps}`·`{percent}`·`{date}`·`{text}`·`{party}`를 인용 문장에서 뽑는다.
  - 안 맞으면 후보를 만들지 않고 "사람이 입력"으로 둔다.
- [ ] 등록·승인 API를 만든다(승인 뒤 불변, 새 버전).
- [ ] 커밋한다.

### Task 3: 불러오기 세션과 IR 대조(CT-S2, CT-S4)
- [ ] 시험부터 쓴다.
  - 시작: 문서 종류와 틀의 `document_kind`가 같아야 한다.
  - 후보 확인: 비교 SAME·NEW·DIFFERENT는 현재 주장 값과 대조한다.
  - DIFFERENT는 어느 쪽을 쓸지 사용자가 고른다.
  - 빠진 것 입력.
  - `irGaps`: 빠짐이 남으면 `READY`가 되지 않는다(409 `IMPORT_GAPS`).
- [ ] 구현하고 커밋한다.

### Task 4: 권리 확인서 → VERIFIED 주장(CT5)
- [ ] 시험부터 쓴다.
  - 작가용: 작가 지분 합이 100%가 아니면 거부한다.
  - 서명자는 작가 전원이다. 위탁 작가는 서명 대신 `platformVerify`로 완료로 친다.
  - 모두 끝나면 "기록 반영"을 한다.
    - `WRITTEN_BY` 주장을 `VERIFIED`로 만든다. 기존 `ASSERTED`가 있으면 새 버전으로 대체하고, 열린 확인 요청을 닫는다.
    - 작품 이용 동의를 만든다.
    - 서명본을 원천 문서(`TEMPLATE_SIGNED`)로 남기고 원본 문서와 조항을 근거로 연결한다.
  - 레이블용: `CONTROLLED_BY` 마스터 보유.
  - 정합성 재검사로 확인 대기 경고가 닫힌다.
- [ ] 구현하고 커밋한다.

### Task 5: 화면 — 계약서 불러오기, 권리 확인서, 계약 템플릿
- [ ] `Song-Import`를 만든다: 단계 5개, 불러온 계약서, 후보 값 표(확인 칸), IR 정보 대조, 빠진 것 입력, 버튼 2개.
- [ ] `Song-ClaimConfirm`을 만든다: 확인서 미리보기, 서명, 만들어지는 기록, 이 곡의 확인서 2부.
- [ ] `Ops-Templates`: 권리 확인서 2행과 읽기 틀 표를 더한다. "+ 읽기 틀 등록" 폼은 시안이 없으니 **만들기 전에 시안을 요청**한다(보고에 "시안 추가 필요").
- [ ] 1440 폭에서 시안과 나란히 비교해 차이를 0으로 만든다.
- [ ] 커밋한다.

### Task 6: 들어가는 곳과 E2E
- [ ] 문서·계약 탭 표준 계약 카드 머리에 "계약서 불러오기" 보조 버튼(시안 `Song-Contracts`, "+ 계약 만들기" 왼쪽)을 둔다.
- [ ] E2E: Dynamite 퍼블리싱 계약서(시드 원천 문서)를 불러온다 → 후보 4개를 확인한다 → 빠진 것을 입력한다 → 작가용 확인서를 만든다 → 운영 원문 대조 2건 → 기록 반영 → 정합성 점검 전체에서 경고가 0이 되는지 확인한다.
- [ ] 코어·화면·E2E가 모두 통과한 출력과 "시안 준수" 표를 보고한다.
