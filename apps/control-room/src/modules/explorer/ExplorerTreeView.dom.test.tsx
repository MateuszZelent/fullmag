import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { SIMULATION_STAGES_EXECUTION_PATH } from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import type { ExplorerNode } from "./explorerTypes";
import { ExplorerTreeView } from "./ExplorerTreeView";

const interaction = vi.hoisted(() => ({
  menuVisible: false,
  select: vi.fn(),
  setKeyboardRow: vi.fn(),
  toggle: vi.fn(),
}));

vi.mock("./explorerSelection", () => ({
  selectExplorerNode: interaction.select,
}));

vi.mock("./explorerStore", () => ({
  setExplorerKeyboardRow: interaction.setKeyboardRow,
  toggleExplorerNode: interaction.toggle,
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useCommandDetailResource: () => null,
  useRuntimeCommandControlResourceData: () => ({}),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({ data: null }),
}));

vi.mock("@/shared/runtime/CommandDetailDialog", () => ({
  CommandDetailDialog: () => null,
}));

vi.mock("@/shared/ui/Tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

vi.mock("@/shared/ui/ContextMenu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => children,
  ContextMenuContent: ({ children }: { children: ReactNode }) => interaction.menuVisible ? children : null,
  ContextMenuItem: ({ children, disabled, onSelect, title }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    title?: string;
  }) => <button type="button" disabled={disabled} onClick={onSelect} title={title}>{children}</button>,
  ContextMenuLabel: () => null,
  ContextMenuSeparator: () => null,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

class LeftPointerDownEvent extends TestEvent {
  readonly button = 0;

  constructor() {
    super("pointerdown", { bubbles: true });
  }
}

const nodes: ExplorerNode[] = [
  {
    id: "selected-mode",
    kind: "results.resonance.modal.mode",
    label: "Selected mode",
    parentId: null,
    children: [
      {
        id: "mode-provenance",
        kind: "results.resonance.modal.provenance",
        label: "Mode provenance",
        parentId: "selected-mode",
      },
    ],
  },
];

describe("ExplorerTreeView context menu", () => {
  it("updates the clicked stage readiness and rejects an old menu after a workspace switch", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const commands = new CommandRegistry();
    let scope: string | null = "workspace-a";
    const subscribers = new Set<() => void>();
    commands.attachSessionScopeSource({
      getScopeKey: () => scope,
      subscribe: (listener) => {
        subscribers.add(listener);
        return () => { subscribers.delete(listener); };
      },
    });
    const run = vi.fn((_context: CommandContext) => ({ status: "completed" as const }));
    const ready = (context: CommandContext) =>
      context.resourceData?.[SIMULATION_STAGES_EXECUTION_PATH] != null;
    commands.register({
      id: "test.run-stage",
      title: "Run This Stage",
      scope: "runtime",
      group: "study-runtime",
      isEnabled: ready,
      disabledReason: (context) => ready(context) ? null : "Waiting for stage execution.",
      run,
    });
    const kernel = { commands } as KernelApi;
    const stages: ExplorerNode[] = [
      {
        id: "selected", parentId: null, kind: "study.stage.run", label: "Selected stage",
      },
      {
        id: "clicked", parentId: null, kind: "study.stage.relax", label: "Clicked stage",
        contextCommands: ["test.run-stage"],
        contextCommandInputs: { "test.run-stage": { stageId: "relax-clicked" } },
      },
    ];
    const execution = { run_id: "held-study" };
    const renderTree = (stageExecution: typeof execution | null) =>
      <ExplorerTreeView
        activeNodeId="selected"
        expandedIds={new Set()}
        keyboardRowId={null}
        kernel={kernel}
        moduleId="explorer"
        nodes={stages}
        sceneResourceData={null}
        sharedCommandResources={{ [SIMULATION_STAGES_EXECUTION_PATH]: stageExecution }}
        tabId="model"
      />;
    const item = () => findElement(container, (element) =>
      element.tagName === "BUTTON" && element.textContent === "Run This Stage", "Run This Stage");

    interaction.menuVisible = true;
    try {
      await act(async () => root.render(renderTree(null)));
      expect(item().disabled).toBe(true);
      expect(item().getAttribute("title")).toBe("Waiting for stage execution.");

      await act(async () => root.render(renderTree(execution)));
      expect(item().disabled).toBe(false);
      await act(async () => item().click());
      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith(expect.objectContaining({
        input: { stageId: "relax-clicked" },
        sessionScopeKey: "workspace-a",
        resourceData: expect.objectContaining({ [SIMULATION_STAGES_EXECUTION_PATH]: execution }),
      }));
      expect(interaction.select).not.toHaveBeenCalled();

      // Dispatch the old callback before React observes the scope switch.
      await act(async () => {
        scope = "workspace-b";
        item().click();
        for (const notify of subscribers) notify();
      });
      expect(run).toHaveBeenCalledOnce();
      expect(item().disabled).toBe(true);
      expect(item().getAttribute("title")).toContain("Reopen the context menu");

      // A new menu can use the new workspace once its resources are ready.
      interaction.menuVisible = false;
      await act(async () => root.render(renderTree(null)));
      interaction.menuVisible = true;
      const nextExecution = { run_id: "next-workspace-study" };
      await act(async () => root.render(renderTree(nextExecution)));
      expect(item().disabled).toBe(false);
      await act(async () => item().click());
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1][0].sessionScopeKey).toBe("workspace-b");
      expect(run.mock.calls[1][0].resourceData?.[SIMULATION_STAGES_EXECUTION_PATH]).toBe(nextExecution);
    } finally {
      interaction.menuVisible = false;
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe("ExplorerTreeView branch interaction", () => {
  it("toggles an SVG or empty branch target without changing the selected mode", async () => {
    const dom = installSimulationPreparationTestDom();
    const originalCreateElement = dom.document.createElement.bind(dom.document);
    const originalClosest = Object.getOwnPropertyDescriptor(
      TestElement.prototype,
      "closest",
    );
    class HtmlTestElement extends TestElement {}

    // Keep SVG elements in the Element set but outside HTMLElement, as in browsers.
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      value: HtmlTestElement,
      writable: true,
    });
    if (dom.document.defaultView) {
      dom.document.defaultView.HTMLElement = HtmlTestElement;
    }
    dom.document.createElement = (tagName: string) =>
      new HtmlTestElement(dom.document, tagName);
    Object.defineProperty(TestElement.prototype, "closest", {
      configurable: true,
      value(this: TestElement, selector: string) {
        if (this.matches(selector)) return this;
        let current: TestElement | null = this.parentNode instanceof TestElement
          ? this.parentNode
          : null;
        while (current) {
          if (current.matches(selector)) return current;
          current = current.parentNode instanceof TestElement
            ? current.parentNode
            : null;
        }
        return null;
      },
    });

    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    let expandedIds = new Set<string>();
    const renderTree = () => (
      <ExplorerTreeView
        activeNodeId="selected-mode"
        expandedIds={expandedIds}
        keyboardRowId={null}
        kernel={{} as KernelApi}
        moduleId="explorer"
        nodes={nodes}
        sceneResourceData={null}
        sharedCommandResources={{}}
        tabId="results"
      />
    );
    interaction.toggle.mockImplementation((_tabId: unknown, nodeId: unknown) => {
      const targetNodeId = String(nodeId);
      const next = new Set(expandedIds);
      if (next.has(targetNodeId)) next.delete(targetNodeId);
      else next.add(targetNodeId);
      expandedIds = next;
      root.render(renderTree());
    });

    function nodeRow(nodeId: string): TestElement {
      return findElement(
        container,
        (element) => element.getAttribute("data-node-id") === nodeId,
        `Explorer row ${nodeId}`,
      );
    }

    function branchArea(): TestElement {
      return findElement(
        nodeRow("selected-mode"),
        (element) =>
          (element.getAttribute("class") ?? "")
            .split(/\s+/)
            .includes("fm-explorer-tree-row__branch"),
        "branch area",
      );
    }

    async function activateBranchTarget(target: TestElement): Promise<void> {
      await act(async () => {
        target.dispatchEvent(new LeftPointerDownEvent());
        target.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
    }

    try {
      await act(async () => root.render(renderTree()));
      expect(nodeRow("selected-mode").getAttribute("aria-selected")).toBe("true");
      expect(() => nodeRow("mode-provenance")).toThrow();

      const branchIcon = findElement(
        branchArea(),
        (element) =>
          element.tagName.toLowerCase() === "svg" &&
          element.namespaceURI === "http://www.w3.org/2000/svg",
        "SVG branch icon",
      );
      expect(branchIcon).toBeInstanceOf(Element);
      expect(branchIcon).not.toBeInstanceOf(HTMLElement);

      await activateBranchTarget(branchIcon);
      expect(interaction.toggle).toHaveBeenNthCalledWith(1, "results", "selected-mode");
      expect(nodeRow("mode-provenance")).toBeDefined();
      expect(nodeRow("selected-mode").getAttribute("aria-selected")).toBe("true");

      await activateBranchTarget(branchArea());
      expect(interaction.toggle).toHaveBeenNthCalledWith(2, "results", "selected-mode");
      expect(() => nodeRow("mode-provenance")).toThrow();
      expect(nodeRow("selected-mode").getAttribute("aria-selected")).toBe("true");
      expect(interaction.select).not.toHaveBeenCalled();
      expect(interaction.setKeyboardRow).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.document.createElement = originalCreateElement;
      if (originalClosest) {
        Object.defineProperty(TestElement.prototype, "closest", originalClosest);
      } else {
        Reflect.deleteProperty(TestElement.prototype, "closest");
      }
      dom.restore();
    }
  });
});
