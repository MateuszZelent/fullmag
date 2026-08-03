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
  ...(configuredPublicDevHostValue &&
  !["localhost", "127.0.0.1", "::1"].includes(configuredPublicDevHostValue)
    ? [configuredPublicDevHostValue]
    : []),
];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  distDir: auditBuild ? ".next-audit" : ".next",
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
