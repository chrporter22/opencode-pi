# ---- build stage ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci

COPY gateway/tsconfig.json ./
COPY gateway/src ./src
COPY gateway/public ./public

RUN npm run build

# ---- ui build stage ----
FROM node:22-bookworm-slim AS ui

WORKDIR /app

COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY ui/ ./
RUN npm run build

# ---- runtime stage (small, Node-only, glibc for the host llama binary) ----
FROM node:22-trixie-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=ui /app/dist ./public

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]