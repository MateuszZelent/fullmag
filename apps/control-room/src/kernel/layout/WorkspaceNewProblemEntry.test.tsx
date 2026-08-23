import {
  act,
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/CommandRegistry";
import { createCommandContext } from "../commands/commandContext";
import { dispatchShortcutCommand } from "../commands/commandShortcuts";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "../resources/ResourceRuntimeStore";
import type { KernelApi } from "../types";
import { appMenuManifest } from "@/modules/app-menu/manifest";
import AppMenuModule from "@/modules/app-menu/AppMenuModule";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
} from "./simulationPreparationTestDom.test-support";
import { SHELL_COMMANDS } from "./shellCommands";
import { WorkspaceShellClient } from "./WorkspaceShellClient";

vi.mock("@/design/theme/ThemeProvider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: ComponentProps<"section">) => (
    <section role="dialog" {...props}>{children}</section>
  ),
  DialogDescription: (props: ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: ComponentProps<"footer">) => <footer {...props} />,
  DialogHeader: (props: ComponentProps<"header">) => <header {...props} />,
  DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
}));

vi.mock("@/shared/ui/DropdownMenu", () => {
  const OpenContext = createContext<(() => void) | null>(null);
  const VisibilityContext = createContext(false);
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = useState(false);
      return (
        <OpenContext.Provider value={() => setOpen(true)}>
          <VisibilityContext.Provider value={open}>
            {children}
          </VisibilityContext.Provider>
        </OpenContext.Provider>
      );
    },
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => {
      const open = useContext(OpenContext);
      return <span onClick={open ?? undefined}>{children}</span>;
    },
    DropdownMenuContent: ({ children }: { children: ReactNode }) =>
      useContext(VisibilityContext) ? <div role="menu">{children}</div> : null,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    }) => (
      <button disabled={disabled} role="menuitem" type="button" onClick={onSelect}>
        {children}
      </button>
    ),
    DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) => (
      <button aria-checked="false" role="menuitemcheckbox" type="button">
        {children}
      </button>
    ),
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuSub: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

afterEach(() => {
  resetSharedResourceRuntimeStoreForTests();
  vi.restoreAllMocks();
});

describe("confirmed-empty New Problem entry wiring", () => {
  it("opens the dialog through File > New Problem in the registered AppMenu", async () => {
    const mounted = await mountConfirmedEmptyWorkspace();
    try {
      await settle();
      expect(mounted.container.textContent).toContain("Create a simulation");
      expect(mounted.body.textContent).toContain("File");
      expect(findDialogs(mounted.body)).toHaveLength(0);

      await act(async () => findButton(mounted.body, "File").click());
      await settle();
      await act(async () => findMenuItem(mounted.body, "New Problem").click());
      await settle();

      expect(findDialogs(mounted.body)).toHaveLength(1);
      expect(findDialogs(mounted.body)[0]?.textContent).toContain("New Problem");
    } finally {
      await mounted.dispose();
    }
  });

  it("opens the same dialog through the global workspace.new-problem command", async () => {
    const mounted = await mountConfirmedEmptyWorkspace();
    try {
      await settle();
      await act(async () => {
        await mounted.kernel.commands.execute(
          "workspace.new-problem",
          createCommandContext("test", mounted.kernel, {
            sourceDetail: "integration-global-command",
          }),
        );
      });
      await settle();

      expect(findDialogs(mounted.body)).toHaveLength(1);
    } finally {
      await mounted.dispose();
    }
  });

  it("opens the same dialog through the global Ctrl+N shortcut", async () => {
    const mounted = await mountConfirmedEmptyWorkspace();
    try {
      await settle();
      const preventDefault = vi.fn();
      const handled = dispatchShortcutCommand(
        mounted.kernel.commands,
        { ctrlKey: true, key: "n", preventDefault },
        createCommandContext("shortcut", mounted.kernel),
      );
      await settle();

      expect(handled).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(findDialogs(mounted.body)).toHaveLength(1);
    } finally {
      await mounted.dispose();
    }
  });
});

async function mountConfirmedEmptyWorkspace(): Promise<{
  body: TestElement;
  container: TestElement;
  dispose: () => Promise<void>;
  kernel: KernelApi;
}> {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const kernel = makeKernel();
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      <KernelContext.Provider value={kernel}>
        <WorkspaceShellClient />
      </KernelContext.Provider>,
    );
  });
  return {
    body: dom.document.body,
    container,
    kernel,
    dispose: async () => {
      await act(async () => root.unmount());
      dom.restore();
    },
  };
}

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const commands = new CommandRegistry();
  commands.attach(bus);
  for (const command of SHELL_COMMANDS) commands.register(command);
  const modules = new ModuleRegistry();
  modules.register({
    ...appMenuManifest,
    component: async () => ({ default: AppMenuModule }),
  });
  return {
    api: {
      sessions: {
        create: vi.fn(),
        current: { status: vi.fn() },
        list: vi.fn(async () => ({ schema_version: "2.0.0", sessions: [] })),
      },
    },
    bus,
    commands,
    diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
    modules,
    resources: new ResourceInvalidationController(bus),
  } as unknown as KernelApi;
}

function findButton(root: TestElement, text: string): TestElement {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent.trim() === text,
    `${text} button`,
  );
}

function findMenuItem(root: TestElement, text: string): TestElement {
  return findElement(
    root,
    (element) => element.getAttribute("role") === "menuitem" && element.textContent.includes(text),
    `${text} menu item`,
  );
}

function findDialogs(root: TestElement): TestElement[] {
  return findElements(root, (element) => element.getAttribute("role") === "dialog");
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
