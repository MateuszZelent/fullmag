import type { CommandContribution } from "@/kernel/commands/commandTypes";

import { setStartSection } from "./startScreenState";
import type { StartSection } from "./types";

function sectionCommand(
  section: Exclude<StartSection, "settings" | "about">,
  title: string,
  shortcut: string,
): CommandContribution {
  return {
    id: `start.section.${section}`,
    title: `Start: ${title}`,
    group: "workspace",
    category: "Start",
    scope: "global",
    shortcut,
    run: () => {
      setStartSection(section);
      return { status: "completed" };
    },
  };
}

/**
 * Commands owned by the start screen. New/Open reuse the existing
 * workspace.new-problem / workspace.open-project commands (and their
 * Ctrl+N / Ctrl+O shortcuts) rather than duplicating them.
 */
export const START_COMMANDS: CommandContribution[] = [
  sectionCommand("home", "Home", "Ctrl+1"),
  sectionCommand("templates", "Templates", "Ctrl+2"),
  sectionCommand("import", "Import", "Ctrl+3"),
  sectionCommand("learn", "Learn", "Ctrl+4"),
  {
    id: "start.new-fdm",
    title: "New FDM Simulation",
    group: "workspace",
    category: "Start",
    scope: "global",
    run: (ctx) => {
      ctx.bus?.emit("workspace:new-problem-requested", { source: "workspace" });
      return { status: "completed" };
    },
  },
  {
    id: "start.new-fem",
    title: "New FEM Simulation",
    group: "workspace",
    category: "Start",
    scope: "global",
    run: (ctx) => {
      ctx.bus?.emit("workspace:new-problem-requested", { source: "workspace" });
      return { status: "completed" };
    },
  },
];
