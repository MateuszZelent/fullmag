"use client";

import { useEffect, useState, type ReactNode } from "react";

import type { LiveStatusResource } from "../api/apiTypes";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";
import type { ResourceResult } from "../resources/resourceTypes";
import { useSessionStatusSelector } from "../resources/useSessionStatus";

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

const BOOTSTRAPPING_STATUSES = new Set(["bootstrapping"]);
const MATERIALIZING_STATUSES = new Set(["materializing_script"]);

interface SimulationStartupOverlayOptions {
  readonly allowMissingSessionSmoke?: boolean;
}

interface BrowserFullmagConfig {
  readonly allowMissingSessionSmoke?: unknown;
}

interface SimulationStartupOverlayResourceState {
  readonly refetch: () => void;
  readonly state: SimulationStartupOverlayState;
}

export function resolveSimulationStartupOverlayState(
  status: ResourceResult<LiveStatusResource>,
  options: SimulationStartupOverlayOptions = {},
): SimulationStartupOverlayState {
  if (options.allowMissingSessionSmoke) {
    return { isVisible: false };
  }

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

function simulationStartupOverlayOptionsFromBrowser(): SimulationStartupOverlayOptions {
  if (typeof window === "undefined") {
    return {};
  }

  const config = (window as Window & { __FULLMAG_CONFIG__?: BrowserFullmagConfig })
    .__FULLMAG_CONFIG__;
  return {
    allowMissingSessionSmoke: config?.allowMissingSessionSmoke === true,
  };
}

function getSimulationStartupSmokeBypassSnapshot(): boolean {
  return (
    simulationStartupOverlayOptionsFromBrowser().allowMissingSessionSmoke === true
  );
}

function useAllowMissingSessionSmoke(): boolean {
  const [allowMissingSessionSmoke, setAllowMissingSessionSmoke] =
    useState(false);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setAllowMissingSessionSmoke(getSimulationStartupSmokeBypassSnapshot());
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  return allowMissingSessionSmoke;
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

export function selectSimulationStartupOverlayVisibility(
  status: ResourceResult<LiveStatusResource>,
): boolean {
  return resolveSimulationStartupOverlayState(status).isVisible;
}

export function selectSimulationStartupOverlayResourceState(
  status: ResourceResult<LiveStatusResource>,
): SimulationStartupOverlayResourceState {
  return {
    refetch: status.refetch,
    state: resolveSimulationStartupOverlayState(status),
  };
}

export function simulationStartupOverlayResourceStateEquals(
  previous: SimulationStartupOverlayResourceState,
  next: SimulationStartupOverlayResourceState,
): boolean {
  return (
    Object.is(previous.refetch, next.refetch) &&
    simulationStartupOverlayStateEquals(previous.state, next.state)
  );
}

function simulationStartupOverlayStateEquals(
  previous: SimulationStartupOverlayState,
  next: SimulationStartupOverlayState,
): boolean {
  if (previous.isVisible !== next.isVisible) return false;
  if (!previous.isVisible || !next.isVisible) return true;
  return previous.title === next.title && previous.detail === next.detail;
}

export function useSimulationStartupOverlayVisibility(): boolean {
  const isVisible = useSessionStatusSelector(selectSimulationStartupOverlayVisibility);
  const allowMissingSessionSmoke = useAllowMissingSessionSmoke();
  return allowMissingSessionSmoke ? false : isVisible;
}

export function useSimulationStartupOverlayState(): SimulationStartupOverlayState {
  const startupResource = useSessionStatusSelector(
    selectSimulationStartupOverlayResourceState,
    { isEqual: simulationStartupOverlayResourceStateEquals },
  );
  const allowMissingSessionSmoke = useAllowMissingSessionSmoke();
  const state: SimulationStartupOverlayState = allowMissingSessionSmoke
    ? { isVisible: false }
    : startupResource.state;
  const startupRefetch = startupResource.refetch;
  const shouldRefresh = shouldRefreshSimulationStartupStatus(state);

  useEffect(() => {
    if (!shouldRefresh) {
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      startupRefetch();
      timeoutId = setTimeout(tick, statusRefreshIntervalMs());
    };
    timeoutId = setTimeout(tick, statusRefreshIntervalMs());
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    };
  }, [startupRefetch, shouldRefresh]);

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
