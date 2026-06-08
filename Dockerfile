# MyCraft production image.
# Multi-stage: the builder compiles native deps (better-sqlite3); the runtime
# stage carries only the app and its production node_modules.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Build toolchain for native modules (better-sqlite3 falls back to a source
# build if no prebuilt binary matches the platform).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public

# SQLite lives here; mounted as a Fly volume so the world/accounts persist.
ENV DATA_DIR=/data
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/server.js"]
