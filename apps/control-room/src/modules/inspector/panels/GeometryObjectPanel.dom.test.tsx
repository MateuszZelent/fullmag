import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { GeometryObjectPanel } from "./GeometryObjectPanel";

const mocks = vi.hoisted(() => ({
  commitTransaction: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  sceneResource: {
    data: { objects: [] as unknown[], revision: 12 },
    error: null as Error | null,
    revision: 12,
    status: "ready",
  },
  select: vi.fn(),
  publishCommittedScene: vi.fn(),
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
    publishCommittedSceneResource: mocks.publishCommittedScene,
    useGeometryValidationResource: () => ({ data: null, status: "ready" }),
    useSceneResource: () => ({ ...mocks.sceneResource, refetch: mocks.refetch }),
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
    mocks.commitTransaction.mockReset();
    mocks.sceneResource.data = { objects: [], revision: 12 };
    mocks.sceneResource.error = null;
    mocks.sceneResource.revision = 12;
    mocks.sceneResource.status = "ready";
    mocks.refetch.mockImplementation(() => undefined);
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
      await act(async () => changeInput(container, "Size X", "2.5e-7"));
      await act(async () => findButton(container, "Apply Draft").click());
      expect(mocks.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          base_revision: 12,
          geometry: expect.objectContaining({ geometry_params: { size: [2.5e-7, 1e-7, 1e-8] } }),
          kind: "create_object",
          name: "New box",
        }),
      );
      expect(findButton(container, "Retry Apply").disabled).toBe(true);

      await act(async () => findButton(container, "Refetch Scene").click());
      expect(mocks.refetch).toHaveBeenCalledOnce();
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);

      mocks.sceneResource.status = "loading";
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(true);

      mocks.sceneResource.data = { objects: [], revision: 13 };
      mocks.sceneResource.revision = 13;
      mocks.sceneResource.status = "ready";
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Rebase Draft").disabled).toBe(false);
      await act(async () => findButton(container, "Rebase Draft").click());
      await act(async () => findButton(container, "Retry Apply").click());

      expect(mocks.commitTransaction).toHaveBeenCalledTimes(2);
      expect(mocks.commitTransaction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          base_revision: 13,
          geometry: expect.objectContaining({ geometry_params: { size: [2.5e-7, 1e-7, 1e-8] } }),
          kind: "create_object",
          name: "New box",
        }),
      );
      expect(mocks.publishCommittedScene).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revision: 14 }),
        14,
        undefined,
        false,
      );
      expect(mocks.invalidate).toHaveBeenCalledTimes(7);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps rebase locked when refetch ends in an error", async () => {
    mocks.commitTransaction.mockRejectedValueOnce(
      new ControlRoomApiError("scene changed", 409, "request-2", "revision_conflict"),
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => findButton(container, "Apply Draft").click());
      await act(async () => findButton(container, "Refetch Scene").click());
      mocks.sceneResource.status = "loading";
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      mocks.sceneResource.status = "error";
      mocks.sceneResource.error = new Error("network unavailable");
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));

      expect(findButton(container, "Rebase Draft").disabled).toBe(true);
      expect(container.textContent).toContain("network unavailable");
      expect(mocks.commitTransaction).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed and sends no request when the scene revision is unavailable", async () => {
    mocks.sceneResource.data = { objects: [] } as never;
    mocks.sceneResource.revision = null as never;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      expect(findButton(container, "Apply Draft").disabled).toBe(true);
      expect(mocks.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("sends no request for an invalid primitive dimension", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<GeometryObjectPanel selection={selection} />));
      await act(async () => changeInput(container, "Size X", "0"));
      await act(async () => findButton(container, "Apply Draft").click());

      expect(mocks.commitTransaction).not.toHaveBeenCalled();
      expect(container.textContent).toContain("greater than 0");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function changeInput(root: TestNode, label: string, value: string): void {
  const input = findElements(root, (element) =>
    element.tagName === "INPUT" && element.getAttribute("aria-label") === label)[0];
  if (!input) throw new Error(`Missing input ${label}`);
  input.value = value;
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
}

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
