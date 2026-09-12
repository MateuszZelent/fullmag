"use client";

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";

import { incrementFrontendAuditCounter } from "@/lib/debug/frontendAudit";
import {
  disposeViewportResourceOwner,
  getViewportResourceOwner,
  type ViewportResourceOwner,
} from "@/lib/workspace/viewport-resource-owner";

const ViewportResourceOwnerContext = createContext<ViewportResourceOwner | null>(null);

export function ViewportResourceOwnerProvider({
  ownerId,
  children,
}: {
  ownerId: string;
  children: ReactNode;
}) {
  const owner = useMemo(() => getViewportResourceOwner(ownerId), [ownerId]);
  useEffect(() => {
    incrementFrontendAuditCounter("viewportResourceOwnerMounted", 1);
    return () => {
      incrementFrontendAuditCounter("viewportResourceOwnerUnmounted", 1);
      disposeViewportResourceOwner(ownerId, "provider-unmount");
    };
  }, [ownerId]);
  return (
    <ViewportResourceOwnerContext.Provider value={owner}>
      {children}
    </ViewportResourceOwnerContext.Provider>
  );
}

export function useViewportResourceOwner(): ViewportResourceOwner | null {
  return useContext(ViewportResourceOwnerContext);
}
