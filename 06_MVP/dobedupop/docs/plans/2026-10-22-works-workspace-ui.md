# 2부-B 빅히트 작품 목록·곡 워크스페이스 화면 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 권리 테넌트(빅히트) 포털에 확정 시안(ED3)대로 **작품 목록(시작점) → 곡 워크스페이스 탭**(원곡 권리 · 스템 · 확인·동의 · 문서·계약 · 분배 규칙·팩 · 승인·출시)과 새 곡 마법사를 만든다. P2(권리 등록·스템), P3(확인·동의), P4(계약), P6(분배 규칙·팩·승인·출시)을 화면만으로 할 수 있게 한다.

**Architecture:** 코어에 화면용 조회 두 개(작품 개요, IR 생성 준비)를 더한다. 화면은 기존 백오피스 코드베이스(React 19, react-query, react-router 7)에 `src/pages/works/`를 새로 두고, 계산·묶기는 순수 함수 모듈(`model.ts`)로 떼어 vitest로 시험한다. 쓰기는 2부-A의 API(슬롯·파트·카탈로그 수정·주장 함께 만들기)와 기존 API(계약·확인·팩·정책)를 그대로 쓴다. 화면 검증은 데모 스택 Playwright E2E 하나로 한다.

**Tech Stack:** rights-core(Fastify, PostgreSQL), backoffice(React 19, @tanstack/react-query 5, react-router 7, vitest, Playwright)

**시안(원본):** `06_MVP/mockup/console/project/` — `Catalog`, `Song-Rights`, `Song-Stems`, `Song-Confirm`, `Song-Contracts`, `Song-Policy`, `Song-Release`, `Song-Create`, `Song-Locked` (`.dc.html`). 화면 문구·배치·숫자 표시는 시안을 따른다.
**결정:** ED1~ED4, ID1~ID3, SL1~SL8 (`00_프로젝트_개요/MVP_E2E_흐름과_화면_매핑_20261022.md`, `E10_E11_IR_연계와_CRUD_20261022.md`, `보컬_슬롯과_라인_구조_20261022.md`)

**선행:** 2부-A [2026-10-22-slot-part-core.md](2026-10-22-slot-part-core.md)가 master에 합쳐져 있어야 한다(슬롯·파트 API, `PUT`/`DELETE` 카탈로그, `withClaims`·`masterClaim`).

**이 계획 밖(2부-C):** 총괄 콘솔(소속 전환·`VITE_APP=console`·게이트웨이), Dynamite 시드를 슬롯 12·파트로(SL-S4), 데모 진행판의 단계 재구성, 역할·권한 관리 화면, 총괄 1인 E2E 전체.

## Global Constraints

- 코어 작업 폴더 `06_MVP/dobedupop/services/rights-core`, 화면 `06_MVP/dobedupop/apps/backoffice`
- 시험: 코어 `npm test`, 화면 `npm test`(vitest)·`npm run typecheck`, 화면 E2E `npm run e2e -- <spec>`(데모 스택이 떠 있어야 한다 — 기존 `e2e/stack-*.spec.ts` 실행 방법을 따른다)
- 새 화면은 **포털 앱(`kind === "portal"`)**에 넣는다. 운영 앱의 기존 권리 조회 메뉴는 그대로 둔다
- 메뉴: 포털의 "① 권리 등록 / ② 정책·상품 / ③ 발행·심사" 묶음을 "작품" 하나로 바꾼다(`routes.tsx` `menuFor("portal")`). 기존 경로(`/registry/*`, `/policy`, `/packs`, `/contracts` 등)는 지우지 않고 "모아 보기" 묶음으로 옮긴다
- 메뉴·버튼 노출은 1부의 권한으로: 세션 `/me`의 `permissions`를 읽는다. 이 계획에서 `MenuItem`에 `perm?: string`을 더하고 `roles` 대신 쓴다(포털 메뉴만. 운영·참여 기관 메뉴는 2부-C)
- 금액·비율 표시는 기존 `src/format.ts`를 쓴다. 시각은 `<Instant>`
- 화면 문구는 한국어, 기존 화면 말투. 접근성: 실제 `<button>`·`<a>`·`<label>`, 아이콘만 있는 버튼에는 `aria-label`
- IR 상태: 범위의 `sealedThrough`가 없으면 "IR 생성 전 — 등록·조회·수정 가능", 있으면 "IR 생성됨 vN — 조회만"(그때 수정·삭제 버튼은 숨기고 "새 버전으로 바로잡기"만)
- 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## 파일 구조

