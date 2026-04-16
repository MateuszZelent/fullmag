"use client";

import { resolveRuntimeHttpBase } from "./api/base";

export function resolveApiBase(): string {
  return resolveRuntimeHttpBase();
}
