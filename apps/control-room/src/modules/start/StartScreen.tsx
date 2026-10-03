"use client";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useProjectDocumentSnapshot } from "@/kernel/persistence/ProjectDocumentStatus";

import { LaunchTiles } from "./home/LaunchTiles";
import { useStartSection } from "./model/startScreenState";
import { StartRail } from "./rail/StartRail";
import { SectionHeader } from "./ui/SectionHeader";

const PLACEHOLDER: Record<string, string> = {
  templates: "Templates arrive with the recent-project index.",
  import: "Model import arrives with the host import API.",
  learn: "Documentation and release notes arrive in a later step.",
};

/**
 * Start screen (Step 1): rail + launch tiles. The recent list, inspector and
 * continue card need the host recent-index API and land in later steps.
 */
export function StartScreen() {
  const kernel = useKernel();
  useProjectDocumentSnapshot();
  const section = useStartSection();
  const context = createCommandContext("menu", kernel, { sourceDetail: "start-screen" });
  const run = (commandId: string, input?: unknown) => {
    void kernel.commands.execute(commandId, context, input);
  };
  const isEnabled = (commandId: string) => kernel.commands.isEnabled(commandId, context);

  return (
    <main
      className="grid min-h-0 flex-1 grid-cols-[var(--fm-start-rail-width)_minmax(0,1fr)] max-[940px]:grid-cols-[56px_minmax(0,1fr)]"
      data-state="no-session"
      id="fm-main-content"
      tabIndex={-1}
    >
      <StartRail section={section} />
      <div className="min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[var(--fm-start-content-max)] px-fm-6 pb-fm-12 pt-fm-6">
          <h1 className="font-fm-ui font-semibold text-fm-primary" style={{ fontSize: "var(--fm-start-title-size)" }}>
            {section === "home" ? "Start" : section[0]!.toUpperCase() + section.slice(1)}
          </h1>
          {section === "home" ? (
            <section aria-labelledby="start-launch" className="mt-fm-4">
              <SectionHeader id="start-launch">Create or open</SectionHeader>
              <LaunchTiles isEnabled={isEnabled} onCommand={run} />
            </section>
          ) : (
            <p className="mt-fm-4 text-fm-secondary">{PLACEHOLDER[section]}</p>
          )}
        </div>
      </div>
    </main>
  );
}
