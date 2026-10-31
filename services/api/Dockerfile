# SuperCompress API on Fly — Node adapter over existing api/*.js handlers.
# Build context: repository root.
FROM node:24-bookworm-slim

WORKDIR /app

# Lean runtime deps (skip playwright / proxy postinstall bloat)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
  && npm cache clean --force

COPY api ./api
COPY services/api ./services/api
COPY services/gateway ./services/gateway
COPY packages/control-plane ./packages/control-plane
COPY mcp ./mcp
COPY web/assets/js/compress-engine.js ./web/assets/js/compress-engine.js
COPY web/assets/data/model.json ./web/assets/data/model.json

# Match Vercel buildCommand asset sync for serverless compress engine
RUN mkdir -p api/_lib \
  && cp web/assets/js/compress-engine.js api/_lib/ \
  && cp web/assets/data/model.json api/_lib/

ENV NODE_ENV=production
ENV PORT=8080
USER node
EXPOSE 8080

CMD ["node", "services/api/server.js"]
