"use client";

import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import {
  selectionSnapshotEquals,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";

import { resolveInspectorPanel } from "./inspectorRegistry";

export default function InspectorModule() {
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });
  const panel = resolveInspectorPanel(selection);

  if (!panel) {
    return (
      <WorkspaceRenderProfiler id="InspectorModule">
        <section className="fm-inspector" aria-label="Inspector">
          <header className="fm-inspector__header">
            <h2>Inspector</h2>
            <span>No selection</span>
          </header>
          <div className="fm-inspector__empty">Select an explorer node.</div>
        </section>
      </WorkspaceRenderProfiler>
    );
  }

  const Panel = panel.component;

  return (
    <WorkspaceRenderProfiler id="InspectorModule">
      <section className="fm-inspector" aria-label="Inspector">
        <header className="fm-inspector__header">
          <h2>{panel.title}</h2>
          <span>{selection.kind}</span>
        </header>
        <div className="fm-inspector__body">
          <Panel selection={selection} />
        </div>
      </section>
    </WorkspaceRenderProfiler>
  );
}
