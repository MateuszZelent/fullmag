"use client";

import {
  WorkspaceStartupGateView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { useSessionCollection } from "../resources/useSessionCollection";
import { EmptyWorkspace } from "./EmptyWorkspace";
import { WorkspaceRenderProfiler } from "../performance/reactRenderProfiler";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

export function WorkspaceShellClient() {
  const sessions = useSessionCollection();

  if (sessions.state !== "ready") {
    return (
      <>
        <SlotHost slotId="app-menu" />
        <EmptyWorkspace />
      </>
    );
  }

  return <ActiveWorkspaceShell />;
}

function ActiveWorkspaceShell() {
  const startupState = useSimulationStartupOverlayState();

  return (
    <>
      <SlotHost slotId="app-menu" />
      <WorkspaceStartupGateView state={startupState}>
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
