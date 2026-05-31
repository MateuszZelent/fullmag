const DEFAULT_NODE_API_BASE = "http://localhost";
const DEFAULT_DEVELOPMENT_API_BASE = "http://localhost:8081";

const API_BASE_ENV_KEYS = [
  "NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL",
  "NEXT_PUBLIC_RUNTIME_HTTP_BASE",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_FULLMAG_API_URL",
] as const;

interface BrowserFullmagConfig {
  readonly apiBase?: unknown;
  readonly controlRoomApiBase?: unknown;
  readonly runtimeHttpBase?: unknown;
}

interface WindowLocationLike {
  readonly host: string;
  readonly origin: string;
  readonly protocol: string;
}

interface ControlRoomApiRuntimeSource {
  readonly env?: Record<string, unknown>;
  readonly windowConfig?: BrowserFullmagConfig;
  readonly windowLocation?: WindowLocationLike;
}

function normalizeApiBase(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");

  try {
    const url = new URL(withoutTrailingSlash);
    if (url.pathname === "/v2" || url.pathname.endsWith("/v2")) {
      url.pathname = url.pathname.slice(0, -"/v2".length) || "/";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    return withoutTrailingSlash;
  }

  return withoutTrailingSlash;
}

function defaultRuntimeSource(): ControlRoomApiRuntimeSource {
  const maybeWindow =
    typeof window !== "undefined"
      ? (window as Window & { __FULLMAG_CONFIG__?: BrowserFullmagConfig })
      : null;

  return {
    env: {
      NODE_ENV: process.env.NODE_ENV,
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL:
        process.env.NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL,
      NEXT_PUBLIC_FULLMAG_API_URL: process.env.NEXT_PUBLIC_FULLMAG_API_URL,
      NEXT_PUBLIC_RUNTIME_HTTP_BASE: process.env.NEXT_PUBLIC_RUNTIME_HTTP_BASE,
    },
    windowConfig: maybeWindow?.__FULLMAG_CONFIG__,
    windowLocation: maybeWindow?.location,
  };
}

function configuredBaseFromEnv(
  env: Record<string, unknown> | undefined,
): string | null {
  if (!env) {
    return null;
  }

  for (const key of API_BASE_ENV_KEYS) {
    const normalized = normalizeApiBase(env[key]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function configuredBaseFromWindow(
  config: BrowserFullmagConfig | undefined,
): string | null {
  if (!config) {
    return null;
  }

  return (
    normalizeApiBase(config.controlRoomApiBase) ??
    normalizeApiBase(config.runtimeHttpBase) ??
    normalizeApiBase(config.apiBase)
  );
}

function configuredDevelopmentBase(
  env: Record<string, unknown> | undefined,
): string | null {
  return env?.NODE_ENV === "development" ? DEFAULT_DEVELOPMENT_API_BASE : null;
}

function configuredLocalStandaloneFrontendBase(
  location: WindowLocationLike | undefined,
): string | null {
  if (!location) {
    return null;
  }

  try {
    const url = new URL(location.origin);
    if (!localHostnames.has(url.hostname)) {
      return null;
    }
    if (!url.port || localApiPorts.has(url.port)) {
      return null;
    }

    return `${url.protocol}//${url.hostname}:8081`;
  } catch {
    return null;
  }
}

const localHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const localApiPorts = new Set(["8081", "8181"]);

export function resolveControlRoomApiBase(
  source: ControlRoomApiRuntimeSource = defaultRuntimeSource(),
): string {
  return (
    configuredBaseFromWindow(source.windowConfig) ??
    configuredBaseFromEnv(source.env) ??
    configuredDevelopmentBase(source.env) ??
    configuredLocalStandaloneFrontendBase(source.windowLocation) ??
    normalizeApiBase(source.windowLocation?.origin) ??
    DEFAULT_NODE_API_BASE
  );
}

export function resolveControlRoomWebSocketUrl(
  apiBaseUrl: string,
  path: string,
  fallbackOrigin?: string,
): string | null {
  const normalizedBase = normalizeApiBase(apiBaseUrl);
  const origin =
    fallbackOrigin ??
    (typeof window !== "undefined" ? window.location.origin : DEFAULT_NODE_API_BASE);

  if (!normalizedBase) {
    return null;
  }

  try {
    const pathSuffix = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${normalizedBase}${pathSuffix}`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch {
    return null;
  }
}
