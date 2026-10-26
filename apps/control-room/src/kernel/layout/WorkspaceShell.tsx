"use client";

import { InstanceTabFrames } from "./InstanceTabFrames";
import { InstanceTabStrip } from "./InstanceTabStrip";
import { useEmbeddedInstanceTab, useInstanceTabs } from "./instanceTabs";
import { ScriptImportBanner } from "./ScriptImportBanner";
import { TabRouteSync } from "./TabRouteSync";
import { WorkspaceShellClient } from "./WorkspaceShellClient";

export function WorkspaceShell() {
  // Inside another instance's tab the host page owns Home and the tab strip.
  const embedded = useEmbeddedInstanceTab();
  const { activePort } = useInstanceTabs();
  const instanceInFront = !embedded && activePort !== null;
  return (
    <div className="fm-workspace-frame">
      {embedded ? null : <TabRouteSync />}
      {embedded ? null : <InstanceTabStrip />}
      <ScriptImportBanner />
      <div className="fm-instance-stage">
        {/* The workspace stays mounted and laid out under another instance's
            tab, but cannot take focus or input while it is covered. */}
        <main className="fm-workspace-shell" inert={instanceInFront || undefined}>
          <WorkspaceShellClient />
        </main>
        {embedded ? null : <InstanceTabFrames />}
      </div>
    </div>
  );
}
