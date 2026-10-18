"use client";

import { useCallback, useEffect } from "react";

import {
  SimulationStartupOverlayView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { useSessionCollection } from "../resources/useSessionCollection";
import { useSessionBootstrapStatus } from "../resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import { WorkspaceRenderProfiler } from "../performance/reactRenderProfiler";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";
import { WorkspaceContentScopeProvider } from "./WorkspaceContentScope";
import { useProjectDocumentSnapshot } from "../persistence/ProjectDocumentStatus";
import { useKernel } from "../KernelContext";
import { sessionRequestScopeKey } from "../resources/sessionResourceIdentity";
import { homeView, useHomeViewOpen } from "./homeView";
import { useLayoutSelector } from "./useLayout";

export function WorkspaceShellClient() {
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
  useEffect(() => {
    homeView.close();
  }, [sessionScopeKey, startOwnsPage]);

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
  const startScreenFallback = (
    <StartScreenLoadingFallback mode={sessionUnavailable ? "reconnecting" : "empty"} />
  );

  return (
    <div
      className="fm-start-host"
      data-state={state === "no-session" ? "no-session" : "home-session-reconnecting"}
    >
      {sessionUnavailable ? (
        <div
          className="fm-start-session-status"
          data-session-connection="reconnecting"
          role="status"
        >
          <span>Session services are reconnecting. Home remains available.</span>
          <Button size="sm" type="button" variant="ghost" onClick={onRetry}>Retry</Button>
        </div>
      ) : null}
      <SlotHost loadingFallback={startScreenFallback} slotId="start-screen" />
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
      </div>
    </div>
  );
}

function StartScreenLoadingFallback({
  mode,
}: {
  readonly mode: "reconnecting" | "empty" | "overlay";
}) {
  const detail = mode === "reconnecting"
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
      <WorkspaceRenderProfiler id="WorkspaceDockLayout">
        <WorkspaceDockLayout />
      </WorkspaceRenderProfiler>
      <SlotHost slotId="status-bar" />
      {homeOpen ? <HomeOverlay /> : null}
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
        <SimulationStartupOverlayView state={startupState} />
      </div>
    </>
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