| 파일 | 할 일 |
| --- | --- |
| `services/rights-core/src/registry/overview.ts`(새) | `worksOverview(tx)` — 테넌트가 볼 수 있는 곡마다 요약·진행 단계 |
| `services/rights-core/src/registry/readiness.ts`(새) | `scopeReadiness(tx, scopeId, now)` — IR 생성 준비 항목 |
| `services/rights-core/src/registry/routes.ts` | `GET /works/overview`, `GET /scopes/:id/readiness` |
| `apps/backoffice/src/api/works.ts`(새) | 위 두 조회와 2부-A 쓰기 API의 타입·호출 함수 |
| `apps/backoffice/src/pages/works/model.ts`(새) | 순수 함수: 진행 단계 이름, 권리 세 갈래 묶기, 슬롯·파트 × 멤버 표, 멤버 확인 진행, 미리보기 줄 |
| `apps/backoffice/src/pages/works/model.test.ts`(새) | 위 함수 시험 |
| `apps/backoffice/src/pages/works/Catalog.tsx`(새) | 작품 목록 + 하단 조회 요약(탭별 "관리 →") |
| `apps/backoffice/src/pages/works/Workspace.tsx`(새) | 워크스페이스 틀: 작품 목록 복귀, IR 준비 띠, 제목·IR 상태, 탭 |
| `apps/backoffice/src/pages/works/tabs/{Rights,Stems,Confirm,Contracts,Policy,Release}.tsx`(새) | 탭 6개 |
| `apps/backoffice/src/pages/works/NewWork.tsx`(새) | 새 곡 4단계 |
| `apps/backoffice/src/app/routes.tsx` | 포털 경로·메뉴 |
| `apps/backoffice/e2e/stack-works.spec.ts`(새) | 빅히트로 새 곡 → 권리 → 스템 → 계약 → 분배 규칙 → 승인·출시 |

---

### Task 1: 코어 — 작품 개요와 IR 생성 준비 조회

**Files:** Create `src/registry/overview.ts`, `src/registry/readiness.ts`, `test/registry/overview.test.ts`; Modify `src/registry/routes.ts`

**Interfaces:**
- Produces:
  - `GET /portal/works/overview` → `WorkOverview[]`:
    ```ts
    type WorkOverview = {
      workId: string; title: string; scopeId: string | null; recordingTitle: string | null;
      authors: string[];                 // WRITTEN_BY 대상 당사자 표시명
      rights: { work: number; master: number; performers: number };  // 현재 버전 주장 수(갈래별)
      slots: number; vocalParts: number; stems: number;              // 등록된 수
      pendingConfirmations: number;
      sealed: boolean; sealedThrough: string | null;
      pack: { packId: string; status: string } | null;
      activePolicy: boolean;
      stage: 0 | 1 | 2 | 3 | 4;          // 0 권리 입력 · 1 확인 · 2 IR 생성 · 3 팩 활성(출시 대기) · 4 판매
      status: "입력 중" | "확인 대기" | "IR 생성됨" | "판매 중" | "분쟁·보류";
    };
    ```
    단계 규칙: 팩 ACTIVE → 4(판매 중) · 활성 정책 있음 → 3 · 봉인됨 → 2(IR 생성됨) · 확인 대기 > 0 → 1(확인 대기) · 그 밖 0(입력 중). 열린 분쟁이 있거나 팩 PAUSED면 상태는 "분쟁·보류"(단계는 그대로)
  - `GET /portal/scopes/:id/readiness` → `{ items: { key: string; ok: boolean | "warn"; label: string; detail: string }[] }`. 항목: `shares`(갈래별 합계 100%), `evidence`(확정 주장의 근거 문서), `originalStems`(보컬·그룹 파트마다 원곡 스템), `confirmations`(대기 수), `consents`(보이스별 유효 이용 동의), `mandates`(멤버 수령 위임 반영 수), `audio`(오디오가 있는 스템 중 READY 아닌 수), `blocks`(정합성 차단 수 — `checkScope` 결과 BLOCK)

- [ ] **Step 1: 실패하는 시험** — `test/registry/overview.test.ts`: 기존 레지스트리 픽스처로 곡 1개(범위·녹음·슬롯 1·보컬 파트 1·스템 1·작가 주장 ASSERTED)를 만들고 포털 사용자로 `GET /portal/works/overview`를 부른다. `stage === 1`, `status === "확인 대기"`, `pendingConfirmations === 1`, `authors`에 작가 표시명. `GET /portal/scopes/:id/readiness`의 `confirmations` 항목이 `ok: "warn"`. 다른 테넌트 사용자에게는 그 곡이 목록에 없다

