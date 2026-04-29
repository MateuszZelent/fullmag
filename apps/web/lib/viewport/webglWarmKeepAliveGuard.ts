"use client";

import { useSyncExternalStore } from "react";

let disabledByContextLoss = false;
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

export function disableWebGLWarmKeepAliveForSession(): void {
  if (disabledByContextLoss) {
    return;
  }
  disabledByContextLoss = true;
  emitChange();
}

export function isWebGLWarmKeepAliveDisabledForSession(): boolean {
  return disabledByContextLoss;
}

export function subscribeWebGLWarmKeepAliveGuard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWebGLWarmKeepAliveDisabledForSession(): boolean {
  return useSyncExternalStore(
    subscribeWebGLWarmKeepAliveGuard,
    isWebGLWarmKeepAliveDisabledForSession,
    () => false,
  );
}

export function resetWebGLWarmKeepAliveGuardForTests(): void {
  disabledByContextLoss = false;
  emitChange();
}
