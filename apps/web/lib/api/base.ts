/**
 * Centralized runtime base URL resolver.
 *
 * Priority:
 *   1. NEXT_PUBLIC_RUNTIME_HTTP_BASE env var (set at build time or injected by the dev-server)
 *   2. NEXT_PUBLIC_API_URL env var (legacy compatibility alias)
 *   3. window.location origin — works for same-origin deployments (the common case behind
 *      dev-server.mjs reverse proxy and typical Docker/Nginx setups)
 *   4. Safe browser-agnostic relative fallback (`"/"`) for build-time/runtime usage.
 */

const DEFAULT_FALLBACK_RUNTIME_BASE = "/";
const RUNTIME_HTTP_BASE_ENV_KEYS: string[] = [
  "NEXT_PUBLIC_RUNTIME_HTTP_BASE",
  "NEXT_PUBLIC_API_URL",
];

function configuredRuntimeBaseFromEnv(): string | null {
  if (typeof window !== "undefined") {
    return null;
  }

  const env = typeof process !== "undefined" ? process.env : undefined;
  for (const key of RUNTIME_HTTP_BASE_ENV_KEYS) {
    const value = env?.[key as keyof typeof env];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed.replace(/\/+$/, "");
    }
  }
  return null;
}

export function resolveRuntimeHttpBase(): string {
  const configured = configuredRuntimeBaseFromEnv();
  if (configured) {
    return configured;
  }

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  return DEFAULT_FALLBACK_RUNTIME_BASE;
}

/** Build URL for the current live session. */
export function currentLiveUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${resolveRuntimeHttpBase()}/v1/live/current${p}`;
}

/** Build URL for a specific session by ID. */
export function sessionUrl(sessionId: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${resolveRuntimeHttpBase()}/v1/sessions/${sessionId}${p}`;
}
