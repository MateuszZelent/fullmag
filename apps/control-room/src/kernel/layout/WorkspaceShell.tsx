"use client";

import { DevelopmentBackendBanner } from "./DevelopmentBackendBanner";
import { ScriptImportBanner } from "./ScriptImportBanner";
import { WorkspaceShellClient } from "./WorkspaceShellClient";
import { DevelopmentWorkspaceInputBoundary } from "../development/DevelopmentWorkspaceInputBoundary";

export function WorkspaceShell() {
  return (
    <div className="fm-workspace-frame">
      <DevelopmentBackendBanner />
      <ScriptImportBanner />
      <DevelopmentWorkspaceInputBoundary className="fm-workspace-shell">
        <WorkspaceShellClient />
      </DevelopmentWorkspaceInputBoundary>
    </div>
  );
}
