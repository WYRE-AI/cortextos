import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";

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
  // Pin Turbopack's project root to dashboard/.
  //
  // src/lib/config.ts falls back to `path.resolve(process.cwd(), '..')` for
  // CTX_FRAMEWORK_ROOT. Turbopack reads that as a directory asset reference and
  // walks the whole parent repo at module-graph time, where it hits
  // knowledge-base/venv/bin/python3.14 -> /opt/homebrew/... — an absolute
  // symlink out of the project root that it refuses to trace, failing the whole
  // build with a TurbopackInternalError. A failed `next build` is why this app
  // was being served by `next dev` in production, which costs a multi-second
  // on-demand compile on the first hit of every route after each restart.
  //
  // Those parent-repo reads are runtime fs access, not bundled imports, so
  // narrowing the build-time root does not affect them. Nothing in src/ imports
  // from outside dashboard/ (only a .test.ts type import, excluded from builds).
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
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
