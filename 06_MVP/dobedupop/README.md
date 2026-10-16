# dobedupop MVP

권리자 포털·실연자 앱·운영 백오피스와 권리 및 정산 코어를 담은 모노레포다. 상용 시스템이 이 구조를 그대로 이어받는다. 계획과 결정은 [MVP 진행계획](../../00_프로젝트_개요/MVP_진행계획_Dynamite데모_20261016.md), 화면 구조는 [UI 구조 목업](../mockup/)에 있다.

```
apps/
  backoffice/        권리자 포털·운영 백오피스(한 코드베이스, 두 빌드: VITE_APP=portal|ops)
  performer/         실연자 앱(모바일 PWA, 패키지 이름 performer-app)
services/
  rights-core/       권리 및 정산 코어(API·워커, PostgreSQL)
  audio-service/     오디오 처리 서비스(검수·출처·렌더)
  integration-hub/   연동 허브(유통사 CSV·DDEX 번역)
packages/
  mdrl/              MDRL 엔진 라이브러리(engine-bridge만 import)
  ui/                공통 화면 테마(색 토큰 라이트·다크, Pretendard 글꼴, 기본 컴포넌트) — 모든 앱이 쓴다. 화면 코드에 색을 직접 쓰지 않는다
deploy/
  docker/            코어(API·워커·검증 워커·오디오 공용) 이미지, 게이트웨이 이미지
  gateway/Caddyfile  서브도메인 = 앱 = 채널, 다른 채널 차단, 보안 헤더, 운영 IP 제한
  compose/           compose.demo.yml(데모 스택), compose.demo.test.yml(시험용 코어 포트)
  env/               demo.env.example, production.env.example
  s3/                S3 호환 저장소(SeaweedFS) 개발용 자격 증명
  smoke/             게이트웨이 연기 시험
docs/                요건 추적표(앞으로 데모 가이드·운영 런북)
```

데모: `apps/demo-console/`(데모 진행판 화면), `demo/dynamite/`(진행판 서버 — 페르소나 시나리오를 단계별로 실행). 사용법은 [데모 가이드](docs/데모_가이드.md).

## 데모 스택(서브도메인)

```bash
cp deploy/env/demo.env.example deploy/env/demo.env    # RC_DOC_KEY 채우기: openssl rand -base64 32
docker compose -f deploy/compose/compose.demo.yml --env-file deploy/env/demo.env up -d --build
node deploy/smoke/gateway-smoke.ts                    # 채널 격리·보안 헤더 확인
```

- http://portal.dobedupop.localhost — 권리자 포털, http://artist.dobedupop.localhost — 실연자 앱, http://ops.dobedupop.localhost — 운영 백오피스
- 컨테이너: postgres, s3(SeaweedFS), migrate(1회), core-api, core-worker, core-verifier, audio, gateway
- 로그인: 운영 = 비밀번호 + 인증 앱 코드(첫 로그인에서 등록), 포털 = 비밀번호, 실연자 = 본인 인증 코드. 데모 환경은 로그인 화면에 "데모 페르소나로 들어가기"가 있다. 계정은 운영이 발급하고 초대 링크(`?invite=`)로 비밀번호를 정한다.
- 게이트웨이는 개발용 신원 헤더(x-actor)를 지운다. 시험은 `compose.demo.test.yml`로 연 코어 포트(127.0.0.1:18080)에 직접 붙어 헤더를 쓴다.
- 데모 스택 시험(Dynamite 금액 대조·로그인·화면 점검): `compose.demo.test.yml`을 덧붙여 올린 뒤 `cd apps/backoffice && E2E_BACKEND=http://127.0.0.1:18080 npx playwright test`

## 개발 실행

```bash
npm install
docker compose up -d            # PostgreSQL(포트 54329)·S3 호환 저장소(8333), 프로젝트 이름 dobedupop
npm run dev:db -w rights-core   # 개발 DB 생성·마이그레이션
npm run dev -w rights-core      # 코어(http://127.0.0.1:8080, 개발 모드)
npm run dev -w backoffice       # 권리자 포털·운영 백오피스(http://localhost:5173)
npm run dev -w performer-app    # 실연자 앱
```

## 시험

```bash
npm test -w mdrl && npm test -w rights-core && npm test -w audio-service && npm test -w integration-hub
npm test -w backoffice && npm test -w performer-app
(cd apps/backoffice && npx playwright test) && (cd apps/performer && npx playwright test)
npm run scenario:dynamite -w rights-core -- --out <디렉터리>   # Dynamite 예시 보고서 재현
```
