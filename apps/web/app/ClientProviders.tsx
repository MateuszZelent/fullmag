"use client";

/**
 * Client-side providers wrapper.
 *
 * Wraps children with the ResourceApiProvider using the same runtime API base
 * resolution as the resource hooks and singleton LiveSessionClient.
 */

import type { ReactNode } from "react";
import { resolveApiBase } from "@/lib/apiBase";
import { ResourceApiProvider } from "../src/providers/ResourceApiProvider";

export function ClientProviders({ children }: { children: ReactNode }) {
  const baseUrl = resolveApiBase();

  return (
    <ResourceApiProvider baseUrl={baseUrl}>{children}</ResourceApiProvider>
  );
}
