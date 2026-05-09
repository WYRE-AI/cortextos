# cortextOS dashboard — Coolify deployment image
#
# Build:  docker build -t cortextos-dashboard:local .
# Run:    docker run -p 3000:3000 \
#           -v cortextos-state:/state \
#           -e CTX_ROOT=/state \
#           -e AUTH_SECRET=$(openssl rand -base64 32) \
#           -e ADMIN_USERNAME=admin \
#           -e ADMIN_PASSWORD=changeme \
#           -e TRUST_PROXY=true \
#           cortextos-dashboard:local
#
# Architecture note (read this before deploying):
# The dashboard's API routes shell out to the `cortextos bus` CLI, which
# talks to the daemon's IPC socket at $CTX_ROOT/daemon.sock. If the daemon
# is on a different host (e.g. your Mac) than this container, dashboard
# pages that require live agent state will render but their data calls
# will fail. The deployment is still useful as an infra dry-run for the
# eventual full-stack migration; it just won't show live agents until the
# daemon also runs here.

# ---------- deps stage: install + native compile better-sqlite3 ----------
FROM node:22-bookworm-slim AS deps

# better-sqlite3 needs python3 + build-essential for node-gyp during npm ci.
# bookworm-slim ships glibc which avoids the alpine/musl native-module
# headaches that bite better-sqlite3 + node-pty.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- builder stage: compile Next.js to standalone ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Skip Next.js telemetry on every build.
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------- runner stage: minimal runtime ----------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root user. Next.js standalone wants to read .next/static and the
# state volume; uid 1001 keeps consistent volume permissions across
# Coolify rebuilds.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --shell /bin/false nextjs

# Standalone bundle ships the trimmed node_modules and a server.js entry.
# Static assets and public/ are not in the standalone tree — copy them
# explicitly. better-sqlite3's compiled .node binary lives under
# node_modules/better-sqlite3/build/, which standalone trace pulls in
# automatically since serverExternalPackages flags it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# State directory: mount a persistent volume here on Coolify and set
# CTX_ROOT=/state so the SQLite cache and (eventually) bus state survive
# container rebuilds.
RUN mkdir -p /state && chown nextjs:nodejs /state
VOLUME ["/state"]

USER nextjs

EXPOSE 3000

# Healthcheck hits /login because it's a static-rendered public route —
# guaranteed to return 200 if Next.js is up, regardless of auth state or
# daemon connectivity. Avoids healthcheck-as-liveness-of-daemon coupling.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
