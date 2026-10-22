# 총괄 콘솔 UI 구조 시안

[총괄 운영과 권한 구조](../../../00_프로젝트_개요/총괄_운영과_권한_구조_20261022.md)(M5a)를 진행하기 전에 화면 구조를 확인하려고 만든 시안이다. 단계별 화면·API는 [MVP E2E 흐름과 화면 매핑](../../../00_프로젝트_개요/MVP_E2E_흐름과_화면_매핑_20261022.md)의 E00~E61을 따른다.

- 캔버스: https://claude.ai/artifact/Gg8EKnnnXcBan6nBcfpf6k (비공개 — 다른 사람에게 보이려면 페이지의 Share 메뉴에서 공유)
- 파일: `project/canvas.json`(배치), `project/*.dc.html`(화면 10장)
- 목업 전용 파일이다. MVP 앱 코드는 이 파일을 쓰지 않는다. 금액은 예시 보고서 값이고, 정책 예시 계산의 1건당 금액과 봉인 digest는 자리 표시(`[예시 값]`, `[digest]`)로 두었다

| 화면 | 파일 | 흐름 |
| --- | --- | --- |
| 구조 지도: 콘솔 셸·소속별 메뉴·E2E 흐름·주소 | `Main.dc.html` | 전체 |
| [플랫폼] ⑧ 파이프라인 홈 | `Console-Platform.dc.html` | E44, E60 |
| [플랫폼] 조직 상세: 확인 항목·상태·총괄 소속 추가 | `Console-Org.dc.html` | E01~E05, E32 |
| [데모] 진행 단계 P0~P10(화면으로 하기 / 도구로 채우기) | `Console-Demo.dc.html` | E00, E08, E41~E45 |
| [빅히트] 권리 요약·카탈로그 등록 | `Console-Rights.dc.html` | E10~E17 |
| [빅히트] 분배 규칙 편집·승인·활성화 | `Console-Policy.dc.html` | E35~E40 |
| [실연자: 정국] 본인 전환 — 확인·동의·서명 | `Artist-Consent.dc.html` | E19~E21, E28 |
| [플랫폼] 정산 배치 상세 — 재계산·확정 | `Console-Settlement.dc.html` | E48~E51 |
| [플랫폼] 지급과 명세 — 정산 확인 | `Console-Payout.dc.html` | E55~E60 |
| [플랫폼] ⑩ 역할·권한·직무 분리 규칙 | `Console-RBAC.dc.html` | RS7 |
