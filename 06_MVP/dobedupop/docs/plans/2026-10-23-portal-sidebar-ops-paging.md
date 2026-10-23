# 3부-A 포털 사이드 메뉴 · 운영 관리 화면 · 목록 쪽 나눔 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 권리 테넌트 포털을 확정 시안대로 바꾼다.
- 가로 메뉴를 빼고 **아코디온 사이드 메뉴**(작품 관리 / 운영 관리)를 단다.
- **운영 관리 화면 12개**(확인 요청 전체 포함)를 만든다.
- **모든 목록 표를 10행 단위 쪽 번호**로 나눈다. 코어 목록 API에도 쪽 번호 방식(`page`·`size`·`total`)을 더한다.

**Architecture:**
- 코어: 공통 쪽 번호 헬퍼를 더하고, 운영 관리·작품 목록이 쓰는 목록 API에 `?page=&size=`와 서버 필터를 붙인다. 기존 커서 방식은 그대로 둔다(같은 경로에서 `page`가 있으면 쪽 번호 응답).
- 화면: `PortalShell`을 머리글 + 사이드 메뉴 + 본문 틀로 바꾼다. 공통 `PageNav`(쪽 나눔 줄) · `usePaged`(서버 쪽 번호) · `paginate`(작은 목록을 화면에서 나눔)를 둔다. 운영 관리 화면은 `src/pages/ops/`에 새로 둔다.

**Tech Stack:** rights-core(Fastify, PostgreSQL, node:test), backoffice(React 19, react-query 5, react-router 7, vitest, Playwright)

**시안(원본, 엄격 준수):** `06_MVP/mockup/console/project/`
- 틀: `Sidebar.dc.html`, `Nav-Works-Stems.dc.html`
- 운영 관리: `Nav-Ops-Confirm.dc.html`, `Ops-*.dc.html` 11개
- 쪽 나눔: `Catalog.dc.html` 표 아래 줄
- 생성기: `06_MVP/mockup/console/tools/gen_ops_mockups.py`(`pager()`·`table()`이 마크업 기준)

**디자인 기준:** [디자인_가이드.md](../디자인_가이드.md) 1절 규칙, 4절 화면 틀(사이드 메뉴), 5절 컴포넌트(쪽 나눔·빈 목록), 6절 비교 절차, 그리고 `apps/backoffice/CLAUDE.md`.
- 시안에 없는 요소는 더하지 않는다.
- 구현 뒤 1440 폭에서 시안 보드와 나란히 스크린샷을 찍어 차이를 0으로 만든다.

**결정:** `00_프로젝트_개요/계약서_불러오기와_목록_쪽나눔_검토_20261023.md` 2부(PG1~PG4), 디자인 가이드 4절(사이드 메뉴 구성, 두 곳 배치, 플랫폼 열람 기록 제외, 위임 대행·신탁·유통 연결 빈 화면)

**이 계획 밖(3부-B):** 계약서 불러오기·읽기 틀·권리 확인서(CT-S2~S4). 시안 `Song-Import`·`Song-ClaimConfirm`과 `Ops-Templates`의 읽기 틀 표는 3부-B에서 만든다. 이 계획의 계약 템플릿 화면은 템플릿 표만 그린다.

## Global Constraints

- 브랜치 `feat/works-ui`에서 이어 한다. 먼저 master를 합친다(시안·가이드·결정 문서가 master에 있다)
- 코어 `npm test`, 화면 `npm test`·`npm run typecheck`, E2E `npm run e2e -- <spec>`(데모 스택 기동 방법은 기존 `e2e/stack-*.spec.ts`를 따른다)
- 포털(`kind === "portal"`)만 바꾼다. 운영 앱·참여 기관 앱의 틀과 메뉴는 그대로 둔다
- 기존 커서 목록 API의 동작과 응답은 바꾸지 않는다. `page`가 오면 쪽 번호 응답 `{ items, page, size, total }`(size 기본 10, 최대 100)
- 색은 `portal.css` 토큰만. 사이드 메뉴·쪽 나눔 스타일 수치는 시안(가이드 4·5절) 그대로
- 시각은 `<Instant>`, 금액·비율은 `src/format.ts`
- 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 파일 구조

