"use client";

import {
  WorkspaceStartupGateView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { useSessionCollection } from "../resources/useSessionCollection";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { Button } from "@/shared/ui/Button";
import { WorkspaceRenderProfiler } from "../performance/reactRenderProfiler";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

export function WorkspaceShellClient() {
  const sessions = useSessionCollection();

  if (sessions.state !== "ready") return (
    <>
      <SlotHost slotId="app-menu" />
      {sessions.state === "no-session" ? (
        <EmptyWorkspace />
      ) : sessions.state === "error" ? (
        <SessionCollectionError onRetry={sessions.resource.refetch} />
      ) : (
        <SessionCollectionLoading />
      )}
    </>
  );

  return <ActiveWorkspaceShell />;
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
    <div className="grid min-h-0 flex-1" data-state="session-error">
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
      <EmptyWorkspace />
    </div>
  );
}

function ActiveWorkspaceShell() {
  const startupState = useSimulationStartupOverlayState();

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
        <div className="fm-workspace-overlay-host">
          <SlotHost slotId="overlay" />
        </div>
      </WorkspaceStartupGateView>
    </>
  );
}
