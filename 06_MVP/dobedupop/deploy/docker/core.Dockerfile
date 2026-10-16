# 권리 및 정산 코어·오디오 처리 서비스 이미지(MVP 진행계획 M2). 한 이미지를 역할별 명령으로 띄운다(compose 참고).
# 빌드 컨텍스트: 06_MVP/dobedupop. Node 24는 .ts를 그대로 실행한다(타입 제거), MDRL만 dist로 빌드한다.
FROM node:24-bookworm-slim AS build
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
COPY packages/mdrl packages/mdrl
RUN npm run build -w mdrl

FROM node:24-bookworm-slim
# 오디오 검수·렌더링은 ffmpeg·ffprobe를 부른다.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
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
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/mdrl packages/mdrl
COPY services services
# 데모 진행판 서버(데모 환경에서만 띄운다): 페르소나 시나리오를 코어 API로 단계별 실행.
COPY demo demo
USER node
EXPOSE 8080
CMD ["node", "services/rights-core/src/http/main.ts"]
