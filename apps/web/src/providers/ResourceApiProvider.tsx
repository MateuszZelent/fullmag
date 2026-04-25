"use client";

/**
 * React context provider for the resource-first LiveSessionClient.
 *
 * Wraps the component tree with a singleton client instance keyed
 * by baseUrl. Components below this provider can call useResourceApi()
 * to access the client without prop drilling.
 */

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import {
  LiveSessionClient,
  initLiveSessionClient,
} from "../api/client/LiveSessionClient";

const ResourceApiContext = createContext<LiveSessionClient | null>(null);

interface ResourceApiProviderProps {
  baseUrl: string;
  children: ReactNode;
}

export function ResourceApiProvider({
  baseUrl,
  children,
}: ResourceApiProviderProps) {
  const client = useMemo(() => initLiveSessionClient({ baseUrl }), [baseUrl]);

  return (
    <ResourceApiContext.Provider value={client}>
      {children}
    </ResourceApiContext.Provider>
  );
}

/**
 * Access the LiveSessionClient from context.
 * Must be rendered below a <ResourceApiProvider>.
 */
export function useResourceApi(): LiveSessionClient {
  const client = useContext(ResourceApiContext);
  if (!client) {
    throw new Error(
      "useResourceApi must be used within a <ResourceApiProvider>",
    );
  }
  return client;
}
