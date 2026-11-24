"use client";

import { useHomeViewOpen } from "./homeView";
import { InstanceTabFrames } from "./InstanceTabFrames";
import { InstanceTabStrip } from "./InstanceTabStrip";
import { useEmbeddedInstanceTab, useInstanceTabs } from "./instanceTabs";
import { ScriptImportBanner } from "./ScriptImportBanner";
import { TabRouteSync } from "./TabRouteSync";
import { WorkspaceFullscreenButton } from "./WorkspaceFullscreenButton";
import { useWorkspaceFullscreen } from "./workspaceFullscreenPreference";
import { WorkspaceShellClient } from "./WorkspaceShellClient";

export function WorkspaceShell() {
  // Inside another instance's tab the host page owns Home and the tab strip.
  const embedded = useEmbeddedInstanceTab();
  const { activePort } = useInstanceTabs();
  const homeOpen = useHomeViewOpen();
  const workspaceFullscreen = useWorkspaceFullscreen();
  const instanceInFront = !embedded && activePort !== null;
  const fullscreenActive = workspaceFullscreen && !homeOpen && !instanceInFront;
  return (
    <div
      className="fm-workspace-frame"
      data-workspace-fullscreen={fullscreenActive ? "true" : undefined}
    >
      {embedded ? null : <TabRouteSync />}
      {embedded ? null : <InstanceTabStrip />}
      <ScriptImportBanner />
      <div className="fm-instance-stage">
        {/* The workspace stays mounted and laid out under another instance's
            tab, but cannot take focus or input while it is covered. */}
        <main className="fm-workspace-shell" inert={instanceInFront || undefined}>
          <WorkspaceShellClient />
        </main>
        {embedded && fullscreenActive ? (
          <div className="fm-workspace-fullscreen-exit">
            <WorkspaceFullscreenButton variant="floating" />
          </div>
        ) : null}
        {embedded ? null : <InstanceTabFrames />}
      </div>
    </div>
  );
}
