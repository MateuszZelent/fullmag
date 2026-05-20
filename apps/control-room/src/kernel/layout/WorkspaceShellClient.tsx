"use client";

import {
  WorkspaceStartupGateView,
  useSimulationStartupOverlayState,
} from "./SimulationStartupOverlay";
import { WorkspaceRenderProfiler } from "../performance/reactRenderProfiler";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

export function WorkspaceShellClient() {
  const startupState = useSimulationStartupOverlayState();

  return (
    <WorkspaceStartupGateView state={startupState}>
      <SlotHost slotId="app-menu" />
      <SlotHost slotId="ribbon" />
      <WorkspaceRenderProfiler id="WorkspaceDockLayout">
        <WorkspaceDockLayout />
      </WorkspaceRenderProfiler>
      <SlotHost slotId="status-bar" />
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
      </div>
    </WorkspaceStartupGateView>
  );
}
