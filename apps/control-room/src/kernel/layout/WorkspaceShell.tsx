"use client";

import { DevelopmentBackendBanner } from "./DevelopmentBackendBanner";
import { WorkspaceShellClient } from "./WorkspaceShellClient";
import { DevelopmentWorkspaceInputBoundary } from "../development/DevelopmentWorkspaceInputBoundary";

export function WorkspaceShell() {
  return (
    <div className="fm-workspace-frame">
      <DevelopmentBackendBanner />
      <DevelopmentWorkspaceInputBoundary className="fm-workspace-shell">
        <WorkspaceShellClient />
      </DevelopmentWorkspaceInputBoundary>
    </div>
  );
}
