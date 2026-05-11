import { AppMenuBar } from "./AppMenuBar";
import { SlotHost } from "./SlotHost";

export function WorkspaceShell() {
  return (
    <main className="fm-workspace-shell">
      <AppMenuBar />
      <SlotHost slotId="ribbon" moduleManifest={null} />
      <div className="fm-workspace-body">
        <SlotHost slotId="panel-left" moduleManifest={null} />
        <SlotHost slotId="viewport-main" moduleManifest={null} />
        <SlotHost slotId="panel-right" moduleManifest={null} />
        <SlotHost slotId="panel-bottom" moduleManifest={null} />
      </div>
      <SlotHost slotId="status-bar" moduleManifest={null} />
    </main>
  );
}
