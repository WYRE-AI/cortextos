import type { NextConfig } from "next";
import path from "path";

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Coolify deployment: emit a self-contained server bundle so the runtime
  // image can ship without dev deps or the full node_modules tree. Standalone
  // mode produces .next/standalone/server.js which the Dockerfile runs.
  output: 'standalone',
  // Pin trace root to this package — without it, Next.js detects the parent
  // monorepo (root + dashboard each have a package-lock.json) and nests the
  // standalone output under .next/standalone/dashboard/. The Docker COPY
  // commands assume server.js sits directly in .next/standalone/.
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['better-sqlite3'],
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
