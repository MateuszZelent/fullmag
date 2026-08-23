import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { GeometryObjectPanel } from "./GeometryObjectPanel";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  scene: { objects: [] as unknown[], revision: 12 },
  select: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: { model: { commitTransaction: mocks.commitTransaction } },
    resources: { invalidate: mocks.invalidate },
    selection: { set: mocks.select },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>();
  return {
    ...original,
    publishCommittedSceneResource: vi.fn(),
    useGeometryValidationResource: () => ({ data: null, status: "ready" }),
    useSceneResource: () => ({ data: mocks.scene, refetch: mocks.refetch }),
  };
});

const selection: Selection = {
  kind: "builder.primitive",
  label: "New box",
  moduleSource: "test",
  nodeId: "geometry:draft:box",
  objectId: null,
  ref: null,
};

describe("GeometryObjectPanel primitive transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scene.objects = [];
    mocks.scene.revision = 12;
    mocks.refetch.mockImplementation(async () => {
      mocks.scene = { objects: [], revision: 13 };
    });
  });

  it("requires refetch and rebase after 409 before issuing one retry", async () => {
    mocks.commitTransaction
      .mockRejectedValueOnce(
        new ControlRoomApiError("scene changed", 409, "request-1", "revision_conflict"),
      )
      .mockResolvedValueOnce({
        committed_scene: { objects: [{ id: "dirty-box" }], revision: 14 },
        scene_revision: 14,
      });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => findButton(container, "Apply Draft").click());
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({ base_revision: 12, kind: "create_object", name: "New box" }),
      );
      expect(findButton(container, "Retry Apply").disabled).toBe(true);

      await act(async () => findButton(container, "Refetch Scene").click());
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(false);
      await act(async () => findButton(container, "Rebase Draft").click());
      await act(async () => findButton(container, "Retry Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({ base_revision: 13, kind: "create_object", name: "New box" }),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
