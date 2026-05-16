/**
 * useBuilderAutoSync
 *
 * Kept as a lightweight lifecycle helper for hydration/sync metadata.
 * The hidden auto-push effect was intentionally removed:
 * scene draft synchronization is now explicit (manual/script sync actions only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useBuilderAutoSync() {
  const builderHydratedSessionRef = useRef<string | null>(null);
  const builderPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const builderAutoPushGateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const builderAutoPushGateUntilRef = useRef(0);
  const lastBuilderPushSignatureRef = useRef<string | null>(null);
  const [builderAutoPushGateVersion, setBuilderAutoPushGateVersion] = useState(0);

  /* ── Cleanup on unmount ── */
  useEffect(() => {
    return () => {
      if (builderPushTimerRef.current) {
        clearTimeout(builderPushTimerRef.current);
      }
      if (builderAutoPushGateTimerRef.current) {
        clearTimeout(builderAutoPushGateTimerRef.current);
      }
    };
  }, []);

  const isHydrated = useCallback((key: string) => {
      return builderHydratedSessionRef.current === key;
  }, []);

  const markHydrated = useCallback((key: string) => {
      builderHydratedSessionRef.current = key;
  }, []);

  const gateAutoSync = useCallback((ms: number) => {
      builderAutoPushGateUntilRef.current = Date.now() + ms;
  }, []);

  const resetAutoSync = useCallback(() => {
      builderHydratedSessionRef.current = null;
      lastBuilderPushSignatureRef.current = null;
      if (builderPushTimerRef.current) {
        clearTimeout(builderPushTimerRef.current);
        builderPushTimerRef.current = null;
      }
      if (builderAutoPushGateTimerRef.current) {
        clearTimeout(builderAutoPushGateTimerRef.current);
        builderAutoPushGateTimerRef.current = null;
      }
      builderAutoPushGateUntilRef.current = 0;
  }, []);

  const cancelPendingPush = useCallback(() => {
      if (builderPushTimerRef.current) {
        clearTimeout(builderPushTimerRef.current);
        builderPushTimerRef.current = null;
      }
  }, []);

  const recordPushSignature = useCallback((signature: string | null) => {
      lastBuilderPushSignatureRef.current = signature;
  }, []);

  const bumpGateVersion = useCallback(() => {
      setBuilderAutoPushGateVersion((v) => v + 1);
  }, []);

  return useMemo(
    () => ({
      /** Check if a given session key has already been hydrated. */
      isHydrated,
      /** Mark a session as hydrated — auto-push will not fire before this. */
      markHydrated,
      /** Gate auto-push for `ms` to avoid pushing during initial hydration. */
      gateAutoSync,
      /** Full reset — call when workspaceHydrationKey changes. */
      resetAutoSync,
      /** Cancel the current in-flight debounce timer (used before explicit sync). */
      cancelPendingPush,
      /** After a successful explicit push, record the signature to avoid re-push. */
      recordPushSignature,
      /** Bump gate version to unblock a gated push after manual write. */
      bumpGateVersion,
      builderAutoPushGateVersion,
    }),
    [
      builderAutoPushGateVersion,
      bumpGateVersion,
      cancelPendingPush,
      gateAutoSync,
      isHydrated,
      markHydrated,
      recordPushSignature,
      resetAutoSync,
    ],
  );
}
