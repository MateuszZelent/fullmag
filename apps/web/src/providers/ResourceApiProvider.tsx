"use client";

/**
 * React context provider for the resource-first LiveApiClient.
 *
 * Wraps the component tree with a singleton client instance keyed
 * by baseUrl. Components below this provider can call useResourceApi()
 * to access the client without prop drilling.
 */

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import {
  LiveApiClient,
  initLiveApiClient,
} from "../api/client/LiveApiClient";

const ResourceApiContext = createContext<LiveApiClient | null>(null);

interface ResourceApiProviderProps {
  baseUrl: string;
  children: ReactNode;
}

export function ResourceApiProvider({
  baseUrl,
  children,
}: ResourceApiProviderProps) {
  const client = useMemo(() => initLiveApiClient({ baseUrl }), [baseUrl]);

  return (
    <ResourceApiContext.Provider value={client}>
      {children}
    </ResourceApiContext.Provider>
  );
}

/**
 * Access the LiveApiClient from context.
 * Must be rendered below a <ResourceApiProvider>.
 */
export function useResourceApi(): LiveApiClient {
  const client = useContext(ResourceApiContext);
  if (!client) {
    throw new Error(
      "useResourceApi must be used within a <ResourceApiProvider>",
    );
  }
  return client;
}
