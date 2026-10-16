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
deploy/
  docker/            코어(API·워커·검증 워커·오디오 공용) 이미지, 게이트웨이 이미지
  gateway/Caddyfile  서브도메인 = 앱 = 채널, 다른 채널 차단, 보안 헤더, 운영 IP 제한
  compose/           compose.demo.yml(데모 스택), compose.demo.test.yml(시험용 코어 포트)
  env/               demo.env.example, production.env.example
  s3/                S3 호환 저장소(SeaweedFS) 개발용 자격 증명
  smoke/             게이트웨이 연기 시험
docs/                요건 추적표(앞으로 데모 가이드·운영 런북)
```

앞으로 생길 폴더(진행계획 M4·M5): `apps/demo-console/`(데모 진행판), `demo/dynamite/`(가상 데이터·가상 팬 생성기).

## 데모 스택(서브도메인)

```bash
cp deploy/env/demo.env.example deploy/env/demo.env    # RC_DOC_KEY 채우기: openssl rand -base64 32
docker compose -f deploy/compose/compose.demo.yml --env-file deploy/env/demo.env up -d --build
node deploy/smoke/gateway-smoke.ts                    # 채널 격리·보안 헤더 확인
```

- http://portal.dobedupop.localhost — 권리자 포털, http://artist.dobedupop.localhost — 실연자 앱, http://ops.dobedupop.localhost — 운영 백오피스
- 컨테이너: postgres, s3(SeaweedFS), migrate(1회), core-api, core-worker, core-verifier, audio, gateway
- 아직 로그인이 없다(M3). 빌드된 앱에는 개발용 사용자 전환이 없으므로 화면 조작은 M3 뒤에 된다. API는 x-actor 헤더로 시험한다.
- 역할을 나눈 정산 시험: `compose.demo.test.yml`을 덧붙여 올린 뒤 `cd apps/backoffice && E2E_BACKEND=http://127.0.0.1:18080 npx playwright test`

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
