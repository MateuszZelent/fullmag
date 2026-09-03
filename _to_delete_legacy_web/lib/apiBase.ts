"use client";

const DEFAULT_FALLBACK_RUNTIME_BASE = "/";
const RUNTIME_HTTP_BASE_ENV_KEYS: string[] = [
  "NEXT_PUBLIC_RUNTIME_HTTP_BASE",
  "NEXT_PUBLIC_API_URL",
];

type BrowserFullmagConfig = {
  runtimeHttpBase?: unknown;
  apiBase?: unknown;
};

function normalizeRuntimeBase(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "");
}

function configuredRuntimeBaseFromEnv(): string | null {
  if (typeof window !== "undefined") {
    return null;
  }

  const rawEnv =
    typeof globalThis !== "undefined"
      ? (globalThis as { process?: { env?: unknown } }).process?.env
      : undefined;
  if (!rawEnv || typeof rawEnv !== "object") {
    return null;
  }

  const env = rawEnv as Record<string, unknown>;
  for (const key of RUNTIME_HTTP_BASE_ENV_KEYS) {
    const normalized = normalizeRuntimeBase(env[key]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function configuredRuntimeBaseFromWindow(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const config = (window as Window & { __FULLMAG_CONFIG__?: BrowserFullmagConfig })
    .__FULLMAG_CONFIG__;
  if (!config || typeof config !== "object") {
    return null;
  }

  return (
    normalizeRuntimeBase(config.runtimeHttpBase) ??
    normalizeRuntimeBase(config.apiBase)
  );
}

function resolveRuntimeHttpBase(): string {
  const configured = configuredRuntimeBaseFromEnv();
  if (configured) {
    return configured;
  }

  const runtimeConfigured = configuredRuntimeBaseFromWindow();
  if (runtimeConfigured) {
    return runtimeConfigured;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return DEFAULT_FALLBACK_RUNTIME_BASE;
}

export function resolveApiBase(): string {
  return resolveRuntimeHttpBase();
}