| 파일 | 할 일 |
| --- | --- |
| `services/rights-core/src/platform/paging.ts` | `parsePageNo(q)` → `{page,size,offset}`, `pageNoResult(rows,total,p)` 추가 |
| 각 `routes.ts`(registry·contracts·documents·validation·issuance·ledger·platform) | PG2 목록에 쪽 번호·서버 필터 |
| `apps/backoffice/src/components/PageNav.tsx`(새) | 쪽 나눔 줄(시안 `pager()`) |
| `apps/backoffice/src/api/paged.ts`(새) | `usePaged(key, path, {page,size,filters})`, `paginate(rows, page, size)` |
| `apps/backoffice/src/app/PortalShell.tsx` | 머리글(가로 메뉴 없음, 권리 테넌트 배지, `/ 검색`) + `Sidebar` + 본문 |
| `apps/backoffice/src/app/Sidebar.tsx`(새) | 아코디온 3단계, 활성·접힘 규칙, 배지 |
| `apps/backoffice/src/app/routes.tsx` | 운영 관리 경로, 플랫폼 열람 기록 포털 경로 제거 |
| `apps/backoffice/src/pages/ops/*.tsx`(새) | 운영 관리 화면 12 |
| `apps/backoffice/src/pages/works/*` | 경로(breadcrumb) 문구, 표에 쪽 나눔 |
| `apps/backoffice/e2e/stack-portal-nav.spec.ts`(새) | 사이드 메뉴 이동·쪽 나눔·운영 관리 → 곡 워크스페이스 이동 |

---

### Task 0: master 합치기

- [ ] `git merge master`
  - 충돌이 나면 시안·가이드·결정 문서는 master 쪽을 쓴다.
  - 디자인 가이드 4절(사이드 메뉴)과 5절(쪽 나눔·빈 목록)을 읽는다.
- [ ] 코어·화면 시험이 그대로 통과하는지 확인하고 커밋한다.

### Task 1: 코어 — 쪽 번호 헬퍼

**Files:** Modify `src/platform/paging.ts`; Test `test/platform/paging.test.ts`

**Interfaces:**
- `parsePageNo(q): { page: number; size: number; offset: number } | null`
  - `q.page`가 없으면 null(커서 방식으로 처리).
  - page는 1 이상, size는 1~100(기본 10). 어긋나면 400 `BAD_REQUEST`.
- `pageNoResult<R>(items: R[], total: number, p) → { items, page, size, total }`

- [ ] 실패하는 시험(경계값, 기본값, 잘못된 값)을 먼저 쓰고, 구현하고, 통과시킨 뒤 커밋한다.

### Task 2: 코어 — 목록 API에 쪽 번호와 서버 필터(PG2)

**Files:** 아래 표의 routes·service. Test는 각 모듈 test 폴더(쪽 번호 응답, total, 필터, 커서 응답이 그대로인지).

| API | 쪽 번호 | 서버 필터(새) | 정렬 |
| --- | --- | --- | --- |
| `GET /works/overview` | 예 | `q`(곡명), `status`(진행 단계) | 곡명 |
| `GET /confirmations` | 예 | `scope`, `status`, `counterparty`(MEMBER·PLATFORM_AUTHOR 등 화면 구분) | 요청 시각 내림차순 |
| `GET /consents` | 예 | `scope`, `status` | 동의 시각 |
| `GET /contracts` | 예 | `scope`, `template`, `status` | 만든 시각 내림차순 |
| `GET /documents` | 예 | `scope`(곡·조직), `kind`(직접 올림·서명본) | 효력 시작 |
| `GET /validation-issues` | 예 | `scope`, `severity`(경고 이상 기본) | 심각도, 발견 시각 |
| `GET /issues` | 예 | `pack`(있던 것을 화면이 쓰게), `scope` | 발행 시각 |
| `GET /parties/:id/statements` | 예 | `period` | 기간 |
| `GET /users` | 예 | 테넌트 | 사용자 id |

