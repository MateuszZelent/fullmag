"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  SimulationStartupOverlayView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { useSessionCollection } from "../resources/useSessionCollection";
import {
  useSessionBootstrapStatus,
  useSessionStatusSelector,
} from "../resources/useSessionStatus";
import { useStageExecutionResource } from "../resources/studyRuntimeResources";
import {
  usePlatformHealthResource,
  usePlatformRuntimeServiceResource,
} from "../resources/runtimeExplorerResources";
import { Button } from "@/shared/ui/Button";
import { CommandFeedbackPresenter } from "./CommandFeedbackPresenter";
import { WorkspaceRenderProfiler } from "../performance/reactRenderProfiler";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";
import { WorkspaceContentScopeProvider } from "./WorkspaceContentScope";
import { useProjectDocumentSnapshot } from "../persistence/ProjectDocumentStatus";
import { useKernel } from "../KernelContext";
import { useSavedResultsPlaybackSelection } from "../saved-results/useSavedResultsPlayback";
import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";
import { homeView, useHomeViewOpen } from "./homeView";
import { useLayoutSelector } from "./useLayout";
import { useRealtimeConnection } from "../realtime/useRealtimeConnection";

export function WorkspaceShellClient() {
  const savedPlayback = useSavedResultsPlaybackSelection();
  const sessions = useSessionCollection();
  const project = useProjectDocumentSnapshot();
  const sessionStatus = useSessionBootstrapStatus({
    collection: sessions.resource.data,
    enabled: sessions.state === "ready",
  });
  const identity = sessionStatus.identity;
  const statusError =
    sessions.state === "ready" &&
    sessionStatus.status === "error" &&
    !identity;
  const statusInconsistent =
    sessions.state === "ready" &&
    sessionStatus.status === "ready" &&
    (sessions.resource.data?.sessions.length ?? 0) > 0 &&
    !identity;
  const sessionState = statusError
    ? "status-error"
    : statusInconsistent
      ? "status-inconsistent"
      : sessions.state === "ready" && !identity
        ? "loading"
        : sessions.state;
  const sessionScopeKey = sessionRequestScopeKey(identity);
  const startOwnsPage = sessionState !== "ready" && project.state !== "ready";
  const refetchSessions = sessions.resource.refetch;
  const refetchStatus = sessionStatus.refetch;
  const collectionStatus = sessions.resource.status;
  // Realtime starts only after a session identity is confirmed. While no
  // session is confirmed, discover launcher sessions and recover transient
  // collection failures without relaxing the no-session creation guard.
  useEffect(() => {
    if (
      (sessions.state !== "no-session" && sessions.state !== "error") ||
      (collectionStatus !== "ready" && collectionStatus !== "error")
    ) {
      return;
    }
    let refreshStarted = false;
    let timer: number | null = null;
    const refreshVisibleCollection = () => {
      if (refreshStarted || document.visibilityState !== "visible") return;
      refreshStarted = true;
      if (timer !== null) window.clearTimeout(timer);
      refetchSessions();
    };
    timer = window.setTimeout(refreshVisibleCollection, 5_000);
    document.addEventListener("visibilitychange", refreshVisibleCollection);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshVisibleCollection);
    };
  }, [collectionStatus, refetchSessions, sessions.state]);
  const retryStatusAndCollection = useCallback(() => {
    refetchSessions();
    refetchStatus();
  }, [refetchSessions, refetchStatus]);
  const onRetry =
    sessionState === "status-error"
      ? refetchStatus
      : sessionState === "status-inconsistent"
        ? retryStatusAndCollection
        : sessionState === "loading" && sessions.state === "ready"
          ? refetchStatus
          : refetchSessions;

  // The overlay is a visit, not a mode: starting or opening something, or the
  // workspace going away, ends it so it cannot reappear on top of the next one.
  // A session confirmed while none was is not a visit ending: a /home address
  // may have opened Home while the page's session was still loading.
  const shownScopeKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = shownScopeKey.current;
    shownScopeKey.current = sessionScopeKey;
    if (previous === null && sessionScopeKey !== null) return;
    homeView.close();
  }, [sessionScopeKey, startOwnsPage]);

  if (savedPlayback) return <SavedResultsWorkspaceShell />;

  if (sessionState !== "ready" && project.state === "ready") {
    return <ProjectWorkspaceShell sessionState={sessionState} onRetry={onRetry} />;
  }

  // Home is the entry surface, not a session-loading state. Keep its module
  // mounted while collection/status requests retry so a backend interruption
  // cannot replace the page with a full-screen loading/error gate.
  if (sessionState !== "ready") {
    return (
      <>
        <SlotHost slotId="app-menu" />
        <HomeShell state={sessionState} onRetry={onRetry} />
      </>
    );
  }

  return <ActiveWorkspaceShell />;
}

