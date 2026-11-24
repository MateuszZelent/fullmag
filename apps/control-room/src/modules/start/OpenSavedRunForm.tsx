"use client";
import { useId, useState } from "react";
import type { KernelApi } from "@/kernel/types";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";

/** Explicit entry for durable runs which do not have an editable project archive. */
export function OpenSavedRunForm({ kernel }: { kernel: KernelApi }) {
  const id = useId();
  const [projectId, setProjectId] = useState("");
  const [runId, setRunId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!kernel.savedRun) return null;
  return <form className="fm-saved-run-open" aria-label="Open saved run" onSubmit={async event => {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(null);
    try {
      const outcome = await kernel.commands.execute("workspace.open-saved-run",
        createCommandContext("inspector", kernel, { sessionScopeKey: null, feedback: "local",
          input: { projectId, runId } }));
      if (outcome.status !== "completed") setError(outcome.message ?? "Could not open the saved run.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  }}>
    <h2>Open saved run</h2>
    <p>Inspect stored fields without starting a simulation. Enter the project and run IDs from the result.</p>
    <label htmlFor={`${id}-project`}>Project ID</label>
    <Input id={`${id}-project`} value={projectId} onChange={event => setProjectId(event.target.value)} required autoComplete="off" />
    <label htmlFor={`${id}-run`}>Run ID</label>
    <Input id={`${id}-run`} value={runId} onChange={event => setRunId(event.target.value)} required autoComplete="off" />
    <Button type="submit" variant="secondary" disabled={pending || !projectId.trim() || !runId.trim()}>
      {pending ? "Checking saved run…" : "Open saved run"}
    </Button>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