- [ ] **Step 2~4: 구현·통과** — 두 함수는 RLS가 있는 트랜잭션에서 그대로 질의한다(테넌트 범위). `worksOverview`는 곡 하나당 질의를 반복하지 말고 범위별 집계를 한 질의로 모은다(`LEFT JOIN LATERAL (SELECT count(*) …)`). `scopeReadiness`의 `blocks`는 `checkScope(tx, scopeId, now)`(validation/service.ts)를 그대로 부른다. 권한은 `requirePermission(actor, "rights.edit")`가 아니라 조회라서 포털 채널이면 된다(기존 `GET /scopes/:id/summary`와 같은 방식)

- [ ] **Step 5: Commit** — `feat(core): 작품 개요(진행 단계)와 IR 생성 준비 조회 — 포털 작품 목록·워크스페이스용`

---

### Task 2: 화면 모델(순수 함수)과 API 모듈

**Files:** Create `src/api/works.ts`, `src/pages/works/model.ts`, `src/pages/works/model.test.ts`

**Interfaces:**
- `src/api/works.ts`: Task 1 타입 `WorkOverview`, `Readiness`; 2부-A 쓰기 함수 `putSlot`, `putSlotPart`, `putStem`, `deleteCatalog(kind, id)`, `postStem(body & { withClaims: true })`, `postRecording(body & { masterClaim })`, 기존 `post`(registry.ts)
- `src/pages/works/model.ts`:
  ```ts
  export const STAGES = ["권리 입력", "확인", "IR 생성", "팩 활성", "판매"] as const;
  export function stageBars(stage: number): ("done" | "now" | "todo")[];
  export type Bucket = { key: "work" | "master" | "performer"; title: string; edge: string; rows: { partyId: string; name: string; shareBps: number; status: string; evidence: string | null }[]; totalBps: number };
  export function rightsBuckets(claims: ClaimRow[], parties: Map<string, string>): Bucket[];   // WRITTEN_BY → work, CONTROLLED_BY → master, OWNED_BY(보이스→당사자) → performer(멤버별 보이스)
  export type PartRow = { slotId: string; slotNo: number; section: string; partNo: number; kind: "VOCAL" | "GROUP" | "INSTRUMENT"; original: string | null; startMs: number; endMs: number };
  export function slotPartRows(slots: SlotWithParts[]): PartRow[];                                // 슬롯 순서 → 파트 번호 순
  export type Cell = { state: "original" | "registered" | "empty"; stemId?: string };
  export function stemMatrix(rows: PartRow[], stems: StemRow[], singers: string[]): Cell[][];    // VOCAL 파트 행만, 열 = 멤버
  export function memberProgress(members: string[], confirmations: ConfRow[], consents: ConsentRow[], mandates: MandateRow[]): { member: string; voice: string; origParts: [number, number]; extraStems: [number, number]; consent: boolean; mandate: boolean; left: number }[];
  export function previewLines(form: PolicyFormValues, price: number, sungSeconds: Record<string, number>): { label: string; won: number; level: 0 | 1 }[];  // 시안 Song-Policy 오른쪽 목록과 같은 계산(표시용 근사, 실제는 /policies/preview)
  ```

- [ ] **Step 1: 시험** — `model.test.ts`에 함수마다 시험 하나 이상. 숫자 예는 시안을 그대로 쓴다:
  - `stageBars(1)` → `["done","now","todo","todo","todo"]`
  - `rightsBuckets`: 작가 2(각 5000), 레이블 1(10000), 보이스 소유 7 → 갈래 3개, `totalBps` 10000·10000·(멤버 수 무관하게 표시용 0)
  - `stemMatrix`: 시안 Chorus 1(파트 1 정국·파트 2 지민) + 스템 `원곡 정국`, `원곡 지민`, `진이 파트 2` → 행 2 × 열 7에서 (0,정국)=original, (1,지민)=original, (1,진)=registered, 나머지 empty
  - `previewLines`(권리자 70 · 녹음 40 · 실연 45 · 작품 15, 실연 고정 40 + 부른 시간 60, 3,300원, 시안의 부른 시간) → 플랫폼 825, 운영 165, 권리자 2,310, 녹음 924, 작품 작가 각 173.25, 실연 1,039.5, 정국 기여 ≈ 291.4(소수 1자리 비교)

