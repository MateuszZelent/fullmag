"use client";

import { useCallback, useEffect, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useWorkspaceContentScope } from "@/kernel/layout/WorkspaceContentScope";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import {
  selectionSnapshotEquals,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";
import { returnResultsToLive } from "@/kernel/visualization/returnResultsToLive";
import { useSnapshotVisualization } from "@/kernel/visualization/useSnapshotVisualization";
import { Button } from "@/shared/ui/Button";

import { InspectorDirtySelectionGuard } from "./InspectorDirtySelectionGuard";
import {
  InspectorEditSessionProvider,
  useInspectorEditSession,
} from "./InspectorEditSession";
import { resolveInspectorDescriptor } from "./inspectorDescriptor";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveUnknownInspectorRoute } from "./inspectorRouteCatalog";
import { InspectorShell } from "./InspectorShell";
import { SavedResultsPlaybackInspector } from "./panels/SavedResultsPlaybackInspector";

function PendingFormBridge() {
  const kernel = useKernel();
  const session = useInspectorEditSession();
  const owner = useMemo(() => Symbol("inspector-pending-form"), []);
  const applying = session?.applying ?? false;
  const dirty = session?.dirty ?? false;
  const applyBlockReason = session?.applyBlockReason;
  const lockReason = session?.lockReason;
  const mode = session?.mode ?? "immediate";
  const valid = session?.valid ?? true;
  const form = useMemo(
    () =>
      session
        ? {
            apply: session.apply,
            applying,
            dirty,
            lockReason,
            mode,
            applyBlockReason,
            reset: session.reset,
            valid,
          }
        : null,
    [
      session,
      applying,
      dirty,
      applyBlockReason,
      lockReason,
      mode,
      valid,
    ],
  );

  useEffect(() => {
    const registry = kernel.pendingForms;
    if (!registry) return;
    if (!form) {
      registry.unregister(owner);
      return;
    }
    registry.register(owner, form);
    return () => registry.unregister(owner);
  }, [form, kernel.pendingForms, owner]);

  return null;
}

export default function InspectorModule() {
  const savedPlayback = useSavedResultsPlaybackSelection();
  const selectionRef = useSelectionSelector((state) => state.ref);
  const hasResultOutputSelection = selectionRef?.type === "result-output";
  if (hasResultOutputSelection) return <LiveInspectorModule />;
  if (savedPlayback?.browserOnly) return <BrowserOnlyResultsInspector />;
  return savedPlayback ? <SavedResultsPlaybackInspector /> : <LiveInspectorModule />;
}

function BrowserOnlyResultsInspector() {
  const kernel = useKernel();
  const sessionIdentity = useSessionResourceIdentity();
  return (
    <section
      aria-label="Results output Inspector"
      className="fm-inspector-panel grid min-w-0 gap-3 p-3"
    >
      <h2 className="m-0 text-fm-md font-semibold text-fm-primary">Results output</h2>
      <p className="m-0 text-fm-xs text-fm-muted" role="status">
        Select an output in Results to inspect its metadata and load it into 3D.
      </p>
      <Button size="sm" type="button" variant="secondary" onClick={() => returnResultsToLive(kernel)}>
        {sessionIdentity ? "Return to live" : "Close results"}
      </Button>
    </section>
  );
}

function HistoricalViewportNotice({ enabled }: { enabled: boolean }) {
  const kernel = useKernel();
  const snapshot = useSnapshotVisualization();
  if (!enabled || snapshot.activeKey === null) return null;
  return (
    <section
      aria-label="Historical viewport context"
      className="grid min-w-0 gap-2 border-b border-fm-subtle p-3 text-fm-sm"
    >
      <p className="m-0 text-fm-muted" role="status">
        The viewport shows a saved snapshot. This Inspector belongs to the current workspace.
      </p>
      <Button
        className="justify-self-start"
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => returnResultsToLive(kernel)}
      >
        Return to live
      </Button>
    </section>
  );
}

function LiveInspectorModule() {
  const kernel = useKernel();
  const projectOnly = useWorkspaceContentScope() === "project";
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });

  const handleFocus = useCallback(() => {
    if (projectOnly) return;
    void kernel.commands.execute("viewport-3d.fit", {
      source: "inspector",
      layout: kernel.layout,
      selection: kernel.selection,
    });
  }, [kernel, projectOnly]);

  const handleToggleVisibility = () => {
    void kernel.commands.execute(
      "panels:inspector:toggle",
      createCommandContext("inspector", kernel, {
        sourceDetail: "inspector-header",
      }),
    );
  };

  return (
    <WorkspaceRenderProfiler id="InspectorModule">
      <InspectorEditSessionProvider>
        <PendingFormBridge />
        <InspectorDirtySelectionGuard controller={kernel.selection} selection={projectOnly && selection.ref?.type !== "materialized-dataset" && selection.ref?.type !== "result-output" ? EMPTY_SELECTION : selection}>
        {(guardedSelection) => {
          const canInspect = !projectOnly || guardedSelection.ref?.type === "materialized-dataset" || guardedSelection.ref?.type === "result-output";
          const panel = canInspect ? resolveInspectorPanel(guardedSelection) : null;
          const fallbackPanel = canInspect && guardedSelection.kind
            ? resolveUnknownInspectorRoute().contribution
            : null;
          const baseDescriptor = resolveInspectorDescriptor(guardedSelection);
          const descriptor = {
            ...baseDescriptor,
            title: panel?.title ?? fallbackPanel?.title ?? baseDescriptor.title,
          };
          const Panel = panel?.component ?? fallbackPanel?.component;
          return (
            <InspectorShell
              descriptor={descriptor}
              onFocus={handleFocus}
              focusDisabled={projectOnly}
              onSelectBreadcrumb={(next) => {
                if (!projectOnly || next.ref?.type === "materialized-dataset" || next.ref?.type === "result-output") kernel.selection.set(next, "inspector");
              }}
              onToggleVisibility={handleToggleVisibility}
            >
              <HistoricalViewportNotice enabled={Boolean(Panel) && guardedSelection.ref?.type !== "result-output"} />
              {Panel ? (
                <Panel selection={guardedSelection} />
              ) : (
                <div className="fm-inspector__empty">{projectOnly ? "Select a saved project result. Simulation editing requires an active session." : "Select an explorer node."}</div>
              )}
            </InspectorShell>
          );
        }}
        </InspectorDirtySelectionGuard>
      </InspectorEditSessionProvider>
    </WorkspaceRenderProfiler>
  );
}
