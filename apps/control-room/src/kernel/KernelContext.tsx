"use client";

import { createContext, useContext } from "react";

import type { KernelApi } from "./types";

export const KernelContext = createContext<KernelApi | null>(null);

export function useKernel(): KernelApi {
  const kernel = useContext(KernelContext);
  if (!kernel) {
    throw new Error("useKernel must be used within KernelProvider.");
  }
  return kernel;
}