function SavedResultsWorkspaceShell() {
  const kernel = useKernel();
  const selection = useSavedResultsPlaybackSelection();
  if (!selection) return null;

  return (
    <WorkspaceContentScopeProvider scope="session">
      <SlotHost slotId="app-menu" />
      <section
        aria-label="Saved results playback"
        className="fm-saved-results-playback-shell__header"
        data-saved-results-playback="read-only"
      >
        <div className="fm-saved-results-playback-shell__identity">
          <h1 className="fm-saved-results-playback-shell__title">Saved results · read only</h1>
          <p className="fm-saved-results-playback-shell__name" title={selection.name}>{selection.name}</p>
        </div>
        <Button
          className="fm-saved-results-playback-shell__close"
          onClick={() => kernel.savedResultsPlayback?.close()}
          type="button"
          variant="secondary"
        >
          Close playback
        </Button>
      </section>
      <WorkspaceRenderProfiler id="WorkspaceDockLayout">
        <WorkspaceDockLayout />
      </WorkspaceRenderProfiler>
      <CommandFeedbackPresenter />
    </WorkspaceContentScopeProvider>
  );
}

function ProjectWorkspaceShell({
  sessionState,
  onRetry,
}: {
  sessionState: "loading" | "error" | "status-error" | "status-inconsistent" | "no-session";
  onRetry: () => void;
}) {
  const kernel = useKernel();
  const panels = useLayoutSelector((layout) => layout.panelVisible);
  const homeOpen = useHomeViewOpen();
  const detail = sessionState === "no-session"
    ? "No active session. Saved project results are available independently."
    : sessionState === "error"
      ? "Session list unavailable. Saved project results remain available."
      : sessionState === "status-error"
        ? "Current session status unavailable. Saved project results remain available."
        : sessionState === "status-inconsistent"
          ? "Current session does not match the session list. Saved project results remain available."
          : "Checking for sessions. Saved project results remain available.";
  const isError = sessionState === "error" || sessionState === "status-error" || sessionState === "status-inconsistent";
  return (
    <WorkspaceContentScopeProvider scope="project">
      <SlotHost slotId="app-menu" />
      <RuntimeDegradedBanner hasWorkspaceDiagnostics />
      <section
        className="flex flex-wrap items-center justify-between gap-2 border-b border-fm-border bg-fm-surface px-4 py-2"
        data-project-workspace-session-state={sessionState}
        aria-label="Project workspace"
      >
        <div>
          <h1 className="m-0 text-fm-sm font-semibold text-fm-primary">Saved project results</h1>
          <p className="m-0 text-fm-xs text-fm-muted" role={isError ? "alert" : "status"}>{detail}</p>
        </div>
        <div className="flex gap-2">
          {isError ? <Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button> : null}
          {!panels.left ? <Button size="sm" variant="secondary" onClick={() => kernel.layout.togglePanel("left")}>Show saved results</Button> : null}
          {!panels.right ? <Button size="sm" variant="secondary" onClick={() => kernel.layout.togglePanel("right")}>Show Inspector</Button> : null}
        </div>
      </section>
      <WorkspaceRenderProfiler id="WorkspaceDockLayout">
        <WorkspaceDockLayout />
      </WorkspaceRenderProfiler>
      {homeOpen ? <HomeOverlay /> : null}
      <CommandFeedbackPresenter />
    </WorkspaceContentScopeProvider>
  );
}

