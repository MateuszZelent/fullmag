"use client";

const DEFAULT_API_BASE = "http://localhost:3001";
const LOOPBACK_V4_RE = /^127(?:\.\d{1,3}){3}$/;

function normalizeHostname(hostname: string): string {
  if (
    LOOPBACK_V4_RE.test(hostname) ||
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
  const port = window.location.port ? `:${window.location.port}` : "";
  return `${protocol}//${hostname}${port}`;
}
