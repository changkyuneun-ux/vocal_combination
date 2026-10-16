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
```

앞으로 생길 폴더(진행계획 M2~M5): `apps/demo-console/`(데모 진행판), `demo/dynamite/`(가상 데이터·가상 팬 생성기), `deploy/`(게이트웨이·Dockerfile·Compose·환경 설정), `docs/`(데모 가이드·운영 런북·요건 추적표).

## 개발 실행

```bash
npm install
docker compose up -d            # PostgreSQL(프로젝트 이름 dobedupop, 포트 54329)
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
