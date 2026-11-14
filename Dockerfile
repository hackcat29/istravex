# syntax=docker/dockerfile:1.7
# Istravex API: the corpus, canonical ledgers, kit results and the mock
# Stellar RPC. Node 24 runs the TypeScript sources directly (no build step).

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    CORPUS_DIR=/app/corpus
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY kit/lib ./kit/lib
COPY kit/rpc/server.mjs kit/rpc/server.d.mts ./kit/rpc/
COPY corpus ./corpus
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/hackcat29/istravex" \
      org.opencontainers.image.description="Istravex API and mock Stellar RPC" \
      org.opencontainers.image.licenses="Apache-2.0"
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/v1/health > /dev/null || exit 1
CMD ["node", "server/index.ts"]
