import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "../api/ControlRoomApi";
import type { SceneResource } from "../api/apiTypes";
import { KernelContext } from "../KernelContext";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { installSimulationPreparationTestDom } from "../layout/simulationPreparationTestDom.test-support";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import type { KernelApi } from "../types";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { resetSharedResourceRuntimeStoreForTests } from "./ResourceRuntimeStore";
import {
  useMeshSemanticsResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "./geometryLifecycleResources";
import { useModelReadinessResource } from "./studyRuntimeResources";

const SESSION_ID = "imported-visualization-session";

function sceneAt(revision: number): SceneResource {
  return {
    materials: [],
    objects: [],
    revision,
    scene_revision: revision,
    version: "2.0.0",
  };
}

function importedStatus() {
  return {
    capabilities: { binary_fields: true },
    domain: { discretization: "fem" },
    lifecycle: {
      commandability: "read_only",
      connectivity: "connected",
      session_resource: "tombstoned",
      solver: "stopped",
    },
    resources: { scene_revision: 1 },
    session: {
      request_scope_epoch: "api-instance:imported-visualization",
      session_epoch: `${SESSION_ID}@1700000000000`,
      session_id: SESSION_ID,
    },
  };
}

function createKernel(
  api: Record<string, unknown>,
  bus: EventBus<KernelEventMap>,
) {
  return {
    api: {
      resourceCacheScope: "scene-dependent-authoring-test",
      sessions: {
        list: async () => ({
          schema_version: "2.0.0",
          sessions: [
            {
              current: true,
              name: "Imported visualization",
              session_id: SESSION_ID,
              status: "running",
            },
          ],
        }),
        current: { status: async () => importedStatus() },
      },
      ...api,
    },
    bus,
    diagnosticRecorder: new DiagnosticRecorderController({
      config: { enabled: false },
    }),
    resources: new ResourceInvalidationController(bus),
  } as unknown as KernelApi;
}

function Harness() {
  const scene = useSceneResource();
  const readiness = useModelReadinessResource();
  const semantics = useMeshSemanticsResource();
  const universePolicy = useUniverseMeshPolicyResource();

  return (
    <output>
      {JSON.stringify({
        readiness: readiness.status,
        scene: scene.status,
        sceneError: scene.error?.message ?? null,
        semantics: semantics.status,
        universePolicy: universePolicy.status,
      })}
    </output>
  );
}

describe("scene-dependent authoring resources", () => {
  afterEach(() => {
    resetSharedResourceRuntimeStoreForTests();
  });

  it("keeps expected missing-scene state local and does not request dependent resources", async () => {
    const sceneLoad = vi.fn(async () => {
      throw new ControlRoomApiError(
        "no scene document available for current workspace",
        404,
        null,
        "not_found",
      );
    });
    const readinessLoad = vi.fn(async () => ({ scene_revision: 1 }));
    const semanticsLoad = vi.fn(async () => ({ revision: 1 }));
    const universePolicyLoad = vi.fn(async () => ({ revision: 1 }));
    const bus = new EventBus<KernelEventMap>();
    const failures: Array<{ cause: string; resourceKey: string }> = [];
    bus.on("resource:load-failed", ({ cause, resourceKey }) => {
      failures.push({ cause, resourceKey });
    });
    const kernel = createKernel(
      {
        model: { scene: sceneLoad, readiness: readinessLoad },
        meshing: {
          semantics: semanticsLoad,
          universePolicy: universePolicyLoad,
        },
      },
      bus,
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(sceneLoad).toHaveBeenCalled();
        expect(container.textContent).toContain('"scene":"error"');
      });

      expect(container.textContent).toContain(
        '"sceneError":"no scene document available for current workspace"',
      );
      expect(container.textContent).toContain('"readiness":"idle"');
      expect(container.textContent).toContain('"semantics":"idle"');
      expect(container.textContent).toContain('"universePolicy":"idle"');
      expect(readinessLoad).not.toHaveBeenCalled();
      expect(semanticsLoad).not.toHaveBeenCalled();
      expect(universePolicyLoad).not.toHaveBeenCalled();
      expect(failures).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("loads authoring resources for a read-only session when its scene is ready", async () => {
    const sceneLoad = vi.fn(async () => sceneAt(1));
    const readinessLoad = vi.fn(async () => ({ scene_revision: 1 }));
    const semanticsLoad = vi.fn(async () => ({ revision: 1 }));
    const universePolicyLoad = vi.fn(async () => ({ revision: 1 }));
    const bus = new EventBus<KernelEventMap>();
    const kernel = createKernel(
      {
        model: { scene: sceneLoad, readiness: readinessLoad },
        meshing: {
          semantics: semanticsLoad,
          universePolicy: universePolicyLoad,
        },
      },
      bus,
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(readinessLoad).toHaveBeenCalledTimes(1);
        expect(semanticsLoad).toHaveBeenCalledTimes(1);
        expect(universePolicyLoad).toHaveBeenCalledTimes(1);
      });

      expect(sceneLoad).toHaveBeenCalled();
      expect(container.textContent).toContain('"scene":"ready"');
      expect(container.textContent).toContain('"readiness":"ready"');
      expect(container.textContent).toContain('"semantics":"ready"');
      expect(container.textContent).toContain('"universePolicy":"ready"');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("still emits unexpected scene-resource failures", async () => {
    const sceneLoad = vi.fn(async () => {
      throw new ControlRoomApiError("route missing", 404, null, "not_found");
    });
    const bus = new EventBus<KernelEventMap>();
    const failures: Array<{ cause: string; resourceKey: string }> = [];
    bus.on("resource:load-failed", ({ cause, resourceKey }) => {
      failures.push({ cause, resourceKey });
    });
    const kernel = createKernel(
      {
        model: { scene: sceneLoad, readiness: vi.fn() },
        meshing: { semantics: vi.fn(), universePolicy: vi.fn() },
      },
      bus,
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Harness />
          </KernelContext.Provider>,
        );
      });
      await vi.waitFor(() => {
        expect(sceneLoad).toHaveBeenCalled();
        expect(failures.length).toBeGreaterThan(0);
      });
      expect(failures.some(({ cause }) => cause === "route missing")).toBe(true);
      expect(container.textContent).toContain('"scene":"error"');
      expect(container.textContent).toContain('"readiness":"idle"');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
