"use client";

import { useSyncExternalStore } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

const subscribe = () => () => undefined;
const getServerSnapshot = () => null;

/** The desktop bridge is injected before client startup and stays stable. */
export function useDesktopInvoke() {
  return useSyncExternalStore(subscribe, tauriInvoke, getServerSnapshot);
}
