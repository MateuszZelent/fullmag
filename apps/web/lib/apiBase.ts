"use client";

const DEFAULT_FALLBACK_RUNTIME_BASE = "/";
const RUNTIME_HTTP_BASE_ENV_KEYS: string[] = [
  "NEXT_PUBLIC_RUNTIME_HTTP_BASE",
  "NEXT_PUBLIC_API_URL",
];

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
    const value = env[key];
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

function resolveRuntimeHttpBase(): string {
  const configured = configuredRuntimeBaseFromEnv();
  if (configured) {
    return configured;
  }

  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return DEFAULT_FALLBACK_RUNTIME_BASE;
}

export function resolveApiBase(): string {
  return resolveRuntimeHttpBase();
}
