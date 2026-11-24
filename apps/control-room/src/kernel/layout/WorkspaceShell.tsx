"use client";

import { lazy, Suspense } from "react";

import { useHomeViewOpen } from "./homeView";
import { InstanceTabFrames } from "./InstanceTabFrames";
import { InstanceTabStrip } from "./InstanceTabStrip";
import { useEmbeddedInstanceTab, useInstanceTabs } from "./instanceTabs";
import { ScriptImportBanner } from "./ScriptImportBanner";
import { TabRouteSync } from "./TabRouteSync";
import { WorkspaceFullscreenButton } from "./WorkspaceFullscreenButton";
import { useWorkspaceFullscreen } from "./workspaceFullscreenPreference";
import { WorkspaceShellClient } from "./WorkspaceShellClient";
import { useSessionPreviewSelection } from "./sessionPreviewSelection";

const SessionPreviewShell = lazy(() => import("./SessionPreviewShell"));

export function WorkspaceShell() {
  // Inside another instance's tab the host page owns Home and the tab strip.
  const embedded = useEmbeddedInstanceTab();
  const { activePort } = useInstanceTabs();
  const homeOpen = useHomeViewOpen();
  const workspaceFullscreen = useWorkspaceFullscreen();
  const instanceInFront = !embedded && activePort !== null;
  const previewId = useSessionPreviewSelection();
  const visiblePreview = instanceInFront ? null : previewId;
  const fullscreenActive = workspaceFullscreen && !homeOpen && !instanceInFront && visiblePreview === null;
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
        <main className={visiblePreview ? "fm-workspace-shell invisible" : "fm-workspace-shell"}
          inert={instanceInFront || visiblePreview !== null || undefined}>
          <WorkspaceShellClient />
        </main>
        {visiblePreview && (
          <div className="absolute inset-0 z-[var(--fm-z-panel)] bg-fm-app">
            <Suspense fallback={<p role="status" className="px-4 py-2">Loading model preview…</p>}>
              <SessionPreviewShell key={visiblePreview} sessionId={visiblePreview} />
            </Suspense>
          </div>
        )}
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
