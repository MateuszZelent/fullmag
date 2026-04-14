/**
 * Centralized runtime base URL resolver.
 *
 * Priority:
 *   1. NEXT_PUBLIC_RUNTIME_HTTP_BASE env var (set at build time or injected by the dev-server)
 *   2. window.location origin — works for same-origin deployments (the common case behind
 *      dev-server.mjs reverse proxy and typical Docker/Nginx setups)
 *   3. Hard-coded fallback for build-time SSR / unit tests where `window` is not available.
 *      Uses port 3001 to match the canonical dev-server port from package.json.
 */
export function resolveRuntimeHttpBase(): string {
  const configured = (
    typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_RUNTIME_HTTP_BASE : undefined
  )?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  if (typeof window !== 'undefined') {
    return window.location.origin;
  }

  return 'http://localhost:3001';
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
