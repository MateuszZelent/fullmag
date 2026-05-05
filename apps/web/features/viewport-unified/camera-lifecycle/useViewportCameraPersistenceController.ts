import { useCallback, useEffect, useMemo, useRef } from "react";

export const DEFAULT_CAMERA_PERSIST_IDLE_MS = 750;

export interface ViewportCameraPersistenceController {
  flush: () => void;
  schedule: () => void;
  setInteractionActive: (active: boolean) => void;
  handleInteractionStart: () => void;
  handleInteractionEnd: () => void;
}

export function useViewportCameraPersistenceController(
  persistCameraState: () => void,
  idleMs = DEFAULT_CAMERA_PERSIST_IDLE_MS,
): ViewportCameraPersistenceController {
  const persistCameraStateRef = useRef(persistCameraState);
  useEffect(() => {
    persistCameraStateRef.current = persistCameraState;
  }, [persistCameraState]);

  const interactionActiveRef = useRef(false);
  const pendingPersistRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) {
      return;
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    if (!pendingPersistRef.current) {
      return;
    }
    pendingPersistRef.current = false;
    persistCameraStateRef.current();
  }, [clearTimer]);

  const scheduleIdleFlush = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(flush, idleMs);
  }, [clearTimer, flush, idleMs]);

  const schedule = useCallback(() => {
    pendingPersistRef.current = true;
    clearTimer();
    if (interactionActiveRef.current) {
      return;
    }
    scheduleIdleFlush();
  }, [clearTimer, scheduleIdleFlush]);

  const setInteractionActive = useCallback((active: boolean) => {
    interactionActiveRef.current = active;
    if (active) {
      clearTimer();
      return;
    }
    if (pendingPersistRef.current) {
      scheduleIdleFlush();
    }
  }, [clearTimer, scheduleIdleFlush]);

  const handleInteractionStart = useCallback(() => {
    setInteractionActive(true);
  }, [setInteractionActive]);

  const handleInteractionEnd = useCallback(() => {
    setInteractionActive(false);
  }, [setInteractionActive]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  return useMemo(
    () => ({
      flush,
      schedule,
      setInteractionActive,
      handleInteractionStart,
      handleInteractionEnd,
    }),
    [flush, handleInteractionEnd, handleInteractionStart, schedule, setInteractionActive],
  );
}