function HomeShell({
  state,
  onRetry,
}: {
  readonly state:
    | "loading"
    | "error"
    | "status-error"
    | "status-inconsistent"
    | "no-session";
  readonly onRetry: () => void;
}) {
  const sessionUnavailable = state !== "no-session";
  const platformHealth = usePlatformHealthResource();
  const runtimeUnavailable = platformHealth.data?.status === "degraded";
  const startScreenFallback = (
    <StartScreenLoadingFallback mode={runtimeUnavailable ? "runtime-unavailable" : sessionUnavailable ? "reconnecting" : "empty"} />
  );

  return (
    <div
      className="fm-start-host"
      data-state={state === "no-session" ? "no-session" : "home-session-reconnecting"}
    >
      {sessionUnavailable ? (
        <div
          className="fm-start-session-status"
          data-session-connection={runtimeUnavailable ? "runtime-unavailable" : "reconnecting"}
          role="status"
        >
          <span>{runtimeUnavailable
            ? "Runtime execution is unavailable. Home and diagnostics remain available."
            : "Session services are reconnecting. Home remains available."}</span>
          <Button size="sm" type="button" variant="ghost" onClick={() => {
            platformHealth.refetch();
            onRetry();
          }}>{runtimeUnavailable ? "Refresh status" : "Retry"}</Button>
        </div>
      ) : null}
      <RuntimeDegradedBanner />
      <SlotHost loadingFallback={startScreenFallback} slotId="start-screen" />
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
      </div>
      <CommandFeedbackPresenter />
    </div>
  );
}

function StartScreenLoadingFallback({
  mode,
}: {
  readonly mode: "reconnecting" | "runtime-unavailable" | "empty" | "overlay";
}) {
  const detail = mode === "runtime-unavailable"
    ? "Runtime execution is unavailable. Home and diagnostics remain available."
    : mode === "reconnecting"
    ? "Session services are reconnecting. Home remains available."
    : mode === "empty"
      ? "Start from an empty FDM or FEM problem, or open a project archive."
      : "Home remains available while its module finishes loading.";
  return (
    <main
      className="grid h-full min-h-0 place-content-center gap-2 bg-fm-app p-8 text-center text-fm-primary"
      data-start-screen-fallback={mode}
      id="fm-main-content"
    >
      <h1 className="m-0 font-fm-ui text-fm-lg font-semibold">Welcome to Fullmag</h1>
      <p className="m-0 text-fm-secondary">{detail}</p>
    </main>
  );
}

function ActiveWorkspaceShell() {
  const startupState = useSimulationStartupOverlayState();
  const homeOpen = useHomeViewOpen();

  return (
    <>
      <SlotHost slotId="app-menu" />
      <SlotHost slotId="ribbon" />
      <RuntimeDegradedBanner hasWorkspaceDiagnostics />
      <WorkspaceRenderProfiler id="WorkspaceDockLayout">
        <WorkspaceDockLayout />
      </WorkspaceRenderProfiler>
      <SlotHost slotId="status-bar" />
      {homeOpen ? <HomeOverlay /> : null}
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
        <SimulationStartupOverlayView state={startupState} />
      </div>
      <CommandFeedbackPresenter />
    </>
  );
}

