import type { NextConfig } from "next";
import path from "node:path";

function controlRoomApiProxyTarget(): string {
  return (
    process.env.FULLMAG_API_PROXY_TARGET ??
    process.env.FULLMAG_API_URL ??
    "http://localhost:8081"
  ).replace(/\/+$/, "");
}

const staticExport = process.env.FULLMAG_CONTROL_ROOM_STATIC_EXPORT === "1";
const auditBuild = process.env.NEXT_PUBLIC_AUDIT_BUILD === "1";

function isIsolatedSmokeDistDir(value: string | undefined): value is string {
  return /^\.next-audit-target-smoke-[a-z0-9-]+$/.test(value ?? "");
}

function isIsolatedDevDistDir(value: string | undefined): value is string {
  const match = /^\.next-control-room-(\d{1,5})$/.exec(value ?? "");
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535;
}

export function resolveControlRoomDistDir({
  auditBuild,
  requestedDistDir,
}: {
  auditBuild: boolean;
  requestedDistDir?: string;
}): string {
  const normalized = requestedDistDir?.trim();
  if (isIsolatedSmokeDistDir(normalized) || isIsolatedDevDistDir(normalized)) {
    return normalized;
  }
  return auditBuild ? ".next-audit" : ".next";
}

const distDir = resolveControlRoomDistDir({
  auditBuild,
  requestedDistDir: process.env.FULLMAG_NEXT_DIST_DIR,
});

function configuredPublicDevHost(): string | null {
  const raw = process.env.FULLMAG_WEB_PUBLIC_HOST?.trim();
  if (!raw) {
    return null;
  }

  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
  } catch {
    return null;
  }
}

const configuredPublicDevHostValue = configuredPublicDevHost();
const allowedDevOrigins = [
  "fullmag.amucontainers.orion.zfns.eu.org",
  "127.0.0.1",
  ...(configuredPublicDevHostValue &&
  !["localhost", "127.0.0.1", "::1"].includes(configuredPublicDevHostValue)
    ? [configuredPublicDevHostValue]
    : []),
];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  distDir,
  // R3F v9 force-loses WebGL during React development strict remounts.
  reactStrictMode: false,
  ...(staticExport
    ? {
        output: "export" as const,
        trailingSlash: true,
      }
    : {
        async rewrites() {
          const apiTarget = controlRoomApiProxyTarget();
          return [
            {
              source: "/v2/:path*",
              destination: `${apiTarget}/v2/:path*`,
            },
          ];
        },
      }),
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
