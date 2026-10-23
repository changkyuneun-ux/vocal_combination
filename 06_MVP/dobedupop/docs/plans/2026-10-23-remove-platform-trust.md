# 3부-C 플랫폼 위탁 폐지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "플랫폼은 권리자·권리를 만들거나 확정하지 않는다"는 원칙대로 고친다(결정 WD1~WD4, `00_프로젝트_개요/플랫폼_위탁_폐지와_권리_관리_주체_20261023.md`).
- 플랫폼 위탁 당사자 개념과 플랫폼 원문 대조 확정을 없앤다.
- Dynamite 작가 2명을 빅히트 관리 당사자로 바꾼다.
- 계정 없는 작가는 빅히트가 보낸 전자서명 링크로 확인하게 한다.
- 작가 명세·지급 정보를 빅히트가 관리하게 한다.

**Architecture:** 데이터 모델은 대부분 그대로 쓴다.
- 당사자의 관리 테넌트를 빅히트로 등록한다.
- 위탁 분기와 플랫폼 확정 경로를 지운다.
- 작가 확인은 기존 전자서명 공급자 인터페이스(`DEV_ESIGN`, 플랫폼 밖 당사자는 공급자 통지로 들어옴)를 그대로 쓴다.
- 정산 금액은 바뀌면 안 된다(시험으로 고정).

**Tech Stack:** rights-core(Fastify, PostgreSQL, node:test), backoffice(React 19, vitest, Playwright)

**시안(엄격 준수, 2026-10-23 정정판):** `06_MVP/mockup/console/project/`
- 작품 워크스페이스: `Song-Rights`, `Song-Confirm`, `Song-Contracts`, `Song-Policy`, `Song-Release`, `Song-Create`, `Song-Import`, `Song-ClaimConfirm`
- 운영 관리: `Nav-Ops-Confirm`, `Ops-Contracts`, `Ops-Templates`, `Ops-Validation`, `Ops-Statements`(작가 2행)
- 플랫폼 콘솔: `Console-Payout`
- `Console-Verify`는 삭제됨

**이 계획 밖:** 계약서 불러오기 보강 시안 4장(`Song-Import-Start`, `Song-Import-Values`, `Song-ClaimConfirm-Apply`, `Ops-FrameNew`)의 구현. 사용자 확인 뒤 따로 한다. 지금 브랜치의 임시 구현(문서 고르기, 다름 링크, 기록 반영 버튼)은 그대로 둔다.

## Global Constraints

- 브랜치 `feat/works-ui`. 먼저 master를 합친다(결정 문서·시안 정정이 master에 있다)
- 지급 금액은 그대로여야 한다: 소속사 2,285,920 · 레이블 2,030,952 · 작가 각 296,604 · 원천징수 83,650. Dynamite 시나리오 시험으로 확인한다
- 플랫폼 소속 계정이 권리 주장·동의·위임을 `VERIFIED`로 만들거나, 다른 테넌트 당사자를 대신 확정하는 경로가 남지 않게 한다. 시험으로 막는다
- 테넌트 KYB 확인, 정산 계산·지급 실행, 관제는 그대로 둔다
- 마이그레이션은 브랜치 마지막 번호 다음으로 한다(기존 데이터: 작가 당사자 관리 테넌트 옮기기, 권한 정리)
- 화면은 시안 엄격 준수(디자인 가이드, CLAUDE.md). 1440 폭 나란히 비교
- push·PR·master merge 금지. 커밋 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Tasks

### Task 0: master 합치기
- [ ] `git merge master`를 하고 시험이 그대로 통과하는지 확인한다.

### Task 1: 위탁 개념 찾기와 지우기 목록
- [ ] 코어·시드·화면에서 위탁 개념을 모두 찾는다.
  - 검색어: "위탁", `tnt_platform` 당사자 관리 분기, `platformVerify`, `/contracts/:id/platform-verify`, 위탁 당사자 곡 "경고만" 규칙, 명세 관리 주체의 플랫폼 분기
  - 찾은 것을 지울 것·바꿀 것·남길 것(KYB·정산·관제)으로 나눈 표로 만든다.
  - 표는 커밋 메시지나 보고에 남긴다.

