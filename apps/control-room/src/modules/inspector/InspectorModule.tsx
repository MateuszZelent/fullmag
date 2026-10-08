"use client";

import { useCallback, useEffect, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
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
  useInspectorEditSession,
} from "./InspectorEditSession";
import { resolveInspectorDescriptor } from "./inspectorDescriptor";
import { resolveInspectorPanel } from "./inspectorRegistry";
import { resolveUnknownInspectorRoute } from "./inspectorRouteCatalog";
import { InspectorShell } from "./InspectorShell";

function PendingFormBridge() {
  const kernel = useKernel();
  const session = useInspectorEditSession();
  const owner = useMemo(() => Symbol("inspector-pending-form"), []);
  const applying = session?.applying ?? false;
  const dirty = session?.dirty ?? false;
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
            reset: session.reset,
            valid,
          }
        : null,
    [
      session,
      applying,
      dirty,
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
