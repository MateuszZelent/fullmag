"use client";

import { createCommandContext } from "../commands/commandContext";
import { useKernel } from "../KernelContext";
import { Button } from "@/shared/ui/Button";
import { useProjectDocumentSnapshot } from "../persistence/ProjectDocumentStatus";

export function EmptyWorkspace() {
  const kernel = useKernel();
  useProjectDocumentSnapshot();
  const commandContext = createCommandContext("menu", kernel, {
    sourceDetail: "empty-workspace",
  });
  const openNewProblem = () => {
    void kernel.commands.execute(
      "workspace.new-problem",
      commandContext,
    );
  };
  const runProjectCommand = (commandId: string, input?: unknown) => {
    void kernel.commands.execute(commandId, commandContext, input);
  };
  const projectCommandEnabled = (commandId: string) =>
    kernel.commands.isEnabled(commandId, commandContext);

  return (
    <main className="grid min-h-0 flex-1 place-items-center p-8" id="fm-main-content" tabIndex={-1} data-state="no-session">
      <section className="grid max-w-md gap-3 text-center">
        <p className="font-fm-ui text-fm-control font-medium text-fm-accent">Workspace</p>
        <h1 className="font-fm-ui text-2xl font-semibold tracking-tight text-fm-primary">Create a simulation</h1>
        <p className="text-fm-secondary">Start with an empty FDM or FEM problem. Configure its model and execution after creation.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" onClick={openNewProblem}>Create simulation</Button>
          <Button
            disabled={!projectCommandEnabled("workspace.new-project")}
            type="button"
            variant="secondary"
            onClick={() => runProjectCommand("workspace.new-project", { name: "Untitled project" })}
          >
            New project
          </Button>
          <Button
            disabled={!projectCommandEnabled("workspace.open-project")}
            type="button"
            variant="secondary"
            onClick={() => runProjectCommand("workspace.open-project")}
          >
            Open project
          </Button>
          <Button
            disabled={!projectCommandEnabled("workspace.save-project")}
            type="button"
            variant="ghost"
            onClick={() => runProjectCommand("workspace.save-project")}
          >
            Save project
          </Button>
        </div>
      </section>
    </main>
  );
}
