import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataPreviewDialog } from "./DataPreviewDialog";
import { installSimulationPreparationTestDom, TestElement, type TestNode } from "./simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), revision: "rev-123" }));
vi.mock("@/shared/browser/copyTextToClipboard", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/shared/ui/DraggablePanel", () => ({
  DraggablePanel: ({ children, headerActions }: { children: ReactNode; headerActions: ReactNode }) => (
    <section>{headerActions}{children}</section>
  ),
}));
vi.mock("@/kernel/resources/dataPreviewResources", () => ({
  useDataPreviewFieldVector: () => ({
    resource: {
      data: { pointCount: 1, nComp: 3, valueCount: 3, values: new Float32Array([1, 0, 0]), grid: [1, 1, 1] },
      error: null, refetch: vi.fn(), revision: mocks.revision, status: "ready",
    },
    resourceKey: "session-a:data-preview:m", resourceRevision: mocks.revision,
  }),
}));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useQuantityCatalogResource: () => ({ data: { quantities: [] } }),
  useFieldCatalogResource: () => ({ data: { quantities: [] } }),
  useSolverStatusResource: () => ({ data: { step_index: 123, sim_time_seconds: 0, revision: 54 } }),
}));

describe("Data Preview clipboard", () => {
  beforeEach(() => { mocks.copy.mockReset(); mocks.revision = "rev-123"; });

  it("copies the rendered resource log and waits before reporting success", async () => {
    let acknowledge!: () => void;
    mocks.copy.mockReturnValue(new Promise<void>((resolve) => { acknowledge = resolve; }));
    const harness = await mountPreview();
    try {
      await act(async () => harness.button().click());
      expect(harness.button().disabled).toBe(true);
      expect(harness.button().getAttribute("title")).toBe("Copying…");
      const log = mocks.copy.mock.calls[0]?.[0];
      expect(log).toContain("=== Data Preview ===");
      expect(log).toContain("Quantity: m");
      expect(log).toContain("Revision: rev-123");
      expect(log).toContain("Shape: 1 points x 3");
      expect(log).toContain("[Data]\n#\tsource\tvalues");
      expect(log).toContain("[Resource]\nsession-a:data-preview:m");
      await act(async () => { acknowledge(); await Promise.resolve(); });
      expect(harness.button().disabled).toBe(false);
      expect(harness.button().getAttribute("title")).toBe("Copied!");
      mocks.revision = "rev-124";
      await harness.render();
      expect(harness.button().getAttribute("title")).toBe("Copy log to clipboard");
    } finally { await harness.dispose(); }
  });

  it("shows an accessible failure and permits another attempt", async () => {
    mocks.copy.mockRejectedValue(new Error("Clipboard permission denied"));
    const harness = await mountPreview();
    try {
      await act(async () => { harness.button().click(); await Promise.resolve(); });
      expect(harness.button().disabled).toBe(false);
      expect(harness.button().getAttribute("title")).toBe("Copy log to clipboard");
      expect(findElement(harness.container, (element) => element.getAttribute("role") === "alert").textContent).toContain("Could not copy");
      mocks.copy.mockResolvedValue(undefined);
      await act(async () => { harness.button().click(); await Promise.resolve(); });
      expect(harness.button().getAttribute("title")).toBe("Copied!");
    } finally { await harness.dispose(); }
  });
});

async function mountPreview() {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const render = async () => {
    await act(async () => root.render(<DataPreviewDialog open onOpenChange={vi.fn()} />));
  };
  await render();
  return {
    container, render,
    button: () => findElement(container, (element) => element.getAttribute("aria-label") === "Copy data preview log"),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

function findElement(root: TestNode, predicate: (element: TestElement) => boolean): TestElement {
  const visit = (node: TestNode): TestElement | null => {
    if (node instanceof TestElement && predicate(node)) return node;
    for (const child of node.childNodes) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const found = visit(root);
  if (!found) throw new Error("Missing Data Preview control.");
  return found;
}
