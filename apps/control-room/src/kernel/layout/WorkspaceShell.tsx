import { AppMenuBar } from "./AppMenuBar";
import { SlotHost } from "./SlotHost";
import { WorkspaceDockLayout } from "./WorkspaceDockLayout";

export function WorkspaceShell() {
  return (
    <main className="fm-workspace-shell">
      <AppMenuBar />
      <SlotHost slotId="ribbon" />
      <WorkspaceDockLayout />
      <SlotHost slotId="status-bar" />
      <div className="fm-workspace-overlay-host">
        <SlotHost slotId="overlay" />
      </div>
    </main>
  );
}
