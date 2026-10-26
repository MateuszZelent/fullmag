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

// Docker Desktop's Windows source mount pays a metadata round trip for each
// Watchpack poll. Five seconds bounds that overlap while keeping HMR latency
// explicit; the launcher may provide a validated per-workspace override.
export const DOCKER_DEV_WATCH_POLLING_DEFAULT_MS = 5_000;
const DOCKER_DEV_WATCH_POLLING_MIN_MS = 250;
const DOCKER_DEV_WATCH_POLLING_MAX_MS = 10_000;
const DOCKER_DEV_GENERATED_WATCH_PATH =
  /(?:^|[\\/])(?:node_modules|\.fullmag-frontend|\.next[^\\/]*)(?:[\\/]|$)/;
const DOCKER_DEV_GENERATED_WATCH_GLOBS = [
  "**/node_modules/**",
  "**/.fullmag-frontend/**",
  "**/.next*/**",
];

export function isDockerDevGeneratedWatchPath(pathValue: string): boolean {
  return DOCKER_DEV_GENERATED_WATCH_PATH.test(pathValue);
}

type DockerDevWatchIgnored = RegExp | string[];

function composeDockerDevIgnored(
  existingIgnored: unknown,
): DockerDevWatchIgnored {
  if (existingIgnored === undefined) {
    return DOCKER_DEV_GENERATED_WATCH_PATH;
  }
  if (existingIgnored instanceof RegExp) {
    const flags = existingIgnored.flags.replace(/[gy]/g, "");
    return new RegExp(
      `(?:${existingIgnored.source})|(?:${DOCKER_DEV_GENERATED_WATCH_PATH.source})`,
      flags,
    );
  }
  if (typeof existingIgnored === "string") {
    return [existingIgnored, ...DOCKER_DEV_GENERATED_WATCH_GLOBS];
  }
  if (Array.isArray(existingIgnored)) {
    if (!existingIgnored.every((entry) => typeof entry === "string")) {
      throw new Error(
        "Docker development Watchpack ignored matcher arrays must contain only strings",
      );
    }
    return [...existingIgnored, ...DOCKER_DEV_GENERATED_WATCH_GLOBS];
  }
  throw new Error(
    "Docker development Watchpack ignored matcher must use Webpack-supported strings or regular expressions",
  );
}

export function resolveDockerDevWatchPollingMs(
  rawValue =
    process.env.WATCHPACK_POLLING ?? process.env.FULLMAG_WATCHPACK_POLLING_MS,
): number {
  if (rawValue === undefined) {
    return DOCKER_DEV_WATCH_POLLING_DEFAULT_MS;
  }
  const normalized = rawValue.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `WATCHPACK_POLLING must be an integer between ${DOCKER_DEV_WATCH_POLLING_MIN_MS} and ${DOCKER_DEV_WATCH_POLLING_MAX_MS} ms; got ${rawValue}`,
    );
  }
  const pollingMs = Number(normalized);
  if (
    !Number.isSafeInteger(pollingMs) ||
    pollingMs < DOCKER_DEV_WATCH_POLLING_MIN_MS ||
    pollingMs > DOCKER_DEV_WATCH_POLLING_MAX_MS
  ) {
    throw new Error(
      `WATCHPACK_POLLING must be an integer between ${DOCKER_DEV_WATCH_POLLING_MIN_MS} and ${DOCKER_DEV_WATCH_POLLING_MAX_MS} ms; got ${rawValue}`,
    );
  }
  return pollingMs;
}

// The frontend launcher selects `native` when the source bind is a local Linux
// filesystem that delivers inotify events (for example a WSL ext4 checkout);
// then nothing polls the tree.
export function resolveDockerDevWatchOptions(
  existingIgnored: unknown,
  rawPollingMs?: string,
  watchMode = "polling",
): {
  poll?: number;
  ignored: DockerDevWatchIgnored;
} {
  const ignored = composeDockerDevIgnored(existingIgnored);
  if (watchMode === "native") {
    return { ignored };
  }
  if (watchMode !== "polling") {
    throw new Error(
      `FULLMAG_WATCHPACK_MODE must be "polling" or "native"; got ${watchMode}`,
    );
  }
  return { poll: resolveDockerDevWatchPollingMs(rawPollingMs), ignored };
}

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
/** Same window and variable as the API's instance discovery (ADR 0069). */
const INSTANCE_DISCOVERY_PORTS_ENV = "FULLMAG_INSTANCE_DISCOVERY_PORTS";
const DEFAULT_INSTANCE_DISCOVERY_PORTS = { first: 3197, last: 3260 };
const MAX_INSTANCE_DISCOVERY_PORTS = 256;

export function resolveInstanceDiscoveryPorts(
  value: string | undefined,
): { first: number; last: number } {
  if (value === undefined || value.trim() === "") return DEFAULT_INSTANCE_DISCOVERY_PORTS;
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(value);
  const first = match ? Number(match[1]) : Number.NaN;
  const last = match ? Number(match[2]) : Number.NaN;
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last > 65_535 ||
    last < first ||
    last - first + 1 > MAX_INSTANCE_DISCOVERY_PORTS
  ) {
    throw new Error(`${INSTANCE_DISCOVERY_PORTS_ENV} must be an ascending window of at most 256 ports`);
  }
  return { first, last };
}

/**
 * Exactly the loopback origins of the discovery window: they may embed this
 * Control Room as an instance tab, and this Control Room may frame them
 * (ADR 0069). Other local servers and remote pages cannot frame it.
 */
export function instanceTabFrameSources(value: string | undefined): string[] {
  const { first, last } = resolveInstanceDiscoveryPorts(value);
  const origins: string[] = ["'self'"];
  for (let port = first; port <= last; port += 1) {
    origins.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
  }
  return origins;
}

export const INSTANCE_TAB_FRAME_ANCESTORS = instanceTabFrameSources(
  process.env[INSTANCE_DISCOVERY_PORTS_ENV],
);

/**
 * Addresses of Control Room tabs, served by the workspace page. A static
 * export has no rewrites; its server answers unknown paths with the root
 * page, which renders the same workspace.
 */
export const TAB_ROUTE_SOURCES = ["/home", "/session/:slug", "/instance/:port"] as const;

function securityHeaders() {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    // No X-Frame-Options: it cannot list origins, and `frame-ancestors` below
    // supersedes it in every current browser (ADR 0069).
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
        // Session tabs show other local instances in frames (ADR 0069).
        `frame-src ${INSTANCE_TAB_FRAME_ANCESTORS.join(" ")}`,
        // Another local instance may show this one in a session tab (ADR 0069);
        // remote pages still cannot frame the Control Room.
        `frame-ancestors ${INSTANCE_TAB_FRAME_ANCESTORS.join(" ")}`,
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
            // Tab addresses (src/kernel/layout/tabRoutes.ts) all serve the
            // workspace page; the page selects the tab from its address.
            ...TAB_ROUTE_SOURCES.map((source) => ({ source, destination: "/workspace" })),
          ];
        },
      }),
  webpack(config, { dev }) {
    if (dev && process.env.FULLMAG_DOCKER_FRONTEND === "dev") {
      config.watchOptions = {
        ...config.watchOptions,
        ...resolveDockerDevWatchOptions(
          config.watchOptions?.ignored,
          undefined,
          process.env.FULLMAG_WATCHPACK_MODE ?? "polling",
        ),
      };
    }
    return config;
  },
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
