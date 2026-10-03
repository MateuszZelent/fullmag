import { DevelopmentBackendBanner } from "./DevelopmentBackendBanner";
import { WorkspaceShellClient } from "./WorkspaceShellClient";

export function WorkspaceShell() {
  return (
    <div className="fm-workspace-frame">
      <DevelopmentBackendBanner />
      <main className="fm-workspace-shell">
        <WorkspaceShellClient />
      </main>
    </div>
  );
}
