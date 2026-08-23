import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH, DATA_DOMAIN_TOPOLOGY_PATH } from "@/kernel/api/apiPaths";
import { primitiveDraftOverlayStore } from "@/kernel/authoring/geometryLifecycleCommands";
import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import {
  installSimulationPreparationTestDom,
  TestElement,
  type TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import {
  resetSharedResourceRuntimeStoreForTests,
  sharedResourceRuntimeStore,
} from "@/kernel/resources/ResourceRuntimeStore";
import { sessionScopedResourceKey } from "@/kernel/resources/sessionResourceIdentity";
import type { KernelApi } from "@/kernel/types";

import {
  synchronizeViewport3DSessionIdentity,
  useViewport3DDomainTopology,
  useViewport3DScene,
} from "../viewport3dResources";

import { usePrimitiveDraftOverlay } from "./usePrimitiveDraftOverlay";

const SESSION_IDENTITY = {
  sessionEpoch: "epoch-task-5",
  sessionId: "session-task-5",
} as const;

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => SESSION_IDENTITY,
}));

function Probe() {
  const overlay = usePrimitiveDraftOverlay();
  const scene = useViewport3DScene();
  const topology = useViewport3DDomainTopology();
  return (
    <div
      data-geometry-key={overlay?.geometryKey ?? "none"}
      data-scene-revision={scene.data?.revision ?? "none"}
      data-topology-provenance={
        (topology.data as { meshTopologyHash?: string } | null)?.meshTopologyHash ??
        "none"
      }
    />
  );
}

describe("usePrimitiveDraftOverlay", () => {
  afterEach(() => {
    primitiveDraftOverlayStore.clear();
    resetSharedResourceRuntimeStoreForTests();
    synchronizeViewport3DSessionIdentity(null);
  });

  it("updates the overlay without reloading topology or mutating committed resources", async () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const topologyChunked = vi.fn();
    const loadScene = vi.fn();
    const kernel = {
      api: {
        data: { domain: { topologyChunked } },
        model: { scene: loadScene },
      },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const sceneKey = sessionScopedResourceKey(SESSION_IDENTITY, MODEL_SCENE_PATH);
    const topologyKey = sessionScopedResourceKey(
      SESSION_IDENTITY,
      DATA_DOMAIN_TOPOLOGY_PATH,
    );
    const committedScene = { objects: [{ id: "committed-box" }], revision: 41 };
    const committedTopology = {
      meshRevision: 17,
      meshTopologyHash: "sha256:committed-topology",
    };
    synchronizeViewport3DSessionIdentity(SESSION_IDENTITY);
    sharedResourceRuntimeStore.updateData(sceneKey, committedScene, 41);
    sharedResourceRuntimeStore.updateData(
      topologyKey,
      committedTopology,
      "topology-etag-17",
    );
    resources.invalidate(sceneKey, 41);
    resources.invalidate(topologyKey, "topology-etag-17");
    const sceneSnapshotBefore = sharedResourceRuntimeStore.getSnapshot(sceneKey);
    const topologySnapshotBefore = sharedResourceRuntimeStore.getSnapshot(topologyKey);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe />
          </KernelContext.Provider>,
        ),
      );
      expect(probe(container).getAttribute("data-geometry-key")).toBe("none");
      expect(probe(container).getAttribute("data-scene-revision")).toBe("41");
      expect(probe(container).getAttribute("data-topology-provenance")).toBe(
        "sha256:committed-topology",
      );
      expect(loadScene).not.toHaveBeenCalled();
      expect(topologyChunked).not.toHaveBeenCalled();

      await act(async () =>
        primitiveDraftOverlayStore.publish({
          dimensions: [2e-7, 4e-7, 6e-8],
          errors: {},
          kind: "Box",
          translation: [7e-9, 8e-9, 9e-9],
        }),
      );

      expect(probe(container).getAttribute("data-geometry-key")).toBe(
        "draft:Box:2e-7,4e-7,6e-8:7e-9,8e-9,9e-9",
      );
      expect(probe(container).getAttribute("data-scene-revision")).toBe("41");
      expect(probe(container).getAttribute("data-topology-provenance")).toBe(
        "sha256:committed-topology",
      );
      expect(loadScene).not.toHaveBeenCalled();
      expect(topologyChunked).not.toHaveBeenCalled();
      expect(sharedResourceRuntimeStore.getSnapshot(sceneKey)).toBe(
        sceneSnapshotBefore,
      );
      expect(sharedResourceRuntimeStore.getSnapshot(topologyKey)).toBe(
        topologySnapshotBefore,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function probe(root: TestNode): TestElement {
  const found = root.childNodes.find(
    (node): node is TestElement => node instanceof TestElement,
  );
  if (!found) throw new Error("Missing overlay probe");
  return found;
}
