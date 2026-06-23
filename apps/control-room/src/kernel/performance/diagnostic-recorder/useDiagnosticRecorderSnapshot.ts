"use client";

import { useSyncExternalStore } from "react";

import type {
  DiagnosticRecorderController,
  DiagnosticRecorderSnapshot,
} from "./DiagnosticRecorderController";

export function useDiagnosticRecorderSnapshot(
  recorder: DiagnosticRecorderController,
): DiagnosticRecorderSnapshot {
  return useSyncExternalStore(
    (onStoreChange) => recorder.subscribe(onStoreChange),
    () => recorder.getSnapshot(),
    () => recorder.getSnapshot(),
  );
}
