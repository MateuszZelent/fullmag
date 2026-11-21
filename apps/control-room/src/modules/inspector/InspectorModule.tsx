"use client";

import { useCallback, useLayoutEffect } from "react";
import { PanelRightClose } from "lucide-react";

import { Button } from "@/shared/ui/Button";
import { PanelChrome, usePanelChromeControls } from "@/shared/ui/PanelFrame";
import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useWorkspaceContentScope } from "@/kernel/layout/WorkspaceContentScope";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { EMPTY_SELECTION, type Selection } from "@/kernel/selection/selectionTypes";
import {
  selectionSnapshotEquals,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";
import {
  Viewport3DExportPanelOutlet,
  Viewport3DInspectorOutlet,
  setViewport3DInspectorContext,
  useViewport3DExportVisited,
  useViewport3DInspectorContext,
  useViewport3DInspectorVisited,
} from "@/modules/viewport-3d/public";

import { InspectorContexts } from "./InspectorContexts";
import { InspectorDirtySelectionGuard } from "./InspectorDirtySelectionGuard";
import {
  InspectorEditSessionProvider,
  useInspectorEditSessionStore,
  useStagedDirtyFieldCount,
} from "./InspectorEditSession";
import { resolveInspectorDescriptor } from "./inspectorDescriptor";
import { inspectorFitCommandId } from "./inspectorFitCommand";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveUnknownInspectorRoute } from "./inspectorRouteCatalog";
import { InspectorShell } from "./InspectorShell";
import { publishInspectorStagedDirtyCount } from "./InspectorTabState";
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
  return (
    <WorkspaceRenderProfiler id="InspectorModule">
      <InspectorEditSessionProvider>
        <PendingFormBridge />
        <TopLevelGuardedInspector />
      </InspectorEditSessionProvider>
    </WorkspaceRenderProfiler>
  );
}

function TopLevelGuardedInspector() {
  const kernel = useKernel();
  const context = useViewport3DInspectorContext();
  const viewVisited = useViewport3DInspectorVisited();
  const exportVisited = useViewport3DExportVisited();
  const savedPlayback = useSavedResultsPlaybackSelection();
  const dirtyFieldCount = useStagedDirtyFieldCount();
  useLayoutEffect(() => {
    publishInspectorStagedDirtyCount(dirtyFieldCount);
    return () => publishInspectorStagedDirtyCount(0);
  }, [dirtyFieldCount]);
  const projectOnly = useWorkspaceContentScope() === "project";
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });

  const effectiveSelection =
    projectOnly && selection.ref?.type !== "materialized-dataset"
      ? EMPTY_SELECTION
      : selection;

  const restoreSelectionTab = useCallback(() => {
    setViewport3DInspectorContext("selection");
  }, []);

  const showSavedPlayback = Boolean(savedPlayback && !savedPlayback.studyResult);
  const hasViewport3D = Boolean(kernel.modules.get("viewport-3d"));

  return (
    <InspectorDirtySelectionGuard
      controller={kernel.selection}
      selection={effectiveSelection}
      onRestoreSelectionTab={restoreSelectionTab}
    >
      {(guardedSelection) => {
        const selectionSubtree = (
          <>
            {showSavedPlayback ? <SavedResultsPlaybackInspector /> : null}
            <div
              className="fm-inspector__selection-host"
              hidden={showSavedPlayback}
              inert={showSavedPlayback ? true : undefined}
            >
              <SelectionInspectorOutlet
                guardedSelection={guardedSelection}
                projectOnly={projectOnly}
              />
            </div>
          </>
        );

        if (!hasViewport3D) {
          return selectionSubtree;
        }

        return (
          <InspectorContexts
            context={context}
            dirtyFieldCount={dirtyFieldCount}
            exportPanel={exportVisited ? <ExportInspectorPanel /> : null}
            onContextChange={setViewport3DInspectorContext}
            view={viewVisited ? <ViewInspectorPanel /> : null}
            viewActions={<ViewInspectorActions />}
          >
            {selectionSubtree}
          </InspectorContexts>
        );
      }}
    </InspectorDirtySelectionGuard>
  );
}

function ViewInspectorPanel() {
  return (
    <section aria-label="3D View Inspector" className="fm-inspector-view">
      <Viewport3DInspectorOutlet />
    </section>
  );
}

function ExportInspectorPanel() {
  return (
    <section aria-label="3D Export Inspector" className="fm-inspector-view">
      <Viewport3DExportPanelOutlet />
    </section>
  );
}

function ViewInspectorActions() {
  const kernel = useKernel();
  const chrome = usePanelChromeControls();
  const hide = () => kernel.layout.setPanelVisible("right", false);
  return (
    <PanelChrome className="fm-inspector-contexts__actions">
      <Button
        aria-label="Hide Inspector"
        size="icon"
        variant="ghost"
        onClick={() => (chrome ? chrome.hideWith(hide) : hide())}
      >
        <PanelRightClose aria-hidden="true" size={16} />
      </Button>
    </PanelChrome>
  );
}

function SelectionInspectorOutlet({
  guardedSelection,
  projectOnly,
}: {
  guardedSelection: Selection;
  projectOnly: boolean;
}) {
  const kernel = useKernel();

  const handleFocus = useCallback(() => {
    if (projectOnly) return;
    const commandId = inspectorFitCommandId(
      kernel.layout.get().activeViewportMainModuleId,
    );
    if (commandId === "field-map.fit") {
      // The 2D fit writes the planar interaction through visualization sync.
      void kernel.commands.execute(
        commandId,
        createCommandContext("inspector", kernel),
      );
      return;
    }
    void kernel.commands.execute(commandId, {
      layout: kernel.layout,
      selection: kernel.selection,
      source: "inspector",
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

  const canInspect =
    !projectOnly || guardedSelection.ref?.type === "materialized-dataset";
  const panel = canInspect ? resolveInspectorPanel(guardedSelection) : null;
  const fallbackPanel =
    canInspect && guardedSelection.kind
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
      focusDisabled={projectOnly}
      onFocus={handleFocus}
      onSelectBreadcrumb={(next) => {
        if (!projectOnly || next.ref?.type === "materialized-dataset") {
          kernel.selection.set(next, "inspector");
        }
      }}
      onToggleVisibility={handleToggleVisibility}
    >
      {Panel ? (
        <Panel selection={guardedSelection} />
      ) : (
        <div className="fm-inspector__empty">
          {projectOnly
            ? "Select a saved project result. Simulation editing requires an active session."
            : "Select an explorer node."}
        </div>
      )}
    </InspectorShell>
  );
}
