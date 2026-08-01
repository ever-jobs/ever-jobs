# ── Build stage ────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Native-build toolchain for `better-sqlite3` (and any other node-gyp deps).
# Alpine's node:20-alpine image ships without python3 / make / g++, so npm ci
# fails when node-gyp tries to compile native modules. The toolchain only
# lives in the builder stage — the runtime stage copies prebuilt
# node_modules and stays slim.
RUN apk add --no-cache python3 make g++ libc-dev

# Build native modules against the headers ALREADY IN THIS IMAGE instead of
# downloading them.
#
# `better-sqlite3` publishes no prebuilt binary for musl, so `prebuild-install`
# always misses and falls back to `node-gyp rebuild`. node-gyp then fetches
# https://unofficial-builds.nodejs.org/download/release/v20.20.2/node-v20.20.2-headers.tar.gz,
# and that host is reached from an ARC runner pod with unreliable egress — it
# ETIMEDOUTs intermittently and fails the whole image build. It cost two
# re-runs on 2026-08-01 alone (03:26 and 17:17); a plain re-run "fixed" it both
# times, which is exactly what makes it easy to keep dismissing as noise.
#
# node:20-alpine already ships the complete header set at
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

# Build the API application
RUN npx nest build

# ── Runtime stage ──────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

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

# Caching
ENV ENABLE_CACHE=true
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
