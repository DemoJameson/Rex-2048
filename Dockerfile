FROM node:22-bookworm-slim AS widget-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json rslib.config.ts ./
COPY src ./src
COPY shared ./shared

RUN npm run build

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    API_BIND=0.0.0.0 \
    API_PORT=18081 \
    FLV_PORT=18080 \
    RTMP_PORT=1935 \
    FLV_BASE_URL=http://127.0.0.1:18080 \
    PUBLIC_BASE_URL= \
    TRUST_PROXY=0 \
    MAX_SESSIONS=128 \
    MAX_ACTIVE_STREAMS=16 \
    STREAM_ENCODER=auto \
    ENABLE_PROGRESS_RESET=0 \
    SESSION_STORE_PATH=/app/.data/sessions.json

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      fonts-noto-cjk \
      mesa-va-drivers \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY shared ./shared
COPY assets ./assets
COPY --from=widget-build /app/dist ./dist

RUN mkdir -p /app/.data \
    && chown -R node:node /app

USER node

EXPOSE 18081
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18081/api/health').then(async r=>{const body=await r.json().catch(()=>({}));process.exit(r.ok&&body.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.cjs"]
