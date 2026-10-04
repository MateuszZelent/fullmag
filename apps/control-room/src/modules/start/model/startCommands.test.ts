import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { findShortcutCommand } from "@/kernel/commands/commandShortcuts";
import { isProjectWorkspaceCommand } from "@/kernel/commands/projectWorkspaceCommandPolicy";
import { homeView } from "@/kernel/layout/homeView";
import { SHELL_COMMANDS } from "@/kernel/layout/shellCommands";

import { START_COMMANDS, startActionDisabledReason } from "./startCommands";
import { startScreenStore, type StartScreenHost } from "./startScreenState";

// Present but idle: every capability query (canSave, canClose, …) answers false.
const IDLE_PROJECT_DOCUMENT = new Proxy({}, { get: () => () => false });
const WITH_PROJECTS = {
  projectDocument: IDLE_PROJECT_DOCUMENT,
  source: "test",
} as unknown as CommandContext;
const WITHOUT_PROJECTS = { source: "test" } as unknown as CommandContext;

function registryWithShellAndStart(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of SHELL_COMMANDS) registry.register(command);
  for (const command of START_COMMANDS) registry.register(command);
  return registry;
}

function hostFor(
  registry: CommandRegistry,
  createProblemDisabledReason: string | null = null,
): StartScreenHost {
  return {
    createProblemDisabledReason,
    disabledReason: (id, context) => registry.get(id)?.disabledReason?.(context) ?? null,
    execute: (id, context) => registry.execute(id, context),
    isEnabled: (id, context) => registry.isEnabled(id, context),
  };
}

afterEach(() => {
  startScreenStore.resetForTests();
});

