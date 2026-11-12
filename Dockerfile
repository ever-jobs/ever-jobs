# ── Build stage ────────────────────────────
FROM node:26.12.1-alpine AS builder

WORKDIR /app

# Native-build toolchain for `better-sqlite3` (and any other node-gyp deps).
# Alpine's node:26.12.1-alpine image ships without python3 / make / g++, so npm ci
# fails when node-gyp tries to compile native modules. The toolchain only
# lives in the builder stage — the runtime stage copies prebuilt
# node_modules and stays slim.
RUN apk add --no-cache python3 make g++ libc-dev openssl

# Build native modules against the headers ALREADY IN THIS IMAGE instead of
# downloading them.
#
# `better-sqlite3` 12.11.1 publishes a musl prebuild for Node 26 (ABI 147,
# `node-v147-linuxmusl-x64`), which `prebuild-install` downloads from GitHub.
# When no prebuild matches (another version, or that download fails), it falls
# back to `node-gyp rebuild`, and node-gyp then fetches
# https://unofficial-builds.nodejs.org/download/release/v26.12.1/node-v26.12.1-headers.tar.gz,
# and that host is reached from an ARC runner pod with unreliable egress — it
# ETIMEDOUTs intermittently and fails the whole image build. It cost two
# re-runs on 2026-08-01 alone (03:26 and 17:17); a plain re-run "fixed" it both
# times, which is exactly what makes it easy to keep dismissing as noise.
#
# node:26.12.1-alpine already ships the complete header set at
# /usr/local/include/node (node.h, common.gypi, config.gypi), so pointing
# node-gyp at it removes the download entirely — the build no longer depends on
# reaching an external host at all.
#
# Verified in a node:20-alpine pod: with this set, `npm install better-sqlite3
# --build-from-source` emits `gyp info ok` with NO `gyp http GET` and no
# headers.tar.gz fetch, and the compiled module loads.
ENV npm_config_nodedir=/usr/local

# Copy dependency manifests
COPY package*.json ./

# Install ALL dependencies (needed for build)
RUN npm ci

# Copy full source
COPY . .

# Spec 1722 — generate the Prisma client for the optional Postgres store
# (EVER_JOBS_STORE=postgres). `openssl` above lets Prisma pick the right
# musl engine. Best-effort on purpose: a failure here must never break the
# image build; a deployment that selects postgres without a generated client
# fails fast at boot with the command to run instead. The placeholder URL only
# satisfies schema validation — generate never connects.
RUN DATABASE_URL=postgresql://placeholder@localhost:5432/placeholder \
  npx prisma generate --schema packages/plugins/store-postgres-prisma/prisma/schema.prisma \
  || echo 'WARN: prisma generate failed; EVER_JOBS_STORE=postgres will fail fast at boot'

# Build the API application
RUN npx nest build

# ── Runtime stage ──────────────────────────
FROM node:26.12.1-alpine AS runtime

WORKDIR /app

# Install curl for healthcheck; openssl (libssl3) is what the Prisma query
# engine links against when EVER_JOBS_STORE=postgres (Spec 1722).
RUN apk add --no-cache curl openssl

# Copy production deps from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy built output
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p /app/logs

# ── Environment defaults ──────────────────
# These can be overridden by docker-compose or runtime env
ENV NODE_ENV=production
ENV PORT=3001

# API Security
ENV ENABLE_API_KEY_AUTH=false
ENV API_KEYS=""
ENV API_KEY_HEADER_NAME=x-api-key

# Rate Limiting
ENV RATE_LIMIT_ENABLED=false
ENV RATE_LIMIT_REQUESTS=100
ENV RATE_LIMIT_TIMEFRAME=3600

# Caching — off by default, like the app default (configuration.ts); set
# ENABLE_CACHE=true to cache raw search results for CACHE_EXPIRY seconds.
ENV ENABLE_CACHE=false
ENV CACHE_EXPIRY=3600

# Logging
ENV LOG_LEVEL=info

# CORS
ENV CORS_ORIGINS=*

# Search Defaults
ENV DEFAULT_SITE_NAMES=linkedin,indeed,zip_recruiter,glassdoor,google,bayt,naukri,bdjobs,internshala,exa,upwork
ENV DEFAULT_RESULTS_WANTED=20
ENV DEFAULT_DISTANCE=50
ENV DEFAULT_DESCRIPTION_FORMAT=markdown
ENV DEFAULT_COUNTRY=USA

# Swagger
ENV ENABLE_SWAGGER=true
ENV SWAGGER_PATH=api/docs

EXPOSE ${PORT}

# Health check (every 30s, 10s timeout, 5s start, 3 retries)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/apps/api/main.js"]
