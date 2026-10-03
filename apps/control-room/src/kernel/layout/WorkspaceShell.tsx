import { WorkspaceShellClient } from "./WorkspaceShellClient";
import { DevelopmentBackendBanner } from "./DevelopmentBackendBanner";

export function WorkspaceShell() {
  return (
    <main className="fm-workspace-shell">
      <WorkspaceShellClient />
      <DevelopmentBackendBanner />
    </main>
  );
}
