# dobedupop MVP UI 구조 목업

MVP 진행계획(`00_프로젝트_개요/MVP_진행계획_Dynamite데모_20261016.md`)의 M0a 산출물이다. 세 앱(권리자 포털·실연자 앱·운영 백오피스)과 데모 진행판의 화면 구조를 확인하려고 만들었다. 확인을 받은 뒤 M1(MVP 홈 만들기)로 간다.

- 공유 캔버스: https://claude.ai/artifact/AGhg9BZRRtdX7cygsDT1pU (비공개 — 다른 사람에게 보이려면 페이지의 Share 메뉴에서 공유)
- 파일: `project/canvas.json`(배치), `project/*.dc.html`(화면 11개)
- 화면의 수치는 `00_프로젝트_개요/예시_Dynamite/dynamite-report.json` 값이다. 실연자 앱 "내 기여분" 합계는 1건당 기여분 × 판매 건수로 계산했다.
- 목업 전용 파일이다. MVP 앱 코드는 이 파일을 쓰지 않는다.

| 화면 | 파일 |
| --- | --- |
| 구조 지도(서브도메인·배포 구조·시나리오 동선) | `Main.dc.html` |
| 권리자 포털: 홈 · 권리 요약+원천 문서 · 분배 규칙과 승인 | `Portal-Home` · `Portal-Rights` · `Portal-Policy` |
| 실연자 앱: 동의와 계약 서명 · 수익과 내 기여분 · 사용 이력과 이의제기 | `Artist-Consent` · `Artist-Money` · `Artist-Usage` |
| 운영 백오피스: ⑧ 관제 홈 · 한 건 추적 · 정산 배치 | `Ops-Pipeline` · `Ops-Trace` · `Ops-Settlement` |
| 데모 진행판 | `Demo-Console` |