- [ ] 공통: `COUNT(*) OVER()`로 total을 함께 읽는다. RLS 범위는 그대로 둔다. LIMIT 없이 전부 돌려주던 경로도 `page`가 없으면 지금과 같은 응답을 준다(기존 화면을 깨지 않는다).
- [ ] 각 API마다 TDD로 진행하고, API 하나당 커밋 하나.
- [ ] `/works/overview`의 LIMIT 500 말없이 자르기를 없앤다(쪽 번호에서는 total이 정확해야 한다).

### Task 3: 화면 — 쪽 나눔 공통

**Files:** Create `src/components/PageNav.tsx`, `src/api/paged.ts`, `src/api/paged.test.ts`; Modify `src/portal.css`

**Interfaces:**
- `<PageNav page total size onPage />`
  - 시안 마크업 그대로: `nav[aria-label="쪽"]`, 범위 `1–10 / 13`(Mono 13px), `‹` 버튼(`aria-label="이전 쪽"`), 쪽 번호, `›` 버튼(`aria-label="다음 쪽"`).
  - 지금 쪽은 `aria-current="page"`.
  - 쪽이 많으면 앞뒤 2쪽 + 처음·끝 + `…`.
- `<PagedTableFoot note? >{PageNav}</PagedTableFoot>`: 표 카드 맨 아래 줄. 왼쪽은 설명, 오른쪽은 PageNav.
- `usePaged<T>(key, path, { size = 10, filters })` → `{ rows, page, setPage, total, isLoading, error }`. 필터가 바뀌면 1쪽으로 간다.
- `paginate<T>(rows, page, size = 10)` → `{ rows, total }`. 곡 단위 작은 목록에 쓴다(PG3).
- 빈 목록: 표 머리는 그대로 두고, 본문 한 칸에 가운데 정렬 안내를 둔다(가이드 5절 "빈 목록").

- [ ] vitest로 `paginate`와 쪽 번호 계산(`…` 규칙)을 시험한다.
- [ ] 컴포넌트를 만든다.
- [ ] 기존 `Pager`("더 보기")는 포털 화면에서 쓰지 않게 바꾸는 것까지 이 계획에서 한다(Task 6).

### Task 4: 화면 — 포털 틀(머리글 + 사이드 메뉴)

**Files:** Modify `src/app/PortalShell.tsx`, `src/portal.css`, `src/app/routes.tsx`; Create `src/app/Sidebar.tsx`, `src/app/sidebar.test.ts`

머리글은 `Nav-Works-Stems.dc.html` 그대로다.
- 왼쪽부터: `dobedupop`, `빅히트 뮤직 ▾`, 배지 `권리 테넌트`, 빈칸, `/ 검색`, 데모 시계, `총괄 · usr_admin`.
- 가로 메뉴(`PORTAL_NAV`)는 없앤다.
- 개발 도구 띠(DevStrip)는 지금처럼 머리글 아래에 둔다.

사이드 메뉴는 `Sidebar.dc.html` 그대로다(260px, 스타일 수치는 가이드 4절).

| 1단계 | 2단계 | 3단계 → 경로 | 배지 |
| --- | --- | --- | --- |
| 작품 관리(곡 단위) | 작품 목록 → `/works` | | 곡 수 |
| | 새 곡 워크스페이스 → `/works/new` | | |
| | 작품 워크스페이스 | 지금 연 곡 이름 + 상태 배지, 그 아래 원곡 권리·스템·확인·동의·문서·계약·분배 규칙·팩·승인·출시 → `/works/:id/<tab>` | 스템 수, 확인 대기(주황), 계약 수 |
| | 최근 연 작품 | 최근 연 곡 최대 5개(브라우저 저장, 실패해도 동작) | |
| 운영 관리(여러 곡 · 조직) | 확인·동의 | 확인 요청 전체 `/ops/confirmations` · 멤버 이용 동의 `/ops/consents` | 대기 수(주황), 동의 수 |
| | 계약·문서 | 표준 계약 전체 `/ops/contracts` · 원천 문서 `/ops/documents` · 계약 템플릿 `/ops/templates` | 서명 대기(주황), 문서 수 |
| | 점검 | 정합성 점검 전체 `/ops/validation` | `경고 N`(주황) |
| | 정산 | 명세·지급 `/ops/statements` · 발행 조합 `/ops/issues` | |
| | 조직 | 내 조직 `/` · 담당자 계정 `/accounts` · 위임 대행 `/delegation` · 신탁·유통 연결 `/links` | |

