# Ever Jobs MCP server — standalone image for the internal k8s deployment (Streamable-HTTP mode).
# The MCP (apps/mcp) is a self-contained Node app (no @ever-jobs/* imports) that calls the Ever
# Jobs REST API over HTTP, so it builds independently of the Nx monorepo.
# ── Build ──────────────────────────────────────────────
FROM node:26-alpine AS builder
WORKDIR /app
# apps/mcp/tsconfig.json extends ../../tsconfig.base.json — provide it at the repo-root path.
COPY tsconfig.base.json ./tsconfig.base.json
WORKDIR /app/apps/mcp
COPY apps/mcp/package.json ./package.json
RUN npm install --no-audit --no-fund
COPY apps/mcp/tsconfig.json ./tsconfig.json
COPY apps/mcp/src ./src
RUN npm run build

# ── Runtime ────────────────────────────────────────────
FROM node:26-alpine AS runtime
WORKDIR /app/apps/mcp
RUN apk add --no-cache curl
COPY --from=builder /app/apps/mcp/node_modules ./node_modules
COPY --from=builder /app/apps/mcp/dist ./dist
COPY --from=builder /app/apps/mcp/package.json ./package.json
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=3002
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3002/health || exit 1
CMD ["node", "dist/index.js"]
