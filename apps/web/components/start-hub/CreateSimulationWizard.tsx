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
    <section className="rounded-md border border-border/60 bg-card/70 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Create New Simulation</h2>
          <p className="mt-1 text-xs text-muted-foreground">Configure a clean project shell before opening the workspace.</p>
        </div>
        <button
          type="button"
          onClick={() => onCreate({ name, location, backend, stage })}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Create Simulation
        </button>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60" placeholder="Simulation name" />
        <input value={location} onChange={(e) => setLocation(e.target.value)} className="min-w-0 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60" placeholder="Save location" />
        <select value={backend} onChange={(e) => setBackend(e.target.value)} className="min-w-0 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm outline-none transition-colors focus:border-primary/60">
          <option value="fem">FEM</option>
          <option value="fdm">FDM</option>
        </select>
        <select value={stage} onChange={(e) => setStage(e.target.value as WorkspaceStage)} className="min-w-0 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-sm outline-none transition-colors focus:border-primary/60">
          <option value="build">Model Builder</option>
          <option value="study">Study</option>
        </select>
      </div>
    </section>
  );
}