function RuntimeDegradedBanner({
  hasWorkspaceDiagnostics = false,
}: {
  readonly hasWorkspaceDiagnostics?: boolean;
}) {
  const kernel = useKernel();
  // An idle healthy workspace issues no periodic requests. Health is read on
  // mount, again whenever the realtime connection changes or the page becomes
  // visible, and polled only while the runtime is already degraded.
  const health = usePlatformHealthResource();
  const degraded = health.data?.status === "degraded";
  const realtime = useRealtimeConnection();
  const refetchHealth = health.refetch;
  useEffect(() => {
    refetchHealth();
  }, [realtime.status, realtime.disrupted, refetchHealth]);
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refetchHealth();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = degraded ? window.setInterval(refreshVisible, 5_000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", refreshVisible);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [degraded, refetchHealth]);
  const runtimeService = usePlatformRuntimeServiceResource({
    enabled: degraded,
    pollIntervalMs: degraded ? 5_000 : 0,
  });
  const taskState = useSessionStatusSelector(
    (status) => status.data?.solver.state ?? null,
    { enabled: hasWorkspaceDiagnostics },
  );
  const runId = useSessionStatusSelector(
    (status) => status.data?.run?.run_id ?? null,
    { enabled: hasWorkspaceDiagnostics },
  );
  const taskFailed = hasWorkspaceDiagnostics && (taskState === "error" || taskState === "failed");
  const stageExecution = useStageExecutionResource({ enabled: taskFailed });
  // The hook fences session/request identity. Also require the current run;
  // a cached stage from another run must never explain this task's failure.
  const failedStage = stageExecution.status === "ready" && runId !== null &&
      stageExecution.data?.run_id === runId
    ? stageExecution.data.stages.find((stage) => stage.status === "failed")
    : undefined;

  if (!degraded && !taskFailed) return null;

  const service = runtimeService.data;
  const reasonCode = service?.reason.code.trim();
  const reasonMessage = service?.reason.message.trim();
  return (
    <div
      aria-label={degraded ? "Native runtime degraded" : "Simulation task failed"}
      className="fm-runtime-degraded-banner"
      data-runtime-state={health.data?.status ?? "unknown"}
      data-task-state={taskFailed ? taskState : undefined}
      role="alert"
    >
      <div className="fm-runtime-degraded-banner__copy">
        <strong>{degraded
          ? "Native runtime is degraded. New computation requests are blocked."
          : "Simulation task failed. Inspect its diagnostics before starting another run."}</strong>
        {degraded ? <span>
          {reasonMessage || (runtimeService.status === "error"
            ? "Runtime diagnostics are temporarily unavailable."
            : "Loading the runtime failure reason.")}
        </span> : null}
        {degraded && service ? (
          <span className="fm-runtime-degraded-banner__reason">
            Runtime service: {service.state}
            {reasonCode ? ` · Reason: ${reasonCode}` : ""}
          </span>
        ) : null}
        {taskFailed ? (
          <>
            <span className="break-words">Task status: {taskState}{runId ? ` · Run: ${runId}` : ""}</span>
            <span>Stage: {failedStage?.label || failedStage?.stage_id ||
              (stageExecution.status === "loading" ? "Loading failure stage…" : "Not published for this run")}</span>
            <span className="break-words">Cause: {failedStage?.state_transition_reason?.trim() ||
              (stageExecution.status === "loading" ? "Loading failure details…" : "No detailed cause is available; inspect the engine log and command history.")}</span>
          </>
        ) : null}
        <span>
          No computation will be rerun automatically. API diagnostics remain available;
          previously loaded results are retained. Inspect the runtime logs for the failed
          stage and cause. A task&apos;s completion status is shown separately from API availability.
        </span>
        {hasWorkspaceDiagnostics ? (
          <div className="flex flex-wrap gap-2" aria-label="Runtime failure diagnostics">
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                homeView.close();
                kernel.layout.openBottomPanel("engine");
              }}
            >
              Open engine log
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                homeView.close();
                kernel.layout.openBottomPanel("operations");
              }}
            >
              Inspect commands
            </Button>
          </div>
        ) : (
          <span>No workspace is loaded. Inspect the backend container log for startup details.</span>
        )}
      </div>
    </div>
  );
}

/**
 * The start screen laid over a mounted workspace. Hiding the workspace with
 * visibility (see layout.css) rather than unmounting keeps its WebGL context,
 * drafts and undo history alive while the user looks at Home.
 */
function HomeOverlay() {
  return (
    <div className="fm-home-overlay" data-state="home-overlay">
      <SlotHost
        loadingFallback={<StartScreenLoadingFallback mode="overlay" />}
        slotId="start-screen"
      />
    </div>
  );
}
