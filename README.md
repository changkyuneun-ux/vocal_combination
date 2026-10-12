# dobedubpop & MDRL

이 저장소에는 다음 두 가지의 설계 문서와 구현 코드가 있습니다.

- **dobedubpop(두비덥팝)**: 사용자·팬 참여형 보컬 조합과 음악 2차이용 플랫폼
- **MDRL(Music Derivative Rights Language)**: 2차 창작물의 다자간 권리관계, 이용허락, 정산을 다루는 도메인 특화 권리언어

용어, 최신 문서 색인, 전체 구조는 [00_프로젝트_개요/README.md](00_프로젝트_개요/README.md)를 보세요.

## 폴더 지도

| 폴더 | 내용 |
| :--- | :--- |
| [00_프로젝트_개요](00_프로젝트_개요/) | 통합 가이드, [용어 사전·아키텍처 맵](00_프로젝트_개요/프로젝트_용어_및_아키텍처_맵.md) |
| [01_기획_비즈니스](01_기획_비즈니스/) | 사업기획서 v1.15, IR Deck, 특허 문서 (`최신_사업기획서/`, `기획_히스토리/`) |
| [02_MDRL_언어규격](02_MDRL_언어규격/) | [MDRL 언어레퍼런스북 v1.0](02_MDRL_언어규격/MDRL_언어레퍼런스북_v1.0.md), 핵심설계(안분·정산DSL·게이팅), 구현계획, 정산인프라 연계 |
| [03_dobedubpop_플랫폼설계](03_dobedubpop_플랫폼설계/) | 데이터모델 v2.8, 백오피스 UI가이드 v1.6·구성방안 v1.8·IA (`최신설계/`, `설계_히스토리/`) |
| [04_구현_소스코드](04_구현_소스코드/) | npm 워크스페이스(`mdrl`, `rights-core`, `backoffice`)와 HTML 프로토타입 |
| [05_참고자료](05_참고자료/) | 벤치마킹, 초기 NFT·서비스 검토 자료 |
| [99_아카이브](99_아카이브/) | 구버전, 중복 파일, 백업, 이전 Claude 산출물 |

## 명칭 규칙

- 플랫폼명은 `dobedubpop`(두비덥팝)으로 씁니다. 과거 표기인 `dobedopop`·`dobedupop`은 히스토리 폴더와 아카이브에만 남아 있습니다.
- 권리언어의 명칭은 **MDRL**로 통일합니다. 코드의 패키지명·CLI·`.mdrl` 확장자·문서 키·digest 접두어(`mdrl:sha256:`)·DB 도메인(`mdrl_id`)도 모두 `mdrl`입니다. 과거 이름인 `VCRL`/`vcrl`은 히스토리 폴더와 아카이브에만 남아 있습니다.

## 개발 시작하기

```bash
cd 04_구현_소스코드
npm install

npm test --prefix mdrl          # MDRL 엔진 단위 테스트
npm run dev -w backoffice       # 백오피스 (http://localhost:5173)
npm run dev -w rights-core      # 백엔드 (PostgreSQL 필요: docker compose up -d)
```

단독 실행형 백오피스 시안: [dobedubpop-backoffice-prototype_v2.7.html](04_구현_소스코드/prototypes/dobedubpop-backoffice-prototype_v2.7.html)
