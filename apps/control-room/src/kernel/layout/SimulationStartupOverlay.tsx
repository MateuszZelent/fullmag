"use client";

import { useEffect, useRef, useState } from "react";
import { Minus, PanelTopOpen, X } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";
import { DraggablePanel } from "@/shared/ui/DraggablePanel";
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
import { SimulationPreparationFailureDialog } from "./SimulationPreparationFailureDialog";
import type { ResourceResult } from "../resources/resourceTypes";
import { useSessionStatusSelector } from "../resources/useSessionStatus";
import { useSimulationPreparation } from "../resources/useSimulationPreparation";
import type { KernelApi } from "../types";
import { SimulationPreparationLog } from "./SimulationPreparationLog";
import {
  resolveSimulationPreparationViewModel,
  serializeSimulationPreparationDiagnostics,
  type SimulationPreparationStageView,
  type SimulationPreparationViewModel,
} from "./simulationPreparationModel";

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

  return (
    <SimulationPreparationWindow
      key={state.preparation?.preparation_id ?? "pending"}
      state={state}
    />
  );
}

function SimulationPreparationWindow({ state }: { state: SimulationStartupOverlayState }) {
  const [mode, setMode] = useState<"open" | "minimized" | "closed">("open");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hostRef = useRef<HTMLElement>(null);
  const previousMode = useRef(mode);
  useEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    if (mode === "open") {
      hostRef.current?.querySelector<HTMLButtonElement>(".fm-draggable-panel__move:not(:disabled), .fm-draggable-panel__actions button")?.focus();
    } else {
      hostRef.current?.querySelector<HTMLButtonElement>("[data-preparation-restore]")?.focus();
    }
  }, [mode]);
  const progressValue =
    state.progress.kind === "determinate" ? state.progress.value : undefined;

  return (
    <aside
      ref={hostRef}
      aria-label="Simulation preparation status"
      className="fm-simulation-startup"
      data-state={state.kind}
    >
      {mode !== "open" ? (
        <div className="fm-simulation-startup__restore" data-mode={mode}>
          <Button
            data-preparation-restore
            aria-label="Show simulation preparation"
            title={state.title}
            onClick={() => setMode("open")}
            variant="secondary"
            type="button"
          >
            <PanelTopOpen size={16} aria-hidden="true" />
            {mode === "minimized" ? state.title : "Preparation"}
            {state.failure || state.kind === "resource-error" ? (
              <span className="fm-simulation-startup__restore-status">Failed</span>
            ) : progressValue !== undefined ? (
              <span className="fm-simulation-startup__restore-status">{progressValue}%</span>
            ) : null}
          </Button>
          {mode === "minimized" ? (
            <Button aria-label="Hide preparation summary" title="Hide summary" size="icon" variant="ghost" type="button" onClick={() => setMode("closed")}>
              <X size={14} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
      <div aria-live="polite" className="fm-visually-hidden" role="status">
        {state.liveSummary}
      </div>
      <DraggablePanel
        open={mode === "open"}
        onOpenChange={(open) => setMode(open ? "open" : "closed")}
        title={state.eyebrow}
        ariaLabel="Simulation preparation window"
        role="region"
        keepMounted
        closeLabel="Close simulation preparation"
        className={`fm-simulation-startup__window${detailsOpen ? " fm-simulation-startup__window--expanded" : ""}`}
        defaultPosition={{ x: 96, y: 144 }}
        resizable={detailsOpen}
        maximizable
        onMaximize={() => setDetailsOpen(true)}
        headerActions={
          <Button aria-label="Minimize simulation preparation" title="Minimize" size="icon" variant="ghost" type="button" onClick={() => setMode("minimized")}>
            <Minus size={16} aria-hidden="true" />
          </Button>
        }
      >
      <section
        aria-labelledby="fm-simulation-startup-title"
        className="fm-simulation-startup__panel"
      >
        <header className="fm-simulation-startup__summary">
          <div className="fm-simulation-startup__heading-row">
            <div className="fm-simulation-startup__heading-copy">
              <h2
                className="fm-simulation-startup__title"
                id="fm-simulation-startup-title"
              >
                {state.title}
              </h2>
              <p className="fm-simulation-startup__detail">{state.detail}</p>
              {state.reconnectingTitle ? (
                <span className="fm-simulation-startup__reconnecting-label">
                  {state.reconnectingTitle}
                </span>
              ) : null}
              {state.failure?.correlationId ? (
                <p className="fm-simulation-startup__correlation-id">
                  Diagnostic ID: <code>{state.failure.correlationId}</code>
                </p>
              ) : null}
            </div>
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
                  : state.activeStage?.stateLabel ??
                    state.progressLabel ??
                    "Connecting"}
            </span>
          </div>
        </header>

        <Accordion
          className="fm-simulation-startup__accordion"
          collapsible
          type="single"
          value={detailsOpen ? "details" : ""}
          onValueChange={(value) => setDetailsOpen(value === "details")}
        >
          <AccordionItem value="details">
            <AccordionTrigger className="fm-simulation-startup__details-trigger">
              {state.failure || state.kind === "resource-error"
                ? "View failure details"
                : "View preparation details"}
            </AccordionTrigger>
            <AccordionContent
              className="fm-simulation-startup__details"
              forceMount
            >
              <div className="fm-simulation-startup__body">
                <PreparationStageList stages={state.stages} />
                <SimulationPreparationLog entries={state.logEntries} />
              </div>

              <details className="fm-simulation-startup__technical">
                <summary>Execution and provenance</summary>
              {state.totalElapsedLabel ? (
                <div className="fm-simulation-startup__elapsed">
                  <span>Total elapsed</span>
                  <strong>{state.totalElapsedLabel}</strong>
                </div>
              ) : null}

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

              {state.preparation?.receipt ? (
                <dl
                  aria-label="Accepted preparation provenance"
                  className="fm-simulation-startup__receipt"
                  data-preparation-receipt="accepted"
                >
                  <div>
                    <dt>Accepted preparation</dt>
                    <dd>{state.preparation.receipt.preparation_id}</dd>
                  </div>
                  <div>
                    <dt>Live run</dt>
                    <dd>{state.preparation.receipt.run_id}</dd>
                  </div>
                  <div>
                    <dt>Receipt schema</dt>
                    <dd>{state.preparation.receipt.schema_version}</dd>
                  </div>
                  <div>
                    <dt>Plan digest</dt>
                    <dd title={state.preparation.receipt.plan_fingerprint}>
                      {state.preparation.receipt.plan_fingerprint}
                    </dd>
                  </div>
                  <div>
                    <dt>Payload digest</dt>
                    <dd title={state.preparation.receipt.payload_sha256}>
                      {state.preparation.receipt.payload_sha256}
                    </dd>
                  </div>
                </dl>
              ) : null}

              {state.progressLabel ? (
                <p className="fm-simulation-startup__progress-detail">
                  {state.progressLabel}
                </p>
              ) : null}
              </details>

              <footer className="fm-simulation-startup__footer">
                <p>
                  {state.failure
                    ? "Preparation failed. Review the diagnostics before starting again."
                    : state.kind === "resource-error"
                      ? "Preparation status is unavailable. Check the backend connection."
                      : "Preparation continues in the background, even when this window is closed."}
                </p>
                {(state.failure && state.preparation) ||
                state.kind === "resource-error" ? (
                  <SimulationPreparationFailureActions state={state} />
                ) : null}
              </footer>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>
      </DraggablePanel>
    </aside>
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
  if (state.activeStage) return `${state.activeStage.label} in progress`;
  return state.progressLabel ?? "Connecting to the simulation backend";
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
  state,
}: {
  state: SimulationStartupOverlayState;
}) {
  const snapshot = state.preparation;
  const failureIdentity =
    snapshot && state.failure
      ? JSON.stringify([
          snapshot.preparation_id,
          snapshot.revision,
          state.failure.errorCode,
        ])
      : "resource-error";

  return (
    <SimulationPreparationFailureAttempt
      key={failureIdentity}
      state={state}
    />
  );
}

function SimulationPreparationFailureAttempt({
  state,
}: {
  state: SimulationStartupOverlayState;
}) {
  const kernel = useKernel();
  const snapshot = state.preparation;
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle">(
    "idle",
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const diagnosticReport = snapshot
    ? serializeSimulationPreparationDiagnostics(snapshot)
    : "";

  const copyDiagnostics = async () => {
    if (!snapshot) return;

    setCopyState("idle");
    try {
      await navigator.clipboard.writeText(diagnosticReport);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const openDiagnostics = () => openSimulationPreparationDiagnostics(kernel);

  return (
    <>
      <div className="fm-simulation-startup__actions">
        {snapshot ? (
          <>
            <Button onClick={copyDiagnostics} size="sm" type="button">
              {copyState === "copied"
                ? "Diagnostics copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy diagnostics"}
            </Button>
            <Button
              onClick={() => setDialogOpen(true)}
              size="sm"
              type="button"
            >
              View error details
            </Button>
          </>
        ) : null}
        <Button
          onClick={openDiagnostics}
          size="sm"
          type="button"
          variant="primary"
        >
          Open full diagnostics
        </Button>
      </div>
      <SimulationPreparationFailureDialog
        copyState={copyState}
        diagnosticReport={diagnosticReport}
        onCopy={copyDiagnostics}
        onOpenChange={setDialogOpen}
        onOpenDiagnostics={openDiagnostics}
        open={dialogOpen}
        state={state}
      />
    </>
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
    previous.status.data?.session.session_id ===
      next.status.data?.session.session_id &&
    previous.status.data?.session.session_epoch ===
      next.status.data?.session.session_epoch &&
    previous.status.data?.session.request_scope_epoch ===
      next.status.data?.session.request_scope_epoch &&
    previous.status.data?.lifecycle.session_resource ===
      next.status.data?.lifecycle.session_resource &&
    previous.status.data?.lifecycle.solver ===
      next.status.data?.lifecycle.solver &&
    previous.status.data?.solver.state === next.status.data?.solver.state &&
    previous.status.data?.run?.run_id === next.status.data?.run?.run_id &&
    previous.status.data?.domain.discretization ===
      next.status.data?.domain.discretization &&
    previous.status.data?.domain.generation_id ===
      next.status.data?.domain.generation_id &&
    previous.status.data?.domain.cell_count ===
      next.status.data?.domain.cell_count &&
    previous.status.data?.resources.domain_generation_id ===
      next.status.data?.resources.domain_generation_id &&
    previous.status.data?.resources.mesh_revision ===
      next.status.data?.resources.mesh_revision &&
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
    preparation,
    startupResource.status,
    null,
    realtimeConnection.disrupted,
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
    preparation,
    startupResource.status,
    null,
    realtimeConnection.disrupted,
  );
  const [displayNow, setDisplayNow] = useState<number | null>(null);
  const shouldTick = untimedState.isVisible && !untimedState.isTerminal;

  useEffect(() => {
    if (!shouldTick) return;
    return scheduleRepeatingTimeout(() => {
      setDisplayNow(Date.now());
    }, 1_000);
  }, [shouldTick]);

  const state = resolveSimulationPreparationViewModel(
    preparation,
    startupResource.status,
    displayNow,
    realtimeConnection.disrupted,
  );
  const visibleState = allowMissingSessionSmoke ? hideStartupOverlay(state) : state;
  const startupRefetch = startupResource.refetch;
  const shouldRefresh = shouldRefreshSimulationStartupStatus(visibleState);

  useEffect(() => {
    if (!shouldRefresh) return;
    return scheduleRepeatingTimeout(
      startupRefetch,
      statusRefreshIntervalMs(),
    );
  }, [startupRefetch, shouldRefresh]);

  return visibleState;
}

function scheduleRepeatingTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;

  const schedule = () => {
    timeoutId = globalThis.setTimeout(() => {
      if (cancelled) return;
      callback();
      schedule();
    }, delayMs);
  };

  schedule();

  return () => {
    cancelled = true;
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
  };
}

export function SimulationStartupOverlay() {
  return (
    <SimulationStartupOverlayView state={useSimulationStartupOverlayState()} />
  );
}
