"use client";

import { useCallback, useLayoutEffect } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useWorkspaceContentScope } from "@/kernel/layout/WorkspaceContentScope";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";
import {
  selectionSnapshotEquals,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";

import { InspectorDirtySelectionGuard } from "./InspectorDirtySelectionGuard";
import {
  InspectorEditSessionProvider,
  useInspectorEditSessionStore,
} from "./InspectorEditSession";
import { resolveInspectorDescriptor } from "./inspectorDescriptor";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveUnknownInspectorRoute } from "./inspectorRouteCatalog";
import { InspectorShell } from "./InspectorShell";
import { SavedResultsPlaybackInspector } from "./panels/SavedResultsPlaybackInspector";

function PendingFormBridge() {
  const { pendingForms } = useKernel();
  const store = useInspectorEditSessionStore();

  useLayoutEffect(() => {
    if (!pendingForms || !store) return;
    const owner = Symbol("inspector-pending-form");
    const sync = () => {
      const form = store.getCurrentSession();
      if (!form) {
        pendingForms.unregister(owner);
      } else if (!pendingForms.update(owner, form)) {
        pendingForms.register(owner, form);
      }
    };
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      pendingForms.unregister(owner);
    };
  }, [pendingForms, store]);

  return null;
}

export default function InspectorModule() {
  const savedPlayback = useSavedResultsPlaybackSelection();
  return savedPlayback && !savedPlayback.studyResult
    ? <SavedResultsPlaybackInspector />
    : <LiveInspectorModule />;
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
        <InspectorDirtySelectionGuard controller={kernel.selection} selection={projectOnly && selection.ref?.type !== "materialized-dataset" ? EMPTY_SELECTION : selection}>
        {(guardedSelection) => {
          const canInspect = !projectOnly || guardedSelection.ref?.type === "materialized-dataset";
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
                if (!projectOnly || next.ref?.type === "materialized-dataset") kernel.selection.set(next, "inspector");
              }}
              onToggleVisibility={handleToggleVisibility}
            >
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