- [ ] **Step 2~4: 구현·통과** — Run: `npm test -- src/pages/works/model.test.ts`

- [ ] **Step 5: Commit** — `feat(backoffice): 작품·워크스페이스 화면 모델과 API 모듈`

---

### Task 3: 작품 목록(시작점)과 하단 조회 요약

**Files:** Create `src/pages/works/Catalog.tsx`; Modify `src/app/routes.tsx`(포털 `/` → 작품 목록은 하지 않는다 — 포털 홈은 "내 조직" 그대로, `/works` 추가, 메뉴 "작품" 첫 항목)

시안 `Catalog.dc.html` 그대로:
- 머리: "작품 관리", 버튼 "CSV 일괄 등록 · 상용"(disabled, title 결정 ED1), "엑셀 다운로드"(CSV 내보내기 — 지금 목록을 `text/csv`로 내려받기), "+ 새 곡 워크스페이스"(`/works/new`)
- 현황 숫자 6개(전체·입력 중·확인 대기·IR 생성됨·판매 중·분쟁·보류) — `worksOverview`에서 계산
- 상태 탭(필터), 검색(곡명·작가·ISRC — 화면에서 거름), 정렬
- 표: 관리번호(=workId), 곡명/녹음, 작사·작곡, 원곡 권리(갈래 수), 멤버 스템, 확인 대기, 진행 5단계 막대(`stageBars`), 상태 배지, 열기 → `/works/:workId/rights`
- 행을 누르면 하단 패널: 탭 개요·원곡 권리·스템·문서·계약·확인·동의·분배 규칙·팩·정산·변경 이력. **조회 전용 요약**과 탭마다 "○○ 관리 →"(`/works/:workId/<탭>`). 개요 탭은 기본정보·진행·IR 생성 준비(`/scopes/:id/readiness`)

- [ ] **Step 1:** 컴포넌트 작성(위 구성. 요약 카드 문구는 시안 Catalog의 `D` 객체 문구를 실제 값으로 채운다)
- [ ] **Step 2:** Run: `npm run typecheck && npm test` / Expected: 오류 0
- [ ] **Step 3: Commit** — `feat(backoffice): 포털 작품 목록 — 현황·상태 탭·진행 단계·하단 조회 요약과 탭별 관리 이동`

---

### Task 4: 워크스페이스 틀과 원곡 권리 탭(P2)

**Files:** Create `src/pages/works/Workspace.tsx`, `src/pages/works/tabs/Rights.tsx`; Modify `routes.tsx`(`/works/:workId/:tab`)

- 틀: "← 작품 목록"(목록의 선택·탭 유지 — URL 쿼리 `?sel=<workId>&tab=<탭>`로 돌아감), IR 생성 준비 띠(`readiness` 항목을 ✓·!·· 로), 제목·녹음·IR 상태 배지, 탭 6개(+ "변경 기록"은 감사 로그 목록, 이 계획에서는 비활성 표시)
- 원곡 권리 탭(시안 `Song-Rights`):
  - 갈래 3표(`rightsBuckets`) — 작품(작가 추가·행 안 수정), 녹음(공동 보유자), 실연(**슬롯·파트별 담당** 표: `slotPartRows` — 구간·시각·파트·원곡 담당·역할·확인 상태, 행 동작 수정·파트 추가·삭제)
  - 수령 위임 칸(위임 기록 + 계약 링크)
  - 저장 규칙 안내, 최근 변경(감사 로그 5건 — 기존 `GET /audit?entity=` 조회가 있으면 쓰고, 없으면 이 칸은 다음 계획으로 두고 숨긴다)
  - 쓰기: 지분 수정 = 주장 새 버전(`POST /claims` 같은 `claimId` + `expectedVersion`, 기존 레지스트리 동작), 작가 추가 = `POST /claims`(ASSERTED), 파트 수정·추가·삭제 = 2부-A `PUT/POST/DELETE /slot-parts`, 슬롯 추가 = `POST /slots`(parts 포함)
  - 갈래 합계가 10000bps가 아니면 저장 버튼을 막고 "합계 100%여야 저장" 표시(시안 Work-Edit의 오류 표시)
  - IR 생성 뒤: 모든 수정·삭제 숨김, "새 버전으로 바로잡기"(시안 `Song-Locked`) — 지분은 주장 새 버전, 슬롯·파트는 409 `CATALOG_SEALED` 안내

