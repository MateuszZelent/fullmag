"use client";

import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/shared/ui/Button";
import { Progress } from "@/shared/ui/Progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";

import type { LiveStatusResource } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { statusRefreshIntervalMs } from "../realtime/communicationPolicy";
import { useRealtimeConnection } from "../realtime/useRealtimeConnection";
import type { ResourceResult } from "../resources/resourceTypes";
import { useSessionStatusSelector } from "../resources/useSessionStatus";
import { useSimulationPreparation } from "../resources/useSimulationPreparation";
import type { KernelApi } from "../types";
import { SimulationPreparationLog } from "./SimulationPreparationLog";
import { SlotHost } from "./SlotHost";
import {
  resolveSimulationPreparationViewModel,
  serializeSimulationPreparationDiagnostics,
  type SimulationPreparationStageView,
  type SimulationPreparationViewModel,
} from "./simulationPreparationModel";
import { useLayoutSelector } from "./useLayout";

export type SimulationStartupOverlayState = SimulationPreparationViewModel;

interface SimulationStartupOverlayOptions {
  readonly allowMissingSessionSmoke?: boolean;
}

interface BrowserFullmagConfig {
  readonly allowMissingSessionSmoke?: unknown;
}

interface SimulationStartupOverlayResourceState {
  readonly refetch: () => void;
  readonly state: SimulationStartupOverlayState;
  readonly status: ResourceResult<LiveStatusResource>;
}

const EMPTY_PREPARATION_RESOURCE = {
  data: null,
  error: null,
  refetch: () => undefined,
  revision: null,
  status: "idle",
} satisfies ResourceResult<never>;

export function resolveSimulationStartupOverlayState(
  status: ResourceResult<LiveStatusResource>,
  options: SimulationStartupOverlayOptions = {},
): SimulationStartupOverlayState {
  const state = resolveSimulationPreparationViewModel(
    EMPTY_PREPARATION_RESOURCE,
    status,
    null,
  );
  return options.allowMissingSessionSmoke ? hideStartupOverlay(state) : state;
}

