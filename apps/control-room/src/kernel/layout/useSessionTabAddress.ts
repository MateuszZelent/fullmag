"use client";

import { useSyncExternalStore } from "react";

import { parseTabRoute } from "./tabRoutes";
import { subscribeTabRouteAddress } from "./tabRouteAddressStore";

function readSessionTabAddress() {
  const { pathname, search } = window.location;
  return parseTabRoute(pathname ?? "", search).kind === "session";
}

/** The prerendered shell serves every tab address, so its address is unknown. */
export function useSessionTabAddress(): boolean | null {
  return useSyncExternalStore<boolean | null>(
    subscribeTabRouteAddress,
    readSessionTabAddress,
    () => null,
  );
}
