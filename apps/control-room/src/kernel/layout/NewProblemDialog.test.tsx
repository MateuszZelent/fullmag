import { describe, expect, it } from "vitest";

import { MAIN_MENUS } from "./appMenuModel";
import { SHELL_COMMANDS } from "./shellCommands";

describe("New Problem entry command", () => {
  it("keeps New Problem visible and executable from the shared File menu", () => {
    const fileMenu = MAIN_MENUS.find((menu) => menu.id === "file");
    const menuEntry = fileMenu?.children?.find(
      (entry) => entry.id === "workspace.new-problem",
    );
    const command = SHELL_COMMANDS.find(
      (entry) => entry.id === "workspace.new-problem",
    );

    expect(menuEntry).toMatchObject({ label: "New Problem", shortcut: "Ctrl+N" });
    expect(command?.isEnabled).toBeUndefined();
  });
});
