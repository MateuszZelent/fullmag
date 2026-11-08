import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

const SESSION_SCOPE = "session=A&epoch=1&request_scope_epoch=1";

const mocks = vi.hoisted(() => {
  const interactionRequest = vi.fn();
  const invalidated = vi.fn();
  const refetch = vi.fn();
  return {
    identity: { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" },
    interactionRequest,
    invalidated,
    resourceLoads: [] as Array<{ resourceKey: string; result?: unknown; error?: unknown }>,
    sceneData: {
      objects: [{
        geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        id: "object-a",
        material_ref: "mat:film",
        name: "Film",
        transform: {
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          translation: [0, 0, 0],
        },
      }],
      materials: [{
        id: "mat:film",
        name: "film material",
        properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 800000, alpha: 0.5 },
      }],
      revision: 10,
      scene_revision: 10,
    } as unknown,
    material: {
      id: "mat:film",
      name: "film material",
      properties: { Aex: 1.3e-11, Dbulk: null, Dind: null, Ms: 800000, alpha: 0.5 },
      scene_revision: 10,
    },
    refetch,
    kernel: {
      api: { model: { objectInteraction: interactionRequest } },
      authoringHistory: { getGeneration: () => 0, record: vi.fn() },
      commands: { getSessionScopeKey: () => "session=A&epoch=1&request_scope_epoch=1" },
      resources: { invalidate: invalidated },
    },
  };
});

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...actual,
    useKernel: () => mocks.kernel,
  };
});

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => mocks.identity,
}));

vi.mock("@/kernel/resources/useResource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/useResource")>();
  const React = await import("react");
  return {
    ...actual,
    useResource: (options: {
      enabled?: boolean;
      load: (context: {
        resourceKey: string;
        sessionScopeKey?: string;
        signal: AbortSignal;
      }) => Promise<unknown>;
      resourceKey: string;
    }) => {
      const { enabled, load, resourceKey } = options;
      React.useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        const record: { resourceKey: string; result?: unknown; error?: unknown } = {
          resourceKey: resourceKey,
        };
        mocks.resourceLoads.push(record);
        void load({
          resourceKey: resourceKey,
          sessionScopeKey: SESSION_SCOPE,
          signal: controller.signal,
        }).then(
          (result) => { record.result = result; },
          (error: unknown) => { record.error = error; },
        );
        return () => controller.abort();
      }, [enabled, load, resourceKey]);
      return {
        data: null,
        error: null,
        refetch: mocks.refetch,
        revision: null,
        status: enabled ? "loading" : "idle",
      } as never;
    },
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  return {
    ...actual,
    useMaterialResource: () => ({
      data: mocks.material,
      error: null,
      refetch: mocks.refetch,
      revision: 10,
      status: "ready",
    }),
    useSceneResource: () => ({
      data: mocks.sceneData,
      error: null,
      refetch: mocks.refetch,
      revision: 10,
      status: "ready",
    }),
  };
});

vi.mock("./ObjectAbsorbingBoundaryPanel", () => ({
  ObjectAbsorbingBoundaryPanel: () => null,
}));

import { ObjectMaterialPanel } from "./ObjectMaterialPanel";

function selection(kind: "object.material" | "object.root"): Selection {
  const nodeId = kind === "object.material"
    ? "model:object:object-a:magnetic-parameters:material"
    : "model:object:object-a";
  return {
    kind,
    label: kind === "object.material" ? "Material: film material" : "Film",
    moduleSource: "explorer",
    nodeId,
    objectId: "object-a",
    ref: {
      kind,
      nodeId,
      objectId: "object-a",
      type: "scene-object",
      visualizationTargetId: "object:object-a",
    },
  };
}

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return found;
}

describe("ObjectMaterialPanel lazy optional-interaction loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resourceLoads.length = 0;
    mocks.interactionRequest.mockImplementation(async (_objectId: string, kind: string) => {
      if (kind === "uniaxial_anisotropy") {
        throw new ControlRoomApiError("Interaction is absent", 404);
      }
      return { interaction_kind: kind, params: {}, present: false, revision: 10 };
    });
  });

  it("loads anisotropy only when its inspector section is visible, while material inputs stay ready", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ObjectMaterialPanel selection={selection("object.material")} />));

      expect(mocks.interactionRequest).not.toHaveBeenCalled();
      expect(findControl(container, "Ms").disabled).toBe(false);
      expect(findControl(container, "Ms").value).toBe("800000");
      expect(findControl(container, "Aex").disabled).toBe(false);
      expect(findControl(container, "Aex").value).toBe("1.3e-11");

      await act(async () => {
        root.render(<ObjectMaterialPanel selection={selection("object.root")} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(mocks.interactionRequest).toHaveBeenCalledOnce();
      const request = mocks.interactionRequest.mock.calls[0];
      expect(request?.[0]).toBe("object-a");
      expect(request?.[1]).toBe("uniaxial_anisotropy");
      expect(request?.[2]).toMatchObject({ sessionScopeKey: SESSION_SCOPE });
      expect(request?.[2]?.signal).toBeInstanceOf(AbortSignal);
      expect(mocks.resourceLoads).toHaveLength(1);
      expect(mocks.resourceLoads[0]?.error).toBeUndefined();
      expect(mocks.resourceLoads[0]?.result).toMatchObject({ present: false });

      expect(findControl(container, "Ms").disabled).toBe(false);
      expect(findControl(container, "Ms").value).toBe("800000");
      expect(findControl(container, "Aex").disabled).toBe(false);
      expect(findControl(container, "Aex").value).toBe("1.3e-11");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
