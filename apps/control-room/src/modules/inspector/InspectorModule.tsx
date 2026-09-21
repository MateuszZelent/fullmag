"use client";

import { useEffect, useMemo } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
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
              onToggleVisibility={handleToggleVisibility}
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
