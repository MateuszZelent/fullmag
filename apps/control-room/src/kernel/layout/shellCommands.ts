import { requestThemeToggle } from "@/design/theme/themeEvents";

import type { CommandContribution } from "../commands/commandTypes";

export const SHELL_COMMANDS: CommandContribution[] = [
  {
    id: "workspace.theme-toggle",
    title: "Toggle Theme",
    group: "workspace",
    category: "Window",
    scope: "global",
    shortcut: "Ctrl+Shift+T",
    run: () => {
      requestThemeToggle();
      return { status: "completed" };
    },
  },
];
