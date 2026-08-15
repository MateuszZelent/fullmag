"use client";

import { useKernel } from "@/kernel/KernelContext";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import {
  selectionSnapshotEquals,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";

import { InspectorDirtySelectionGuard } from "./InspectorDirtySelectionGuard";
import { InspectorEditSessionProvider } from "./InspectorEditSession";
import { resolveInspectorDescriptor } from "./inspectorDescriptor";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveUnknownInspectorRoute } from "./inspectorRouteCatalog";
import { InspectorShell } from "./InspectorShell";

export default function InspectorModule() {
  const kernel = useKernel();
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });

  const handleFocus = () => {
    void kernel.commands.execute("viewport-3d.fit", {
      source: "inspector",
      layout: kernel.layout,
      selection: kernel.selection,
    });
  };

  return (
    <WorkspaceRenderProfiler id="InspectorModule">
      <InspectorEditSessionProvider>
        <InspectorDirtySelectionGuard controller={kernel.selection} selection={selection}>
        {(guardedSelection) => {
          const panel = resolveInspectorPanel(guardedSelection);
          const fallbackPanel = guardedSelection.kind
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
              onSelectBreadcrumb={(next) => kernel.selection.set(next, "inspector")}
            >
              {Panel ? (
                <Panel selection={guardedSelection} />
              ) : (
                <div className="fm-inspector__empty">Select an explorer node.</div>
              )}
            </InspectorShell>
          );
        }}
        </InspectorDirtySelectionGuard>
      </InspectorEditSessionProvider>
    </WorkspaceRenderProfiler>
  );
}