### Task 2: 코어 — 플랫폼 원문 대조 확정 폐지(WD3)
- [ ] 먼저 시험을 바꾼다.
  - 플랫폼 소속 계정의 원문 대조 확정은 거부한다(경로 없음 404 또는 권한 없음 403).
  - 기한이 지나면 경고가 차단으로 오르는 동작은 그대로다.
  - 권리 확인서는 서명자 전원이 전자서명해야 "기록 반영"이 된다.
- [ ] `platformVerify`와 확인 요청의 플랫폼 확정 경로, `/contracts/:id/platform-verify`, 권한 `contract.frame_approve`에서 대조 관련 부분을 지운다.
  - 읽기 틀 승인 권한은 남긴다(CT2: 읽기 틀은 플랫폼이 승인한다. 이것은 권리 확정이 아니다).
- [ ] 커밋한다.

### Task 3: 코어 — 작가는 빅히트 관리 당사자(WD1)와 전자서명 확인(WD2)
- [ ] 시험부터 쓴다.
  - Dynamite 작가 당사자의 관리 테넌트가 `tnt_bighit`인지
  - 빅히트가 작품 이용허락 표준 계약과 작가용 권리 확인서를 작가에게 보내는지. 작가는 공급자 통지로 서명한다.
  - 서명하면 `WRITTEN_BY` 주장과 작품 이용 동의(작가마다 1건)가 `VERIFIED`가 되고 기록 주체가 빅히트인지
  - 정합성 경고가 닫히는지
- [ ] Dynamite 시나리오·시드를 바꾼다.
  - 작가 등록 테넌트
  - 작품 이용허락은 빅히트가 작성하고 작가가 공급자 서명
  - 작가 지급 정보는 빅히트가 등록
- [ ] 기존 데이터용 마이그레이션을 만든다.
- [ ] 개발 리셋 시드도 같이 바꾼다.
- [ ] 커밋한다.

### Task 4: 코어 — 작가 명세는 빅히트(WD4)
- [ ] 시험부터 쓴다.
  - 빅히트 계정으로 `/my/parties`와 작가 명세를 볼 수 있는지
  - 다른 테넌트는 작가 명세를 볼 수 없는지(RLS)
  - 지급 금액이 바뀌지 않았는지
- [ ] 구현하고 커밋한다.

### Task 5: 화면 — 정정 시안대로
- [ ] 위 시안 목록의 문구와 흐름을 맞춘다.
  - 작가 확인: "전자서명 링크", "서명 대기 · 기한"
  - 계약: "빅히트가 보냄 · 다시 보내기"
  - 명세·지급: 작가 2행. 받는 당사자 4, 이번 지급 4,909,080원
  - 계약 템플릿: "작가(계정 없으면 전자서명 링크)", 권리 확인서 작가용 "작가 전원(전자서명 링크)"
  - 확인 요청 전체: 상대 필터 "작가(전자서명 링크)"
- [ ] 운영 원문 대조와 관련된 화면 요소와 경로를 지운다.
- [ ] 1440 폭 나란히 비교로 차이를 0으로 만든다.
- [ ] 커밋한다.

### Task 6: E2E와 보고
- [ ] `contract-import` E2E를 바꾼다: 운영 원문 대조 대신 작가 2명이 공급자 통지로 서명 → 기록 반영 → 경고 0.
- [ ] 명세·지급 E2E: 빅히트가 작가 2행을 보는지 확인한다.
- [ ] 코어 시험, 화면 vitest·typecheck, 개발 서버 E2E가 모두 통과한 출력을 보고한다.
- [ ] Task 1 표, "시안 준수" 표, 지급 금액이 그대로라는 증거를 보고한다.
