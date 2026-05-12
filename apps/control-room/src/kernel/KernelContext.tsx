"use client";

import { createContext, use } from "react";

import type { KernelApi } from "./types";

export const KernelContext = createContext<KernelApi | null>(null);

export function useKernel(): KernelApi {
  const kernel = use(KernelContext);
  if (!kernel) {
    throw new Error("useKernel must be used within KernelProvider.");
  }
  return kernel;
}
