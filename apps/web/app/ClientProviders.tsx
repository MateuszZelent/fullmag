"use client";

/**
 * Client-side providers wrapper.
 *
 * Wraps children with the ResourceApiProvider (which requires a browser
 * environment to resolve `window.location.origin` for the API base URL).
 * This component is "use client" so it can safely access `window`.
 */

import type { ReactNode } from "react";
import { ResourceApiProvider } from "../src/providers/ResourceApiProvider";

export function ClientProviders({ children }: { children: ReactNode }) {
  const baseUrl =
    typeof window !== "undefined" ? window.location.origin : "/";

  return (
    <ResourceApiProvider baseUrl={baseUrl}>{children}</ResourceApiProvider>
  );
}
