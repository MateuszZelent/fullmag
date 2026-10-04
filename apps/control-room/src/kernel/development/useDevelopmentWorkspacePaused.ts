"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useKernel } from "../KernelContext";

const noSubscription = () => () => {};
const activeServerSnapshot = () => false;
const noServerError = () => null;

export function useDevelopmentWorkspacePaused(): boolean {
  const host = useKernel().developmentWorkspace;
  const snapshot = useCallback(() => host?.getSnapshot().paused ?? false, [host]);
  return useSyncExternalStore(host?.subscribe ?? noSubscription, snapshot, activeServerSnapshot);
}

export function useDevelopmentWorkspacePublicationError(): string | null {
  const host = useKernel().developmentWorkspace;
  const snapshot = useCallback(() => host?.getSnapshot().publicationError ?? null, [host]);
  return useSyncExternalStore(host?.subscribe ?? noSubscription, snapshot, noServerError);
}
