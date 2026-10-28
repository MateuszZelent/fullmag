"use client";

import { useMemo, useState } from "react";

import type { SimulationPreparationResource } from "@/kernel/api/apiTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { SimulationStartupOverlayView } from "@/kernel/layout/SimulationStartupOverlay";
import { resolveSimulationPreparationViewModel } from "@/kernel/layout/simulationPreparationModel";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { SimulationPreparationStatusEntry } from "@/modules/status-bar/SimulationPreparationStatusEntry";
import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

type Phase = "running" | "stale" | "failed" | "ready";

// Local UI fixture: no API client, session mutation or solver command.
export default function PreparationWindowPreview() {
  const [phase, setPhase] = useState<Phase>("running");
  const [attempt, setAttempt] = useState(1);
  const [entryCount, setEntryCount] = useState(60);
  const kernel = useMemo(() => {
    const bus = new EventBus<KernelEventMap>();
    return {
      bus, commands: new CommandRegistry(), layout: new LayoutController(bus),
      modules: new ModuleRegistry(),
    } as KernelApi;
  }, []);
  const snapshot: SimulationPreparationResource = {
    preparation_id: `window-preview-${attempt}`, revision: entryCount,
    status: phase === "stale" ? "running" : phase,
    active_stage_id: phase === "ready" ? null : "meshing",
    started_at_unix_ms: 1_000,
    completed_at_unix_ms: phase === "ready" || phase === "failed" ? 65_000 : null,
    requested_execution: { backend: "fem", device: "auto", precision: "double", mode: "strict", engine_id: null, runtime_family: null, worker: null },
    resolved_execution: { backend: "fem", device: "gpu", precision: "double", mode: "strict", engine_id: "mfem", runtime_family: "local", worker: null },
    stages: [
      { id: "script_materialization", label: "Compile model", status: "completed", started_at_unix_ms: 1_000, completed_at_unix_ms: 2_000, duration_ms: 1_000, detail: "", progress_percent: 100, progress_label: null },
      { id: "meshing", label: "Generate FEM mesh", status: phase === "failed" ? "failed" : phase === "ready" ? "completed" : "active", started_at_unix_ms: 2_000, completed_at_unix_ms: null, duration_ms: 63_000, detail: "Refining magnetic regions and the surrounding airbox.", progress_percent: 64, progress_label: "Refinement pass 3 of 5" },
    ],
    log_tail: Array.from({ length: entryCount }, (_, index) => ({
      level: index % 13 === 0 ? "error" : index % 7 === 0 ? "warning" : "info",
      message: index % 13 === 0
        ? `Entry ${index + 1}: Mesh diagnostic for region magnetic_layer.\nFull detail is preserved on a separate line, including long paths and numerical values.`
        : `Entry ${index + 1}: Refining mesh elements in the magnetic region; quality check ${index + 1} completed.`,
      stage_id: "meshing", timestamp_unix_ms: 2_000 + index * 1_000,
    })),
    failure: phase === "failed" ? {
      diagnostics_correlation_id: "window-preview-diagnostic", detail: "A controlled UI error. The live simulation is unaffected.",
      error_code: "mesh_generation_failed", stage_id: "meshing", summary: "Mesh generation needs attention",
    } : null,
  };
  const state = resolveSimulationPreparationViewModel(
    { data: snapshot, error: null, revision: entryCount, status: phase === "stale" ? "stale" : "ready", refetch: () => undefined },
    { data: null, error: null, revision: null, status: "idle", refetch: () => undefined },
    65_000,
  );

  return (
    <KernelContext.Provider value={kernel}>
      <main className="fm-preparation-preview" id="fm-main-content">
        <h1>Preparation window · UI preview</h1>
        <p>Production components with controlled data. No live simulation commands.</p>
        <div className="fm-preparation-preview__controls">
          {(["running", "stale", "failed", "ready"] as const).map(value => (
            <Button key={value} type="button" onClick={() => setPhase(value)}>{value}</Button>
          ))}
          <Button type="button" onClick={() => setEntryCount(count => count + 1)}>Append log entry</Button>
          <Button type="button" onClick={() => { setAttempt(value => value + 1); setPhase("running"); }}>New preparation</Button>
          <label>Workspace draft<Input aria-label="Workspace draft" defaultValue="Unsaved workspace text" /></label>
        </div>
        <p role="status">Fixture: {phase}, attempt {attempt}, {entryCount} entries</p>
      </main>
      <div className="fm-workspace-overlay-host">
        <SimulationStartupOverlayView state={state} />
      </div>
      <div className="fm-status-bar" role="group" aria-label="Session status">
        <SimulationPreparationStatusEntry />
      </div>
    </KernelContext.Provider>
  );
}
