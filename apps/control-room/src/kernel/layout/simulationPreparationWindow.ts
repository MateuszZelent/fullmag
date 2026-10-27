import { useSyncExternalStore } from "react";

/**
 * Presentation state of the simulation preparation window, shared between the
 * window itself and the status bar entry that reopens it. The preparation keeps
 * running regardless of this state; only the window's visibility lives here.
 */
export type SimulationPreparationWindowMode = "open" | "minimized" | "closed";

export interface SimulationPreparationWindowSummary {
  /** Identity of the preparation shown by the window. */
  readonly preparationId: string;
  readonly label: string;
  readonly title: string;
  readonly tone: "failed" | "ready" | "running";
}

export interface SimulationPreparationWindowSnapshot {
  /** Mode chosen for `summary.preparationId`; null until anyone chose one. */
  readonly mode: SimulationPreparationWindowMode | null;
  readonly modePreparationId: string | null;
  readonly summary: SimulationPreparationWindowSummary | null;
}

type Listener = () => void;

const EMPTY_SNAPSHOT: SimulationPreparationWindowSnapshot = {
  mode: null,
  modePreparationId: null,
  summary: null,
};

const listeners = new Set<Listener>();
let snapshot = EMPTY_SNAPSHOT;

function publish(next: SimulationPreparationWindowSnapshot): void {
  if (
    next.mode === snapshot.mode &&
    next.modePreparationId === snapshot.modePreparationId &&
    summariesEqual(next.summary, snapshot.summary)
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function summariesEqual(
  previous: SimulationPreparationWindowSummary | null,
  next: SimulationPreparationWindowSummary | null,
): boolean {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.preparationId === next.preparationId &&
      previous.label === next.label &&
      previous.title === next.title &&
      previous.tone === next.tone)
  );
}

export const simulationPreparationWindow = {
  getSnapshot: (): SimulationPreparationWindowSnapshot => snapshot,
  setMode: (
    preparationId: string,
    mode: SimulationPreparationWindowMode,
  ): void => publish({ ...snapshot, mode, modePreparationId: preparationId }),
  /** Reopens the window of the current preparation, e.g. from the status bar. */
  open: (): void => {
    if (!snapshot.summary) return;
    publish({
      ...snapshot,
      mode: "open",
      modePreparationId: snapshot.summary.preparationId,
    });
  },
  setSummary: (summary: SimulationPreparationWindowSummary | null): void =>
    publish({ ...snapshot, summary }),
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  resetForTests: (): void => {
    snapshot = EMPTY_SNAPSHOT;
    listeners.clear();
  },
};

export function useSimulationPreparationWindow(): SimulationPreparationWindowSnapshot {
  return useSyncExternalStore(
    simulationPreparationWindow.subscribe,
    simulationPreparationWindow.getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
}

/** The mode stored for `preparationId`, or null when none was chosen for it. */
export function storedPreparationWindowMode(
  state: SimulationPreparationWindowSnapshot,
  preparationId: string,
): SimulationPreparationWindowMode | null {
  return state.modePreparationId === preparationId ? state.mode : null;
}
