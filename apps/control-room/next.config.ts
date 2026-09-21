import type { NextConfig } from "next";
import { realpathSync } from "node:fs";
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
const frontendRoot = process.env.FULLMAG_FRONTEND_ROOT?.trim();

const CONTROL_ROOM_EXPORT_DIST_DIR = ".fullmag-frontend/out";

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
  managedStorage = false,
  staticExport = false,
  requestedDistDir,
}: {
  auditBuild: boolean;
  managedStorage?: boolean;
  staticExport?: boolean;
  requestedDistDir?: string;
}): string {
  // Next 16 treats output:'export' with a non-.next distDir as the export
  // directory and uses .next for its temporary build. The managed parent link
  // keeps both directories outside the checkout without patching Next.
  if (staticExport && managedStorage) {
    return CONTROL_ROOM_EXPORT_DIST_DIR;
  }
  const normalized = requestedDistDir?.trim();
  if (isIsolatedSmokeDistDir(normalized) || isIsolatedDevDistDir(normalized)) {
    return normalized;
  }
  return auditBuild ? ".next-audit" : ".next";
}

const distDir = resolveControlRoomDistDir({
  auditBuild,
  managedStorage: Boolean(frontendRoot),
  staticExport,
  requestedDistDir: process.env.FULLMAG_NEXT_DIST_DIR,
});

function pathEquals(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertManagedLink(
  appRoot: string,
  frontendRoot: string,
  relativeLink: string,
  relativeTarget: string,
): void {
  const linkPath = path.resolve(appRoot, relativeLink);
  const targetPath = path.resolve(frontendRoot, relativeTarget);
  let resolvedLink: string;
  let resolvedTarget: string;
  try {
    resolvedLink = realpathSync(linkPath);
    resolvedTarget = realpathSync(targetPath);
  } catch (error) {
    throw new Error(
      `Managed Control Room storage is not prepared: ${relativeLink} must resolve to ${targetPath}`,
      { cause: error },
    );
  }
  if (!pathEquals(resolvedLink, resolvedTarget)) {
    throw new Error(
      `Managed Control Room storage link mismatch: ${linkPath} -> ${resolvedLink}; expected ${resolvedTarget}`,
    );
  }
}

function managedNextTarget(distDirValue: string): string | null {
  if (distDirValue === ".next") {
    return "next/default";
  }
  if (distDirValue === ".next-audit") {
    return "next/audit";
  }
  const devMatch = /^\.next-control-room-(\d{1,5})$/.exec(distDirValue);
  if (devMatch) {
    return `next/dev-${devMatch[1]}`;
  }
  const smokeMatch = /^\.next-audit-target-smoke-([a-z0-9-]+)$/.exec(
    distDirValue,
  );
  return smokeMatch ? `next/smoke-${smokeMatch[1]}` : null;
}

export function validateManagedControlRoomStorage({
  appRoot,
  distDir: distDirValue,
  frontendRoot,
  staticExport: staticExportValue,
}: {
  appRoot: string;
  distDir: string;
  frontendRoot: string;
  staticExport: boolean;
}): void {
  if (!path.isAbsolute(frontendRoot)) {
    throw new Error(`FULLMAG_FRONTEND_ROOT must be absolute: ${frontendRoot}`);
  }
  const normalizedAppRoot = path.resolve(appRoot);
  const normalizedFrontendRoot = path.resolve(frontendRoot);
  const repositoryRoot = path.resolve(normalizedAppRoot, "../..");
  const outsideRepository = path.relative(
    repositoryRoot,
    normalizedFrontendRoot,
  );
  if (
    outsideRepository === "" ||
    (!outsideRepository.startsWith(`..${path.sep}`) &&
      outsideRepository !== ".." &&
      !path.isAbsolute(outsideRepository))
  ) {
    throw new Error(
      `FULLMAG_FRONTEND_ROOT must be outside the repository: ${frontendRoot}`,
    );
  }

  // This link is also the safe parent for Next's export output. The target is
  // deliberately checked through realpathSync so a junction cannot redirect
  // writes to an unrelated directory.
  assertManagedLink(appRoot, frontendRoot, ".fullmag-frontend", ".");
  assertManagedLink(appRoot, frontendRoot, "out", "out");

  const nextTarget = staticExportValue
    ? "next/default"
    : managedNextTarget(distDirValue);
  if (nextTarget === null) {
    throw new Error(`Unsupported managed Next distDir: ${distDirValue}`);
  }
  assertManagedLink(appRoot, frontendRoot, ".next", "next/default");
  if (!staticExportValue || distDirValue !== CONTROL_ROOM_EXPORT_DIST_DIR) {
    assertManagedLink(appRoot, frontendRoot, distDirValue, nextTarget);
  }
}

if (frontendRoot) {
  validateManagedControlRoomStorage({
    appRoot: process.cwd(),
    distDir,
    frontendRoot,
    staticExport,
  });
}

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

/**
 * Baseline production security headers (frontend audit 2026-09-03, P0 item 2).
 *
 * Deliberately permissive on script/style/connect sources: this is a
 * WebGL-heavy app (three.js / react-three-fiber) whose API host is
 * deployment-configurable (FULLMAG_API_PROXY_TARGET / FULLMAG_API_URL) and
 * whose realtime layer may reach ws/wss hosts that cannot be enumerated at
 * build time. Not applied under static export (Tauri desktop build): Next.js
 * rejects `headers()` when `output: "export"` is set, and the desktop shell
 * is not a browser-hosted document anyway.
 */
function securityHeaders() {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' http: https: ws: wss:",
        "worker-src 'self' blob:",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "object-src 'none'",
      ].join("; "),
    },
  ];
}

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
        // The launcher probes / without following redirects. Resolve the
        // existing home redirect before Next lazily compiles any page so a
        // cold workspace compilation cannot exhaust the bootstrap deadline.
        async redirects() {
          return [{ source: "/", destination: "/workspace", permanent: false }];
        },
        async headers() {
          return [
            {
              source: "/:path*",
              headers: securityHeaders(),
            },
          ];
        },
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
