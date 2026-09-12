"use client";

import { createCommandContext } from "../commands/commandContext";
import { useKernel } from "../KernelContext";
import { Button } from "@/shared/ui/Button";

export function EmptyWorkspace() {
  const kernel = useKernel();
  const openNewProblem = () => {
    void kernel.commands.execute(
      "workspace.new-problem",
      createCommandContext("menu", kernel, { sourceDetail: "empty-workspace" }),
    );
  };

  return (
    <main className="grid min-h-0 flex-1 place-items-center p-8" id="fm-main-content" tabIndex={-1} data-state="no-session">
      <section className="grid max-w-md gap-3 text-center">
        <p className="font-fm-ui text-fm-control font-medium text-fm-accent">Workspace</p>
        <h1 className="font-fm-ui text-2xl font-semibold tracking-tight text-fm-primary">Create a simulation</h1>
        <p className="text-fm-secondary">Start with an empty FDM or FEM problem. Configure its model and execution after creation.</p>
        <div><Button type="button" onClick={openNewProblem}>Create simulation</Button></div>
      </section>
    </main>
  );
}