- 지금 곡: 경로 `/works/:id/*`면 그 곡을 지금 곡으로 기억한다. 다른 곡으로 갈 때는 작품 목록에서 연다. "다른 작품 열기" 메뉴는 없다.
- 펼침 기본값: 시안 `Sidebar.dc.html`의 `renderVals`를 그대로 옮긴다.
  - 지금 화면이 든 묶음은 펼친다.
  - 운영 관리 화면에서는 지금 화면이 든 묶음만 펼친다.
  - 작품 화면에서는 확인·동의와 계약·문서를 펼친다.
  - 접힌 묶음 안에 지금 화면이 있으면 묶음 이름을 600 굵기로 보인다.
- 접근성: 펼치는 버튼은 `aria-expanded`, 지금 화면은 `aria-current="page"`, nav는 `aria-label="권리 테넌트 메뉴"`.
- 메뉴 노출은 `/me`의 `permissions`로 한다(1부 RBAC). 권한이 없는 항목은 숨긴다.
- 포털 경로에서 `/inspections`(플랫폼 열람 기록)를 뺀다.
- 경로 표시(breadcrumb)
  - 작품 화면: `작품 관리 › 작품 워크스페이스 › 곡명 › 화면`
  - 운영 관리 화면: `운영 관리 › 묶음 › 화면`
  - 워크스페이스의 탭 줄은 그대로 둔다(결정: 탭 유지).
- `sidebar.test.ts`에서 순수 함수 `sidebarModel(path, currentWork, counts, permissions)`를 시험한다: 펼침 기본값, 활성, 굵게, 권한 숨김.

- [ ] TDD로 모델을 만든다 → 컴포넌트 → 틀을 교체한다 → 기존 E2E(`stack-works` 등)의 메뉴 선택자를 고친다 → 커밋한다.

### Task 5: 화면 — 운영 관리 12개

**Files:** Create `src/pages/ops/{Confirmations,Consents,Contracts,Documents,Templates,Validation,Statements,Issues}.tsx`; Modify `src/pages/org/{Home,Accounts,Delegation,Links}.tsx`(내 조직·담당자 계정·위임 대행·신탁·유통 연결); Modify `routes.tsx`

화면마다 시안을 하나씩 맞춘다(구조·문구·현황 카드·필터·표 열·설명·이동 링크). 데이터는 Task 2의 쪽 번호 API에서 가져온다.

