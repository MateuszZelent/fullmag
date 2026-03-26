"use client";

const DEFAULT_API_BASE = "http://localhost:8080";

function normalizeHostname(hostname: string): string {
  if (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) {
    return "localhost";
  }
  return hostname || "localhost";
}

export function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (typeof window === "undefined") {
    return DEFAULT_API_BASE;
  }

  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = normalizeHostname(window.location.hostname);
  return `${protocol}//${hostname}:8080`;
}

export function resolveApiWsBase(): string {
  const apiBase = resolveApiBase();
  if (apiBase.startsWith("https://")) {
    return `wss://${apiBase.slice("https://".length)}`;
  }
  if (apiBase.startsWith("http://")) {
    return `ws://${apiBase.slice("http://".length)}`;
  }
  return apiBase;
}
