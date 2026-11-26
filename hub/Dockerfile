# Multi-stage Docker image for Bionic Hub Control Plane + Web UI
FROM node:22-slim AS builder
WORKDIR /app

COPY packages/shared/package*.json ./packages/shared/
COPY hub/package*.json ./hub/
COPY hub/client/package*.json ./hub/client/

RUN npm --prefix packages/shared ci \
 && npm --prefix hub ci \
 && npm --prefix hub/client ci

COPY packages/shared ./packages/shared
COPY hub ./hub

RUN npm --prefix packages/shared run build \
 && npm --prefix hub/client run build \
 && npm --prefix hub run build

FROM node:22-slim
RUN apt-get update -qq && apt-get install -y -qq openssl git curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/packages/shared/package*.json ./packages/shared/
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/hub/package*.json ./hub/
COPY --from=builder /app/hub/dist ./hub/dist
COPY --from=builder /app/hub/server/db/migrations ./hub/dist/server/db/migrations
COPY --from=builder /app/hub/client/dist ./hub/client/dist

RUN npm --prefix packages/shared ci --omit=dev \
 && npm --prefix hub ci --omit=dev

ENV NODE_ENV=production
ENV HUB_HOST=127.0.0.1
ENV HUB_PORT=4000
EXPOSE 4000
CMD ["sh", "-c", "node hub/dist/server/db/migrate.js && exec node hub/dist/server/index.js"]
