# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

COPY package.json pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

# ── Stage 2: API runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS api
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json
# node_modules needed for argon2's native bindings and other runtime deps not
# bundled by esbuild (see apps/api/build.mjs's external list).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db/drizzle ./packages/db/drizzle

EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]

# ── Stage 3: Dashboard static files ──────────────────────────────────────────
FROM nginx:alpine AS web
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
