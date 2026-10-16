# 게이트웨이 이미지(MVP 진행계획 M2): 서브도메인별 앱 정적 파일 + 허용 채널만 코어로 넘기는 역방향 프록시(Caddy).
# 빌드 컨텍스트: 06_MVP/dobedupop.
FROM node:24-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mdrl/package.json packages/mdrl/
COPY services/rights-core/package.json services/rights-core/
COPY services/audio-service/package.json services/audio-service/
COPY services/integration-hub/package.json services/integration-hub/
COPY apps/backoffice/package.json apps/backoffice/
COPY apps/performer/package.json apps/performer/
RUN npm ci --ignore-scripts
# 백오피스 타입 검사는 E2E가 쓰는 오디오 시험 도구까지 본다.
COPY services/audio-service services/audio-service
COPY apps apps
RUN npm run build:hosts -w backoffice && npm run build -w performer-app

FROM caddy:2.10-alpine
COPY deploy/gateway/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /app/apps/backoffice/dist/portal-host /srv/portal
COPY --from=web /app/apps/backoffice/dist/ops /srv/ops
COPY --from=web /app/apps/performer/dist /srv/artist
