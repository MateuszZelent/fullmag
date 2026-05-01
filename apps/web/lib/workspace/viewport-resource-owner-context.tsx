"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import {
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
  return (
    <ViewportResourceOwnerContext.Provider value={owner}>
      {children}
    </ViewportResourceOwnerContext.Provider>
  );
}

export function useViewportResourceOwner(): ViewportResourceOwner | null {
  return useContext(ViewportResourceOwnerContext);
}