| 화면 | 시안 | 데이터 | 비고 |
| --- | --- | --- | --- |
| 확인 요청 전체 | `Nav-Ops-Confirm` | `/confirmations?page&status&scope&counterparty` | 행의 "곡 워크스페이스 › 확인·동의 →" 링크는 `/works/:id/confirm` |
| 멤버 이용 동의 | `Ops-Consents` | `/consents?page` | 조회만, 다시 알림 버튼 없음 |
| 표준 계약 전체 | `Ops-Contracts` | `/contracts?page&scope&template&status` | 수령 위임 6건 묶음 표시는 곡 탭과 같은 규칙(`model.ts` 재사용) |
| 원천 문서 | `Ops-Docs` | `/documents?page&scope&kind` | "+ 문서 올리기"는 기존 업로드 흐름으로 |
| 계약 템플릿 | `Ops-Templates` | `/contract-templates` → `paginate` | 표준 계약 템플릿 표만(읽기 틀·권리 확인서는 3부-B) |
| 정합성 점검 전체 | `Ops-Validation` | `/validation-issues?page&severity&scope` | "규칙별 결과" 카드는 곡별 `/scopes/:id/validation`을 모아 그린다(쪽 나눔 없음) |
| 명세·지급 | `Ops-Statements` | `/my/parties` → `/parties/:id/statements?page` | 조합별 매출 카드(쪽 나눔 있음). 작가 명세는 보이지 않음 |
| 발행 조합 | `Ops-Issues` | `/issues?page&pack` | 봉인 배지 `facts vN · 정책 vN` |
| 내 조직 | `Ops-Org` | 기존 `org/Home` 데이터 | KYB 표는 쪽 나눔 없음, 당사자 표는 있음 |
| 담당자 계정 | `Ops-Accounts` | `/users?page` | "담당자 초대 — 상용 단계" 버튼 비활성 |
| 위임 대행 | `Ops-Delegation` | 없음 | 빈 화면(표 머리 + 안내 문장) |
| 신탁·유통 연결 | `Ops-Links` | 없음 | 빈 화면 |

- [ ] 화면 하나씩 구현한다 → 개발 서버(코어 8080, Vite 5173, Dynamite 시드)에서 연다 → 시안 보드와 1440 폭으로 나란히 비교한다 → 차이를 고친다 → 커밋한다.
- [ ] 예시 데이터(푸른 계절)는 시드에 없으므로 화면에 나오지 않는다. 이것은 차이로 보지 않는다(데이터 차이). 비교 보고에 적는다.

### Task 6: 화면 — 기존 목록에 쪽 나눔 적용

**Files:** `src/pages/works/Catalog.tsx`, `src/pages/works/tabs/*.tsx`, 포털에서 쓰는 기존 목록 화면

- [ ] 작품 목록: `/works/overview?page`로 바꾸고, 표 아래에 쪽 나눔 줄을 둔다(시안 `Catalog`). 검색·상태 탭은 서버 필터로 옮긴다.
- [ ] 곡 탭의 목록 표(계약, 원천 문서, 멤버 확인, 작가 확인, 원곡 권리 표들)는 `paginate`로 10행씩 나눈다.
  - 항목 수가 정해진 표(IR 준비 항목, 출시 조건, 슬롯 × 멤버 스템 표)는 나누지 않는다.
- [ ] 포털에서 `Pager`("더 보기")·`useAll`·첫 쪽만 보는 `limit=200` 호출을 쪽 번호 방식으로 바꾼다. 운영 앱 화면은 그대로 둔다.

### Task 7: E2E와 시안 비교 보고

**Files:** Create `e2e/stack-portal-nav.spec.ts`

- [ ] 시나리오 1: 빅히트로 로그인 → 사이드 메뉴 작품 목록 → Dynamite 열기 → 사이드 메뉴의 작품 워크스페이스 아래 6개 항목과 탭 줄이 같은 곳으로 가는지 확인한다.
- [ ] 시나리오 2: 운영 관리 › 확인 요청 전체 → 행 링크로 Dynamite 확인·동의에 도착하는지 확인한다.
- [ ] 시나리오 3: 원천 문서에서 쪽 나눔 줄의 범위 문구와 다음 쪽 이동을 확인한다(문서가 10건 이하면 `1–N / N`과 다음 버튼 비활성).
- [ ] 시나리오 4: 위임 대행과 신탁·유통 연결 빈 화면 문구, 포털에 `/inspections` 경로가 없는지 확인한다.
- [ ] 화면 15개(사이드 메뉴가 붙은 작품 화면 3개 + 운영 관리 12개)를 1440 폭으로 찍고 시안과 나란히 비교한 이미지를 남긴다. 결과를 "시안 준수" 표(화면 · 일치 · 차이 · 이유)로 정리한다.
- [ ] 코어 `npm test`, 화면 `npm test`·`typecheck`, E2E 전부 통과한 출력을 보고에 붙인다.
