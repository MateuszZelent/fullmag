"use client";

import { useEffect } from "react";

import {
  WorkspaceStartupGateView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { useSessionCollection } from "../resources/useSessionCollection";
import { useSessionResourceIdentity } from "../resources/useSessionStatus";
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
  const identity = useSessionResourceIdentity();
  const sessionState = sessions.state === "ready" && !identity ? "loading" : sessions.state;
  const sessionScopeKey = sessionRequestScopeKey(identity);
  const startOwnsPage = sessionState !== "ready" && project.state !== "ready";

  // The overlay is a visit, not a mode: starting or opening something, or the
  // workspace going away, ends it so it cannot reappear on top of the next one.
  useEffect(() => {
    homeView.close();
  }, [sessionScopeKey, startOwnsPage]);

  if (sessionState !== "ready" && project.state === "ready") {
    return <ProjectWorkspaceShell sessionState={sessionState} />;
  }

  if (sessionState !== "ready") return (
    <>
      <SlotHost slotId="app-menu" />
      {sessionState === "no-session" ? (
        <div className="fm-start-host" data-state="no-session">
          <SlotHost slotId="start-screen" />
        </div>
      ) : sessionState === "error" ? (
        <SessionCollectionError onRetry={sessions.resource.refetch} />
      ) : (
        <SessionCollectionLoading />
      )}
      {sessionState === "loading" ? null : (
        <div className="fm-workspace-overlay-host">
          <SlotHost slotId="overlay" />
        </div>
      )}
    </>
  );

  return <ActiveWorkspaceShell />;
}

function ProjectWorkspaceShell({
  sessionState,
}: {
  sessionState: "loading" | "error" | "no-session";
}) {
  const kernel = useKernel();
  const panels = useLayoutSelector((layout) => layout.panelVisible);
  const homeOpen = useHomeViewOpen();
  const detail = sessionState === "no-session"
    ? "No active session. Saved project results are available independently."
    : sessionState === "error"
      ? "Session list unavailable. Saved project results remain available."
      : "Checking for sessions. Saved project results remain available.";
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
          <p className="m-0 text-fm-xs text-fm-muted" role={sessionState === "error" ? "alert" : "status"}>{detail}</p>
        </div>
        <div className="flex gap-2">
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

function SessionCollectionLoading() {
  return (
    <main
      className="grid min-h-0 flex-1 place-items-center p-8"
      id="fm-main-content" tabIndex={-1} data-state="session-loading"
      role="status"
    >
      <section className="grid max-w-md gap-2 text-center">
        <h1 className="font-fm-ui text-lg font-semibold text-fm-primary">
          Checking for sessions
        </h1>
        <p className="text-fm-secondary">Reading the local session collection.</p>
      </section>
    </main>
  );
}

function SessionCollectionError({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div className="fm-start-host" data-state="session-error">
      <section
        className="border-b border-fm-border bg-fm-surface px-6 py-3"
        role="alert"
      >
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-fm-ui text-lg font-semibold text-fm-danger">
              Session list unavailable
            </h1>
            <p className="text-fm-secondary">
              Fullmag could not confirm whether a local session exists. Project files remain available independently.
            </p>
          </div>
          <Button type="button" onClick={onRetry}>Retry</Button>
        </div>
      </section>
      <SlotHost slotId="start-screen" />
    </div>
  );
}

function ActiveWorkspaceShell() {
  const startupState = useSimulationStartupOverlayState();
  const homeOpen = useHomeViewOpen();

  return (
    <>
      <SlotHost slotId="app-menu" />
      <WorkspaceStartupGateView
        preserveMountedWorkspace
        state={startupState}
      >
        <SlotHost slotId="ribbon" />
        <WorkspaceRenderProfiler id="WorkspaceDockLayout">
          <WorkspaceDockLayout />
        </WorkspaceRenderProfiler>
        <SlotHost slotId="status-bar" />
        {homeOpen ? <HomeOverlay /> : null}
        <div className="fm-workspace-overlay-host">
          <SlotHost slotId="overlay" />
        </div>
      </WorkspaceStartupGateView>
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
      <SlotHost slotId="start-screen" />
    </div>
  );
}
