"use client";

import { useEffect, type ReactNode } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import type { ResourceResult } from "../resources/resourceTypes";
import { useSessionStatus } from "../resources/useSessionStatus";

interface SimulationStartupOverlayVisibleState {
  detail: string;
  isVisible: true;
  title: string;
}

interface SimulationStartupOverlayHiddenState {
  isVisible: false;
}

export type SimulationStartupOverlayState =
  | SimulationStartupOverlayHiddenState
  | SimulationStartupOverlayVisibleState;

export const SIMULATION_STARTUP_STATUS_REFRESH_MS = 1_000;

const BOOTSTRAPPING_STATUSES = new Set(["bootstrapping"]);
const MATERIALIZING_STATUSES = new Set(["materializing_script"]);

export function resolveSimulationStartupOverlayState(
  status: ResourceResult<LiveStatusResource>,
): SimulationStartupOverlayState {
  if (status.status === "loading" || status.status === "idle") {
    return {
      detail: "Connecting to the local simulation backend.",
      isVisible: true,
      title: "Preparing simulation",
    };
  }

  if (status.status === "error") {
    if (!status.data && isTransientStartupError(status.error)) {
      return {
        detail: "Waiting for the runtime workspace to become available.",
        isVisible: true,
        title: "Preparing simulation",
      };
    }
    return { isVisible: false };
  }

  const solverState = status.data?.solver.state?.toLowerCase();
  const statuses = [solverState].filter(
    (value): value is string => Boolean(value),
  );

  if (statuses.some((value) => MATERIALIZING_STATUSES.has(value))) {
    return {
      detail: "Compiling the model and preparing runtime data.",
      isVisible: true,
      title: "Compiling simulation",
    };
  }

  if (statuses.some((value) => BOOTSTRAPPING_STATUSES.has(value))) {
    return {
      detail: "Starting the runtime workspace.",
      isVisible: true,
      title: "Preparing simulation",
    };
  }

  return { isVisible: false };
}

function isTransientStartupError(error: Error | null): boolean {
  const message = error?.message.toLowerCase() ?? "";
  return (
    message.includes("no active local live workspace") ||
    message.includes("no active workspace") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("connection refused")
  );
}

export function SimulationStartupOverlayView({
  state,
}: {
  state: SimulationStartupOverlayState;
}) {
  if (!state.isVisible) return null;

  return (
    <div className="fm-simulation-startup" aria-live="polite">
      <section
        aria-labelledby="fm-simulation-startup-title"
        className="fm-simulation-startup__panel"
        role="status"
      >
        <div className="fm-simulation-startup__spinner" aria-hidden="true" />
        <div className="fm-simulation-startup__copy">
          <h2
            className="fm-simulation-startup__title"
            id="fm-simulation-startup-title"
          >
            {state.title}
          </h2>
          <p className="fm-simulation-startup__detail">{state.detail}</p>
        </div>
      </section>
    </div>
  );
}

export function shouldRefreshSimulationStartupStatus(
  state: SimulationStartupOverlayState,
): boolean {
  return state.isVisible;
}

export function useSimulationStartupOverlayState(): SimulationStartupOverlayState {
  const sessionStatus = useSessionStatus();
  const state = resolveSimulationStartupOverlayState(sessionStatus);
  const shouldRefresh = shouldRefreshSimulationStartupStatus(state);

  useEffect(() => {
    if (!shouldRefresh) {
      return;
    }

    const intervalId = window.setInterval(
      sessionStatus.refetch,
      SIMULATION_STARTUP_STATUS_REFRESH_MS,
    );
    return () => window.clearInterval(intervalId);
  }, [sessionStatus.refetch, shouldRefresh]);

  return state;
}

export function WorkspaceStartupGateView({
  children,
  state,
}: {
  children: ReactNode;
  state: SimulationStartupOverlayState;
}) {
  if (state.isVisible) {
    return <SimulationStartupOverlayView state={state} />;
  }

  return (
    <>
      {children}
      <SimulationStartupOverlayView state={state} />
    </>
  );
}

export function SimulationStartupOverlay() {
  return (
    <SimulationStartupOverlayView state={useSimulationStartupOverlayState()} />
  );
}