function hideStartupOverlay(
  state: SimulationStartupOverlayState,
): SimulationStartupOverlayState {
  return {
    ...state,
    isVisible: false,
    kind: "hidden",
  };
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

  const progressValue =
    state.progress.kind === "determinate" ? state.progress.value : undefined;

  return (
    <div className="fm-simulation-startup" data-state={state.kind}>
      <section
        aria-labelledby="fm-simulation-startup-title"
        className="fm-simulation-startup__panel"
      >
        <header className="fm-simulation-startup__header">
          <div className="fm-simulation-startup__heading-row">
            <div className="fm-simulation-startup__heading-copy">
              <p className="fm-simulation-startup__eyebrow">{state.eyebrow}</p>
              <h2
                className="fm-simulation-startup__title"
                id="fm-simulation-startup-title"
              >
                {state.title}
              </h2>
              <p className="fm-simulation-startup__detail">{state.detail}</p>
              {state.failure?.correlationId ? (
                <p className="fm-simulation-startup__detail">
                  Diagnostic ID: <code>{state.failure.correlationId}</code>
                </p>
              ) : null}
            </div>
            {state.totalElapsedLabel ? (
              <div className="fm-simulation-startup__elapsed">
                <span>Total elapsed</span>
                <strong>{state.totalElapsedLabel}</strong>
              </div>
            ) : null}
          </div>

          {state.reconnectingTitle ? (
            <div className="fm-simulation-startup__reconnecting">
              <strong>{state.reconnectingTitle}</strong>
              <span>{state.reconnectingMessage}</span>
            </div>
          ) : null}

          {state.requestedExecutionLabel || state.resolvedExecutionLabel ? (
            <dl className="fm-simulation-startup__execution">
              {state.requestedExecutionLabel ? (
                <div>
                  <dt>Requested</dt>
                  <dd>{state.requestedExecutionLabel}</dd>
                </div>
              ) : null}
              {state.resolvedExecutionLabel ? (
                <div>
                  <dt>Resolved</dt>
                  <dd>{state.resolvedExecutionLabel}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          <div
            aria-live="polite"
            className="fm-visually-hidden"
            role="status"
          >
            {state.liveSummary}
          </div>

          <div className="fm-simulation-startup__progress-row">
            <Progress
              aria-label="Simulation preparation progress"
              aria-valuenow={progressValue}
              aria-valuetext={resolveProgressValueText(state)}
              className="fm-simulation-startup__progress"
              data-kind={state.progress.kind}
              value={progressValue}
            />
            <span className="fm-simulation-startup__progress-label">
              {state.progress.kind === "determinate"
                ? `${state.progress.value}%`
                : state.progress.kind === "terminal"
                  ? "Failed"
                  : state.activeStage?.stateLabel ?? "Connecting"}
            </span>
          </div>
          {state.progressLabel ? (
            <p className="fm-simulation-startup__progress-detail">
              {state.progressLabel}
            </p>
          ) : null}
        </header>

        <div className="fm-simulation-startup__body">
          <PreparationStageList stages={state.stages} />
          <SimulationPreparationLog entries={state.logEntries} />
        </div>

        <footer className="fm-simulation-startup__footer">
          <p>
            The workspace opens after solver initialization completes.
          </p>
          {(state.failure && state.preparation) || state.kind === "resource-error" ? (
            <SimulationPreparationFailureActions
              snapshot={state.preparation}
            />
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function PreparationStageList({
  stages,
}: {
  stages: readonly SimulationPreparationStageView[];
}) {
  return (
    <section
      aria-labelledby="fm-simulation-preparation-stages-title"
      className="fm-simulation-startup__timeline"
    >
      <div className="fm-simulation-startup__section-header">
        <h3 id="fm-simulation-preparation-stages-title">Preparation stages</h3>
      </div>
      {stages.length > 0 ? (
        <TooltipProvider delayDuration={300}>
          <ol
            aria-label="Ordered simulation preparation stages"
            className="fm-simulation-startup__stages"
          >
            {stages.map((stage) => (
              <li data-status={stage.status} key={stage.id}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      aria-label={`${stage.stateLabel} stage status`}
                      className="fm-simulation-startup__stage-marker"
                      role="img"
                    >
                      {stageStatusGlyph(stage.status)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{stage.stateLabel}</TooltipContent>
                </Tooltip>
                <div className="fm-simulation-startup__stage-copy">
                  <div className="fm-simulation-startup__stage-title-row">
                    <span className="fm-simulation-startup__stage-title">
                      {stage.label}
                    </span>
                    <time>{stage.elapsedLabel}</time>
                  </div>
                  <span className="fm-simulation-startup__stage-state">
                    {stage.stateLabel}
                  </span>
                  {stage.isActive && stage.detail ? (
                    <span className="fm-simulation-startup__stage-detail">
                      {stage.detail}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </TooltipProvider>
      ) : (
        <p className="fm-simulation-startup__empty-stages">
          Waiting for the backend stage projection.
        </p>
      )}
    </section>
  );
}

function stageStatusGlyph(
  status: SimulationPreparationStageView["status"],
): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "skipped":
      return "−";
    case "active":
      return "●";
    default:
      return "·";
  }
}

function resolveProgressValueText(
  state: SimulationStartupOverlayState,
): string {
  if (state.kind === "resource-error") {
    return "Simulation preparation status unavailable";
  }
  if (state.progress.kind === "terminal") {
    return "Simulation preparation failed";
  }
  if (state.progress.kind === "determinate") {
    return state.progressLabel
      ? `${state.progress.value} percent, ${state.progressLabel}`
      : `${state.progress.value} percent`;
  }
  return state.activeStage
    ? `${state.activeStage.label} in progress`
    : "Connecting to the simulation backend";
}

type SimulationPreparationDiagnosticsNavigation = {
  readonly bus: {
    emit: (
      event: "footer:tab-requested",
      payload: { reason?: string; tab: "diagnostics" },
    ) => void;
  };
  readonly layout: Pick<KernelApi["layout"], "openBottomPanel">;
};

export function openSimulationPreparationDiagnostics(
  kernel: SimulationPreparationDiagnosticsNavigation,
): void {
  kernel.layout.openBottomPanel("diagnostics");
  kernel.bus.emit("footer:tab-requested", {
    reason: "simulation-preparation",
    tab: "diagnostics",
  });
}

function SimulationPreparationFailureActions({
  snapshot,
}: {
  snapshot: SimulationStartupOverlayState["preparation"];
}) {
  const kernel = useKernel();
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle">(
    "idle",
  );

  const copyDiagnostics = async () => {
    if (!snapshot) return;

    try {
      await navigator.clipboard.writeText(
        serializeSimulationPreparationDiagnostics(snapshot),
      );
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="fm-simulation-startup__actions">
      {snapshot ? (
        <Button onClick={copyDiagnostics} size="sm" type="button">
          {copyState === "copied"
            ? "Diagnostics copied"
            : copyState === "failed"
              ? "Copy failed"
              : "Copy diagnostics"}
        </Button>
      ) : null}
      <Button
        onClick={() => openSimulationPreparationDiagnostics(kernel)}
        size="sm"
        type="button"
        variant="primary"
      >
        Open full diagnostics
      </Button>
    </div>
  );
}

export function shouldRefreshSimulationStartupStatus(
  state: SimulationStartupOverlayState,
): boolean {
  return state.isVisible && (state.kind === "stale" || !state.isTerminal);
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
    status,
  };
}

export function simulationStartupOverlayResourceStateEquals(
  previous: SimulationStartupOverlayResourceState,
  next: SimulationStartupOverlayResourceState,
): boolean {
  return (
    Object.is(previous.refetch, next.refetch) &&
    previous.status.status === next.status.status &&
    previous.status.error === next.status.error &&
    previous.status.revision === next.status.revision &&
    previous.status.data?.solver.state === next.status.data?.solver.state &&
    previous.status.data?.resources.simulation_preparation_revision ===
      next.status.data?.resources.simulation_preparation_revision
  );
}

export function useSimulationStartupOverlayVisibility(): boolean {
  const startupResource = useSessionStatusSelector(
    selectSimulationStartupOverlayResourceState,
    { isEqual: simulationStartupOverlayResourceStateEquals },
  );
  const preparation = useSimulationPreparation({
    requiredRevision:
      startupResource.status.data?.resources
        .simulation_preparation_revision ?? null,
  });
  const realtimeConnection = useRealtimeConnection();
  const allowMissingSessionSmoke = useAllowMissingSessionSmoke();
  const state = resolveSimulationPreparationViewModel(
    preparationDuringRealtimeDisruption(
      preparation,
      realtimeConnection.disrupted,
    ),
    startupResource.status,
    null,
  );
  return allowMissingSessionSmoke ? false : state.isVisible;
}

export function useSimulationStartupOverlayState(): SimulationStartupOverlayState {
  const startupResource = useSessionStatusSelector(
    selectSimulationStartupOverlayResourceState,
    { isEqual: simulationStartupOverlayResourceStateEquals },
  );
  const preparation = useSimulationPreparation({
    requiredRevision:
      startupResource.status.data?.resources
        .simulation_preparation_revision ?? null,
  });
  const realtimeConnection = useRealtimeConnection();
  const allowMissingSessionSmoke = useAllowMissingSessionSmoke();
  const untimedState = resolveSimulationPreparationViewModel(
    preparationDuringRealtimeDisruption(
      preparation,
      realtimeConnection.disrupted,
    ),
    startupResource.status,
    null,
  );
  const [displayNow, setDisplayNow] = useState<number | null>(null);
  const shouldTick = untimedState.isVisible && !untimedState.isTerminal;

  useEffect(() => {
    if (!shouldTick) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        setDisplayNow(Date.now());
        tick();
      }, 1_000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [shouldTick]);

  const state = resolveSimulationPreparationViewModel(
    preparationDuringRealtimeDisruption(
      preparation,
      realtimeConnection.disrupted,
    ),
    startupResource.status,
    displayNow,
  );
  const visibleState = allowMissingSessionSmoke ? hideStartupOverlay(state) : state;
  const startupRefetch = startupResource.refetch;
  const shouldRefresh = shouldRefreshSimulationStartupStatus(visibleState);

  useEffect(() => {
    if (!shouldRefresh) return;

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
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [startupRefetch, shouldRefresh]);

  return visibleState;
}

function preparationDuringRealtimeDisruption(
  preparation: ReturnType<typeof useSimulationPreparation>,
  disrupted: boolean,
): ReturnType<typeof useSimulationPreparation> {
  if (!disrupted || !preparation.data || preparation.status !== "ready") {
    return preparation;
  }

  return { ...preparation, status: "stale" };
}

export function WorkspaceStartupGateView({
  children,
  state,
}: {
  children: ReactNode;
  state: SimulationStartupOverlayState;
}) {
  if (state.isVisible) {
    return (
      <>
        <SimulationStartupOverlayView state={state} />
        <SimulationStartupDiagnosticsDock />
      </>
    );
  }

  return (
    <>
      {children}
      <SimulationStartupOverlayView state={state} />
    </>
  );
}

function SimulationStartupDiagnosticsDock() {
  const isVisible = useLayoutSelector(
    (layout) =>
      layout.panelVisible.bottom &&
      layout.focusedSlot === "panel-bottom" &&
      layout.activeBottomPanelTab === "diagnostics",
  );

  return (
    <aside
      aria-hidden={!isVisible}
      className="fm-simulation-startup__diagnostics-dock"
      hidden={!isVisible}
    >
      {isVisible ? <SlotHost slotId="panel-bottom" /> : null}
    </aside>
  );
}

export function SimulationStartupOverlay() {
  return (
    <SimulationStartupOverlayView state={useSimulationStartupOverlayState()} />
  );
}