- [ ] **Step 1~2:** 작성 → typecheck/test
- [ ] **Step 3: Commit** — `feat(backoffice): 곡 워크스페이스 틀(IR 준비·상태·탭)과 원곡 권리 탭 — 세 갈래·슬롯·파트별 담당·수령 위임`

---

### Task 5: 스템 탭(P2)

**Files:** Create `src/pages/works/tabs/Stems.tsx`

시안 `Song-Stems`:
- 슬롯 흐름 띠(길이 비례, 연주만 슬롯 점선), 구분 탭(전체·원곡 스템·멤버 추가 녹음·여러 명 슬롯만)
- 표: 행 = 보컬 파트(`slotPartRows` 중 VOCAL), 열 = 멤버 7, 칸 = `stemMatrix`. 그룹·반주 파트 행은 한 칸("그룹 원곡"·"원곡")
- 칸을 누르면 오른쪽 상세: 기본(슬롯·파트·부른 멤버·권리 부담), 이 스템의 권리(실연 주장·녹음·작품 — 원곡 권리를 따른다), 조합에서(설명), 오디오(상태·올리기는 기존 스템 오디오 화면 링크)
- 빈 칸을 누르면 같은 자리에 "스템 추가" 폼(슬롯·파트·부른 멤버가 채워짐, 권리 부담, 스템 id 자동 `stm_<slot>_p<part>_<member>`) → `POST /stems` `withClaims: true`
- 수정·삭제: 2부-A `PUT/DELETE /stems/:id`(IR 생성 전만)

- [ ] **Step 1~2:** 작성 → typecheck/test
- [ ] **Step 3: Commit** — `feat(backoffice): 스템 탭 — 슬롯 흐름, 보컬 파트 × 멤버 표, 스템 상세·추가(권리 주장 함께)·수정·삭제`

---

### Task 6: 확인·동의(P3)와 문서·계약(P4) 탭

**Files:** Create `src/pages/works/tabs/Confirm.tsx`, `src/pages/works/tabs/Contracts.tsx`

- 확인·동의(시안 `Song-Confirm`): `memberProgress` 표(본인 인증은 실연자 계정 상태를 알 수 있으면 표시, 없으면 칸을 뺀다), "다시 알림"(확인 요청 재알림 API가 없으면 버튼 숨김 — 지금 있는 API로만), 작가 지분 대조 상태(확인 요청 중 상대가 플랫폼 위탁인 것), "확인이 IR 생성·출시에 주는 영향" 안내
- 문서·계약(시안 `Song-Contracts`): 이 곡 범위의 표준 계약 목록(`GET /contracts?scope=`가 없으면 전체 목록을 받아 `factsScopeId`로 거른다), 상태(작성·서명 대기·반영), 서명 당사자별 상태, "소속사 서명"(`POST /contracts/:id/sign`), "반영"(`POST /contracts/:id/complete`), 원천 문서 2(`GET /documents?scope=`)
  - "계약 만들기" 패널: 템플릿 선택 → 변수(당사자는 명부 선택) → 미리보기(`POST /contracts/preview`) → 작성(`POST /contracts`). **수령 위임은 멤버 여러 명을 고르면 한 사람씩 계약을 만든다**(반복 호출)
  - 기존 `src/pages/contracts/Contracts.tsx`의 마법사 부분을 컴포넌트로 떼어 두 화면이 같이 쓴다(복사하지 않는다)

- [ ] **Step 1~2:** 작성 → typecheck/test
- [ ] **Step 3: Commit** — `feat(backoffice): 확인·동의 탭(멤버 진행·작가 대조)과 문서·계약 탭(곡별 계약·서명·반영, 수령 위임 여러 건)`

---

### Task 7: 분배 규칙·팩(P6)과 승인·출시 탭

**Files:** Create `src/pages/works/tabs/Policy.tsx`, `src/pages/works/tabs/Release.tsx`

