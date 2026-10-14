import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/shared/ui/ContextMenu", () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => children,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
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