describe("start commands", () => {
  it("are all allowed by the no-session command policy", () => {
    for (const command of START_COMMANDS) {
      expect(isProjectWorkspaceCommand(command.id), command.id).toBe(true);
    }
  });

  it("are disabled with a reason while the start screen is not showing", () => {
    const registry = registryWithShellAndStart();
    // The workspace.* Help commands open the start screen themselves, so they
    // are available everywhere; only the start.* commands need it showing.
    for (const command of START_COMMANDS.filter((c) => c.id.startsWith("start."))) {
      expect(registry.isEnabled(command.id, WITH_PROJECTS), command.id).toBe(false);
      expect(command.disabledReason?.(WITH_PROJECTS)).toBe("The start screen is not showing.");
    }
  });

  it("opens documentation, the reference and About from Help without the start screen showing", async () => {
    const registry = registryWithShellAndStart();
    for (const id of ["workspace.search-docs", "workspace.reference", "workspace.about-help"]) {
      expect(registry.isEnabled(id, WITH_PROJECTS), id).toBe(true);
    }

    await registry.execute("workspace.reference", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot()).toMatchObject({
      section: "docs",
      docsRequest: { seq: 1, page: "python-api/index.html" },
    });

    await registry.execute("workspace.search-docs", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().docsRequest).toEqual({ seq: 2, page: "index.html" });

    await registry.execute("workspace.about-help", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().section).toBe("about");
    homeView.resetForTests();
  });

  it("opens the recent list only from the Home section", async () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry));

    expect(registry.isEnabled("start.open-recent", WITH_PROJECTS)).toBe(true);
    await registry.execute("start.open-recent", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().focusListNonce).toBe(1);

    startScreenStore.setSection("learn");
    expect(registry.isEnabled("start.open-recent", WITH_PROJECTS)).toBe(false);
  });

  it("navigates sections through the store", async () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry));

    await registry.execute("start.templates", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().section).toBe("templates");
    await registry.execute("start.section.home", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().section).toBe("home");
  });

  it("acts on the selected project only when one is selected", async () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry));

    expect(registry.isEnabled("start.pin-selected", WITH_PROJECTS)).toBe(false);
    expect(registry.get("start.pin-selected")?.disabledReason?.(WITH_PROJECTS)).toBe(
      "Select a project or script in the list first.",
    );

    startScreenStore.setSelectedProject("p1");
    expect(registry.isEnabled("start.pin-selected", WITH_PROJECTS)).toBe(true);
    await registry.execute("start.pin-selected", WITH_PROJECTS);
    await registry.execute("start.remove-selected", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().selectionAction).toEqual({ seq: 2, kind: "remove" });
  });

  it("also acts on a selected script", async () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry));

    startScreenStore.setSelectedScript(4);
    expect(registry.isEnabled("start.open-selected", WITH_PROJECTS)).toBe(true);
    await registry.execute("start.open-selected", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().selectionAction).toEqual({ seq: 1, kind: "open" });
  });

  it("registers start.open-script, allowed with no session and available only with a desktop shell", async () => {
    const registry = registryWithShellAndStart();
    expect(START_COMMANDS.map((c) => c.id)).toContain("start.open-script");
    expect(isProjectWorkspaceCommand("start.open-script")).toBe(true);

    // Not showing: disabled with the usual reason.
    expect(registry.isEnabled("start.open-script", WITH_PROJECTS)).toBe(false);
    expect(registry.get("start.open-script")?.disabledReason?.(WITH_PROJECTS)).toBe(
      "The start screen is not showing.",
    );

    // Showing in a browser: the picker needs the desktop shell, and says so.
    const browserHost = { ...hostFor(registry), openScriptDisabledReason: "Opening a script needs the desktop app." };
    startScreenStore.attach(browserHost);
    expect(registry.isEnabled("start.open-script", WITH_PROJECTS)).toBe(false);
    expect(startActionDisabledReason("start.open-script", browserHost, WITH_PROJECTS)).toBe(
      "Opening a script needs the desktop app.",
    );
    expect((await registry.execute("start.open-script", WITH_PROJECTS)).status).toBe("failed");
    expect(startScreenStore.getSnapshot().openScriptNonce).toBe(0);

    // Showing in the desktop shell: a distinct request per run.
    startScreenStore.attach({ ...hostFor(registry), openScriptDisabledReason: null });
    expect(registry.isEnabled("start.open-script", WITH_PROJECTS)).toBe(true);
    await registry.execute("start.open-script", WITH_PROJECTS);
    await registry.execute("start.open-script", WITH_PROJECTS);
    expect(startScreenStore.getSnapshot().openScriptNonce).toBe(2);
  });

  it("delegates new simulations to workspace.new-problem with the solver", async () => {
    const registry = registryWithShellAndStart();
    const emit = vi.fn();
    startScreenStore.attach(hostFor(registry));

    await registry.execute("start.new-fem", { ...WITH_PROJECTS, bus: { emit } } as unknown as CommandContext);

    expect(emit).toHaveBeenCalledWith("workspace:new-problem-requested", {
      solver: "FEM",
      source: "workspace",
    });
  });

  it("reports why a new simulation cannot start without confirmed session absence", () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry, "Session list unavailable."));

    expect(registry.isEnabled("start.new-fdm", WITH_PROJECTS)).toBe(false);
    expect(startActionDisabledReason("start.new-fdm", startScreenStore.getSnapshot().host, WITH_PROJECTS))
      .toBe("Session list unavailable.");
    // Navigation and browsing do not depend on the session list.
    expect(registry.isEnabled("start.templates", WITH_PROJECTS)).toBe(true);
    expect(registry.isEnabled("start.browse", WITH_PROJECTS)).toBe(true);
  });

  it("carries the open-project disabled reason through to Browse", () => {
    const registry = registryWithShellAndStart();
    startScreenStore.attach(hostFor(registry));

    expect(registry.isEnabled("start.browse", WITHOUT_PROJECTS)).toBe(false);
    expect(registry.get("start.browse")?.disabledReason?.(WITHOUT_PROJECTS)).toBe(
      "Project document lifecycle is unavailable in this shell.",
    );
  });

  it("wins the shared File shortcuts only while the start screen is showing", () => {
    const registry = registryWithShellAndStart();
    const enabled = () => registry.all().filter((command) => registry.isEnabled(command.id, WITH_PROJECTS));
    const pick = (event: { key: string; shiftKey?: boolean }) =>
      findShortcutCommand(enabled(), { ctrlKey: true, ...event })?.id;

    expect(pick({ key: "n" })).toBe("workspace.new-problem");
    expect(pick({ key: "N", shiftKey: true })).toBe("workspace.new-project");
    expect(pick({ key: "o" })).toBe("workspace.open-project");

    const detach = startScreenStore.attach(hostFor(registry));
    expect(pick({ key: "n" })).toBe("start.new-fdm");
    expect(pick({ key: "N", shiftKey: true })).toBe("start.new-fem");
    expect(pick({ key: "o" })).toBe("start.browse");
    expect(pick({ key: "3" })).toBe("start.section.import");
    expect(pick({ key: "," })).toBe("start.section.settings");

    detach();
    expect(pick({ key: "N", shiftKey: true })).toBe("workspace.new-project");
  });
});
