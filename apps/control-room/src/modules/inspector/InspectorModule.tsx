"use client";

import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";

import { resolveInspectorPanel } from "./inspectorRegistry";

export default function InspectorModule({ moduleId }: ModuleProps) {
  const { selection } = useSelection(moduleId);
  const panel = resolveInspectorPanel(selection);

  if (!panel) {
    return (
      <section className="fm-inspector" aria-label="Inspector">
        <header className="fm-inspector__header">
          <h2>Inspector</h2>
          <span>No selection</span>
        </header>
        <div className="fm-inspector__empty">Select an explorer node.</div>
      </section>
    );
  }

  const Panel = panel.component;

  return (
    <section className="fm-inspector" aria-label="Inspector">
      <header className="fm-inspector__header">
        <h2>{panel.title}</h2>
        <span>{selection.kind}</span>
      </header>
      <div className="fm-inspector__body">
        <Panel selection={selection} />
      </div>
    </section>
  );
}