- 분배 규칙·팩(시안 `Song-Policy`):
  - 단계 표시 ①~⑥
  - ① 정합성 점검 요약(`readiness.blocks`, 경고 수) + "점검 결과 전체"(기존 `/validation`)
  - ② 팩: 없으면 만들기(`POST /packs` — 코드·이름, 범위는 이 곡), 청구권자는 원곡 권리에서 자동 제안(레이블 MASTER_OWNER, 소속사 AGENCY — 수령 위임이 있으면, 멤버 PERFORMER_FEATURED, 작가 WORK_AUTHOR) → `PUT /packs/:id/claimants`
  - ③ 규칙 폼: 기존 `PolicyFormEditor`를 그대로 넣는다(1단계·2단계·실연 혼합·위임). "표준 템플릿으로"(`POST /policies/:id/from-template`)
  - 오른쪽 미리보기: 예시 조합 선택(원곡 배치 + 파트 하나를 다른 멤버로 바꾼 배치) → `POST /policies/preview` 결과를 표로. 서버 미리보기가 실패하면 `previewLines`(근사)로 보여 주고 "근사값" 표시
  - 경고 상자 "컴파일하면 IR이 생성된다…"와 확인 대화상자(실제 `<dialog>` 또는 확인 단계 버튼) → `POST /policies/:id/compile`
- 승인·출시(시안 `Song-Release`):
  - 흐름 4칸(컴파일·승인·활성화·출시)과 각 서명자(정책 버전의 attestation 목록 — `GET /policies/:id`가 서명을 주면 사용)
  - 직무 분리 꺼짐 표시(`sod_rule` 조회가 없으면 고정 문구)
  - 버튼: 승인(`…/approve`), 반려(새 버전 초안으로 — 지금 API가 없으면 숨김), 활성화(`…/activate`), 출시 = 팩 활성화(`POST /packs/:id/activate`)
  - 출시 조건 목록 — `readiness` + 테넌트 상태(`/me`의 `tenantStatus === "ACTIVE"`) + 정책 상태. 조건이 안 되면 버튼 disabled와 이유
  - "출시하면", "출시 뒤 관리"(일시정지 `POST /packs/:id/pause`가 있으면 버튼)

- [ ] **Step 1~2:** 작성 → typecheck/test
- [ ] **Step 3: Commit** — `feat(backoffice): 분배 규칙·팩 탭(팩·청구권자 자동·규칙 폼·미리보기·컴파일)과 승인·출시 탭(승인·활성화·팩 활성화, 출시 조건)`

---

### Task 8: 새 곡 워크스페이스 마법사

**Files:** Create `src/pages/works/NewWork.tsx`; route `/works/new`

시안 `Song-Create`: 1 곡·녹음(곡 → 범위 자동 → 녹음 + `masterClaim`, 근거 문서 올리기는 기존 원천 문서 업로드 재사용) → 2 원곡 권리(작가 행·균등 분배·합계 검사, 녹음 지분) → 3 멤버(실연자 명부에서 고르기 → 보이스·소유 주장) → 4 확인(요약·확인 요청 보내기). 단계마다 저장, "나중에 이어서"는 작품 목록으로. 끝나면 `/works/:workId/stems`. id는 제목에서 자동(`wrk_<slug>`, `fsc_<slug>`, `rcd_<slug>`), 충돌하면 숫자 꼬리

- [ ] **Step 1~2:** 작성 → typecheck/test
- [ ] **Step 3: Commit** — `feat(backoffice): 새 곡 워크스페이스 마법사 — 곡·녹음 → 원곡 권리 → 멤버 → 확인`

---

### Task 9: 빅히트 화면 E2E와 문서

**Files:** Create `e2e/stack-works.spec.ts`; Modify `docs/데모_가이드.md`, `docs/요건추적표.md`, `00_프로젝트_개요/MVP_E2E_흐름과_화면_매핑_20261022.md`(G10·E09~E40 화면 상태 갱신)

- E2E(데모 스택, 빅히트 관리자 페르소나 — 기존 `e2e/fixtures.ts`의 로그인 도우미): 새 곡 "E2E Song"을 마법사로 만들고(작가 2·레이블·멤버 2) → 스템 탭에서 슬롯 1·보컬 파트 2·스템 2를 추가 → 계약 탭에서 수령 위임 계약 만들기 → 분배 규칙·팩 탭에서 팩 만들기·표준 템플릿·미리보기 표시 확인 → 컴파일 → 원곡 권리 탭이 조회만인지(수정 버튼 없음) → 승인·출시 탭에서 승인. **활성화·출시는 확인 요청이 남아 있어 막히는지**(버튼 disabled와 이유 문구)까지 본다. 실패 API 호출 0(기존 `stack-screens.spec.ts`의 콘솔·네트워크 감시 방식)
- [ ] Run: `npm run e2e -- e2e/stack-works.spec.ts` / Expected: 통과
- [ ] 문서 갱신 후 Commit — `test(e2e): 빅히트 작품·워크스페이스 화면 흐름, 문서 갱신`
