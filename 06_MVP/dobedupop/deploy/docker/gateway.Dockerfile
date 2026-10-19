# 게이트웨이 이미지(MVP 진행계획 M2): 서브도메인별 앱 정적 파일 + 허용 채널만 코어로 넘기는 역방향 프록시(Caddy).
# 빌드 컨텍스트: 06_MVP/dobedupop.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mdrl/package.json packages/mdrl/
COPY packages/ui/package.json packages/ui/
COPY services/rights-core/package.json services/rights-core/
COPY services/audio-service/package.json services/audio-service/
COPY services/integration-hub/package.json services/integration-hub/
COPY apps/backoffice/package.json apps/backoffice/
COPY apps/performer/package.json apps/performer/
COPY apps/demo-console/package.json apps/demo-console/
COPY demo/dynamite/package.json demo/dynamite/
RUN npm ci --ignore-scripts
# 백오피스 타입 검사는 E2E가 쓰는 오디오 시험 도구까지 본다.
COPY services/audio-service services/audio-service
# 공통 테마(색·글꼴)
COPY packages/ui packages/ui
COPY apps apps
RUN npm run build:hosts -w backoffice && npm run build -w performer-app && npm run build -w demo-console

FROM caddy:2.10-alpine
COPY deploy/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/apps/backoffice/dist/portal-host /srv/portal
COPY --from=web /app/apps/backoffice/dist/ops /srv/ops
COPY --from=web /app/apps/backoffice/dist/partner-host /srv/partner
COPY --from=web /app/apps/performer/dist /srv/artist
# 데모 진행판은 데모 호스트에서만 열린다(운영 게이트웨이 설정에는 demo 블록이 없다).
COPY --from=web /app/apps/demo-console/dist /srv/demo
