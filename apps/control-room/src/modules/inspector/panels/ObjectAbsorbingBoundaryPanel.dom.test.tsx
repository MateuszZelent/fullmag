import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  getSessionScopeKey: vi.fn(() => "session=A&epoch=1" as string | null),
  historyGeneration: 0,
  invalidate: vi.fn(),
  patchObject: vi.fn(),
  readScene: vi.fn(),
  recordHistory: vi.fn(),
  sceneData: { objects: [{ id: "object-a" }], revision: 10 },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObject: mocks.patchObject,
        scene: mocks.readScene,
      },
    },
    authoringHistory: {
      getGeneration: () => mocks.historyGeneration,
      record: mocks.recordHistory,
    },
    commands: { getSessionScopeKey: mocks.getSessionScopeKey },
    resources: { invalidate: mocks.invalidate },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...original,
    useSceneResource: () => ({ data: mocks.sceneData, status: "ready" }),
  };
});

import { ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";

describe("ObjectAbsorbingBoundaryPanel session fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionScopeKey.mockReturnValue("session=A&epoch=1");
    mocks.historyGeneration = 0;
    mocks.sceneData = { objects: [{ id: "object-a" }], revision: 10 };
    mocks.readScene.mockResolvedValue({
      objects: [{ id: "object-a" }],
      revision: 10,
      scene_revision: 10,
    });
    mocks.patchObject.mockResolvedValue({
      committed_scene: {
        objects: [{ id: "object-a" }],
        revision: 11,
        scene_revision: 11,
      },
      revision: 11,
      scene_revision: 11,
    });
  });

  it("pins the revisioned write and history read to the active session", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => findButton(container, "Apply boundary").click());

      expect(mocks.readScene).toHaveBeenCalledWith({
        sessionScopeKey: "session=A&epoch=1",
      });
      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        { base_revision: 10, absorbing_boundary: null },
        { baseRevision: 10, sessionScopeKey: "session=A&epoch=1" },
      );
      expect(mocks.recordHistory).toHaveBeenCalledOnce();
      expect(mocks.invalidate).toHaveBeenCalledWith(expect.any(String), 11);
      expect(container.textContent).toContain("Absorbing boundary updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not publish history or resource effects after the session changes before ACK", async () => {
    let finishPatch: ((value: unknown) => void) | null = null;
    const patchResult = new Promise((resolve) => {
      finishPatch = resolve;
    });
    mocks.patchObject.mockReturnValue(patchResult);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => {
        findButton(container, "Apply boundary").click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.patchObject).toHaveBeenCalledWith(
        "object-a",
        expect.objectContaining({ base_revision: 10 }),
        expect.objectContaining({ sessionScopeKey: "session=A&epoch=1" }),
      );
      mocks.getSessionScopeKey.mockReturnValue("session=B&epoch=2");
      mocks.historyGeneration += 1;
      await act(async () => {
        finishPatch?.({
          committed_scene: {
            objects: [{ id: "object-a" }],
            revision: 11,
            scene_revision: 11,
          },
          revision: 11,
          scene_revision: 11,
        });
        await patchResult;
      });

      expect(mocks.recordHistory).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("Absorbing boundary updated.");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fails closed until the active session identity is available", async () => {
    mocks.getSessionScopeKey.mockReturnValue(null);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <ObjectAbsorbingBoundaryPanel objectId="object-a" baseRevision={10} />,
      ));
      await act(async () => findButton(container, "Apply boundary").click());

      expect(mocks.readScene).not.toHaveBeenCalled();
      expect(mocks.patchObject).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Session identity is not ready");
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

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}
