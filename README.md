# dobedupop (두비더팝) & MDRL (Music Derivative Rights Language)

본 저장소는 **사용자/팬 참여형 보컬 조합 및 음악 2차이용 플랫폼 `dobedupop`**과, 2차 창작물의 다자간 권리관리/이용허락/정산을 관장하는 **도메인 특화 권리언어 `MDRL`**의 공식 설계 문서 및 구현 코드베이스입니다.

---

## 📌 빠른 탐색 및 단일 진실 공급원 (SSOT)

| 영역 | 바로가기 | 핵심 문서 / 대상 |
| :--- | :--- | :--- |
| **00. 프로젝트 개요** | [`00_프로젝트_개요/`](file:///Users/changkyuneun/Vocal%20Combination/00_%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8_%EA%B0%9C%EC%9A%94/README.md) | [통합 마스터 가이드](file:///Users/changkyuneun/Vocal%20Combination/00_%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8_%EA%B0%9C%EC%9A%94/README.md) 및 [표준 용어 사전/아키텍처 맵](file:///Users/changkyuneun/Vocal%20Combination/00_%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8_%EA%B0%9C%EC%9A%94/%ED%94%84%EB%A1%9C%EC%A0%9D%ED%8A%B8_%EC%9A%A9%EC%96%B4_%EB%B0%8F_%EC%95%84%ED%82%A4%ED%85%8D%EC%B2%98_%EB%A7%B5.md) |
| **01. 기획 & 비즈니스** | [`01_기획_비즈니스/`](file:///Users/changkyuneun/Vocal%20Combination/01_%EA%B8%B0%ED%9A%8D_%EB%Bi%EC%A6%88%EB%8B%88%EC%8A%A4/) | 최신 사업기획서 v1.15, IR Deck, 보컬조합 특허 문서 |
| **02. MDRL 언어 규격** | [`02_MDRL_언어규격/`](file:///Users/changkyuneun/Vocal%20Combination/02_MDRL_%EC%96%B8%EC%96%B4%EA%B7%9C%EA%B2%A9/) | [MDRL 공식 레퍼런스 북 v1.0](file:///Users/changkyuneun/Vocal%20Combination/02_MDRL_%EC%96%B8%EC%96%B4%EA%B7%9C%EA%B2%A9/MDRL_%EC%96%B8%EC%96%B4%EB%A0%88%ED%8D%BC%EB%9F%B0%EC%8A%A4%EB%B6%81_v1.0.md), 안분정책, 정산DSL, 정책게이팅 |
| **03. dobedupop 플랫폼 설계** | [`03_dobedupop_플랫폼설계/`](file:///Users/changkyuneun/Vocal%20Combination/03_dobedupop_%ED%94%8C%EB%9E%AB%ED%8F%BC%EC%84%A4%EA%B3%84/) | [데이터모델 v2.8](file:///Users/changkyuneun/Vocal%20Combination/03_dobedupop_%ED%94%8C%EB%9E%AB%ED%8F%BC%EC%84%A4%EA%B3%84/%EC%B5%9C%EC%8B%A0%EC%84%A4%EA%B3%84/%EB%8D%B0%EC%9D%B4%ED%84%B0%EB%AA%A8%EB%8D%B8_v2.8.md), [백오피스 UI 가이드 v1.6](file:///Users/changkyuneun/Vocal%20Combination/03_dobedupop_%ED%94%8C%EB%9E%AB%ED%8F%BC%EC%84%A4%EA%B3%84/%EC%B5%9C%EC%8B%A0%EC%84%A4%EA%B3%84/%EB%B0%B1%EC%98%A4%ED%94%BC%EC%8A%A4_UI%EC%84%A4%EA%B3%84%EA%B0%80%EC%9D%B4%EB%93%9C_%EC%9E%91%ED%92%88%EC%8A%AC%EB%A1%AF%EC%8A%A4%ED%85%9C_%ED%8Pack%EA%B4%80%EB%A6%AC_v1.6.md), 백오피스 구성방안 v1.8 |
| **04. 구현 & 소스코드** | [`04_구현_소스코드/`](file:///Users/changkyuneun/Vocal%20Combination/04_%EA%B5%AC%ED%98%84_%EC%86%8C%EC%8A%A4%EC%BD%94%EB%93%9C/) | [최신 백오피스 프로토타입 v2.7](file:///Users/changkyuneun/Vocal%20Combination/04_%EA%B5%AC%ED%98%84_%EC%86%8C%EC%8A%A4%EC%BD%94%EB%93%9C/prototypes/dobedupop-backoffice-prototype_v2.7.html), `backoffice` (React/Vite), `rights-core` (Fastify/PG), `vcrl` (MDRL 엔진) |
| **05. 참고자료** | [`05_참고자료/`](file:///Users/changkyuneun/Vocal%20Combination/05_%EC%B0%B8%EA%B3%A0%EC%9E%90%EB%A3%8C/) | 벤치마킹 분석, 시장 리포트 |
| **99. 아카이브** | [`99_아카이브/`](file:///Users/changkyuneun/Vocal%20Combination/99_%EC%95%84%EC%B9%B4%EC%9D%B4%EB%B8%8C/) | 구버전 백업, 중복 문서, 이전 산출물 |

---

## 🛠️ 개발 시작하기

```bash
cd 04_구현_소스코드

# MDRL 엔진 테스트 (300개 테스트)
npm test --prefix vcrl

# dobedupop 백오피스 웹앱 실행
npm run dev -w backoffice
```
