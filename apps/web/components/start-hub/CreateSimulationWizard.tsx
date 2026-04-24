"use client";

import { useState } from "react";
import type { WorkspaceStage } from "@/lib/workspace/launch-intent";

interface CreateSimulationWizardProps {
  onCreate: (payload: {
    name: string;
    location: string;
    backend: string;
    stage: WorkspaceStage;
  }) => void;
}

export default function CreateSimulationWizard({ onCreate }: CreateSimulationWizardProps) {
  const [name, setName] = useState("new_simulation");
  const [location, setLocation] = useState("~/fullmag");
  const [backend, setBackend] = useState("fem");
  const [stage, setStage] = useState<WorkspaceStage>("build");

  return (
    <section className="rounded-xl border border-border/40 bg-card/40 p-4">
      <h2 className="text-sm font-semibold tracking-wide text-foreground">Create New Simulation</h2>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs" placeholder="Simulation name" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs" placeholder="Save location" />
        <select value={backend} onChange={(e) => setBackend(e.target.value)} className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs">
          <option value="fem">FEM</option>
          <option value="fdm">FDM</option>
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value as WorkspaceStage)} className="rounded-md border border-border/40 bg-background/70 px-2 py-1.5 text-xs">
          <option value="build">Model Builder</option>
          <option value="study">Study</option>
        </select>
      </div>
      <button
        type="button"
        onClick={() => onCreate({ name, location, backend, stage })}
        className="mt-3 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
      >
        Create Simulation
      </button>
    </section>
  );
}
