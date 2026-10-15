"use client";

import { useEffect, useMemo, useState } from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { KernelApi } from "@/kernel/types";
import type { SimulationPreparationResource } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ModuleRegistry } from "@/kernel/module/ModuleRegistry";
import { SimulationStartupOverlayView } from "@/kernel/layout/SimulationStartupOverlay";
import { resolveSimulationPreparationViewModel } from "@/kernel/layout/simulationPreparationModel";
import AntennaViewport from "../../scripts/fixtures/antenna-cpw-viewport-page";
import InspectorActions from "../../scripts/fixtures/inspector-actions-page";

type Phase = "running" | "ready" | "stale" | "failed";
declare global {
  interface Window {
    __fullmagPreparationFixture?: { phase: Phase; setPhase: (phase: Phase) => void };
  }
}

function preparation(phase: Phase): SimulationPreparationResource {
  return {
    preparation_id: "fixture-preparation", revision: 1,
    status: phase === "stale" ? "running" : phase,
    active_stage_id: phase === "ready" ? null : "meshing",
    started_at_unix_ms: 1000,
    completed_at_unix_ms: phase === "ready" || phase === "failed" ? 2000 : null,
    requested_execution: { backend: "fem", device: "auto", precision: "double", mode: "strict", engine_id: null, runtime_family: null, worker: null },
    resolved_execution: { backend: "fem", device: "gpu", precision: "double", mode: "strict", engine_id: "mfem", runtime_family: "local", worker: null },
    stages: [{ id: "meshing", label: "Meshing", status: phase === "ready" ? "completed" : phase === "failed" ? "failed" : "active", started_at_unix_ms: 1000, completed_at_unix_ms: null, duration_ms: 1000, detail: "Controlled preparation observation", progress_percent: 50, progress_label: "50%" }],
    log_tail: [{ level: "info", message: "Controlled preparation observation", stage_id: "meshing", timestamp_unix_ms: 1500 }],
    failure: phase === "failed" ? { diagnostics_correlation_id: "fixture-diagnostic", detail: "Controlled meshing failure", error_code: "mesh_generation_failed", stage_id: "meshing", summary: "Controlled preparation failed" } : null,
  };
}

export default function PreparationWorkspaceFixturePage() {
  const [phase, setPhase] = useState<Phase>("running");
  const kernel = useMemo(() => {
    const bus = new EventBus<KernelEventMap>();
    return { bus, commands: new CommandRegistry(), layout: new LayoutController(bus), modules: new ModuleRegistry() } as KernelApi;
  }, []);
  const state = useMemo(() => resolveSimulationPreparationViewModel(
    { data: preparation(phase), error: null, revision: 1, status: phase === "stale" ? "stale" : "ready", refetch: () => undefined },
    { data: null, error: null, revision: null, status: "idle", refetch: () => undefined },
    2000,
  ), [phase]);
  useEffect(() => {
    window.__fullmagPreparationFixture = { phase, setPhase };
    return () => { delete window.__fullmagPreparationFixture; };
  }, [phase]);
  return <KernelContext.Provider value={kernel}>
    <div data-testid="preparation-workspace" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", minHeight: "100dvh" }}>
      <AntennaViewport />
      <InspectorActions />
    </div>
    <SimulationStartupOverlayView state={state} />
  </KernelContext.Provider>;
}
