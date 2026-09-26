import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

const mocks = vi.hoisted(() => ({
  identity: {
    sessionEpoch: "4",
    sessionId: "A",
    requestScopeEpoch: "4",
  } as { sessionEpoch: string; sessionId: string; requestScopeEpoch: string } | null,
  invalidate: vi.fn(),
  on: vi.fn(() => () => undefined),
  emit: vi.fn(),
  replace: vi.fn(),
  scene: vi.fn(),
  scopeKey: "session=A&epoch=4&request_scope_epoch=4",
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.identity,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "meshing:build-current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "meshing:build-latest-successful",
  MESH_UNIVERSE_POLICY_RESOURCE_KEY: "meshing:universe-policy",
  SCENE_RESOURCE_KEY: "model:scene",
  useUniverseMeshPolicyResource: () => ({
    data: { config: null, effective_config: { mode: "auto" }, revision: 1 },
    status: "ready",
  }),
}));

import { AirboxMeshParametersPanel } from "./AirboxMeshParametersPanel";

function kernel(): KernelApi {
  return {
    api: {
      meshing: { replaceUniversePolicy: mocks.replace },
      model: { scene: mocks.scene },
    },
    bus: { emit: mocks.emit, on: mocks.on },
    commands: { getSessionScopeKey: () => mocks.scopeKey },
    resources: { invalidate: mocks.invalidate },
  } as unknown as KernelApi;
}

function control(container: Parameters<typeof findElement>[0], label: string) {
  return findElement(
    container,
    (element) => element.getAttribute("aria-label") === label,
    label,
  );
}

describe("AirboxMeshParametersPanel session fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = { sessionEpoch: "4", sessionId: "A", requestScopeEpoch: "4" };
    mocks.scopeKey = "session=A&epoch=4&request_scope_epoch=4";
  });

  it("sends the scoped policy write and invalidates resources after its acknowledgement", async () => {
    mocks.replace.mockImplementation(async (request) => ({
      config: request.config,
      effective_config: null,
      revision: 2,
    }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <AirboxMeshParametersPanel selection={null as never} />
        </KernelContext.Provider>,
      ));
      const maximumSize = control(container, "Maximum element size");
      maximumSize.value = "2e-9";
      await act(async () => {
        maximumSize.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });

      const apply = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent.includes("Apply Airbox Policy"),
        "Apply Airbox Policy button",
      );
      await act(async () => {
        apply.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(mocks.replace).toHaveBeenCalledWith(
        { config: { airbox_hmax: 2e-9 } },
        { sessionScopeKey: "session=A&epoch=4&request_scope_epoch=4" },
      );
      expect(mocks.invalidate).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("ignores a policy acknowledgement after the active session changes", async () => {
    let finishWrite: ((value: unknown) => void) | null = null;
    mocks.replace.mockReturnValue(new Promise((resolve) => { finishWrite = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <AirboxMeshParametersPanel selection={null as never} />
        </KernelContext.Provider>,
      ));
      const maximumSize = control(container, "Maximum element size");
      maximumSize.value = "2e-9";
      await act(async () => {
        maximumSize.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      const apply = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent.includes("Apply Airbox Policy"),
        "Apply Airbox Policy button",
      );
      await act(async () => {
        apply.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(mocks.replace).toHaveBeenCalledOnce();

      mocks.scopeKey = "session=B&epoch=5&request_scope_epoch=5";
      await act(async () => {
        finishWrite?.({ config: { airbox_hmax: 2e-9 }, effective_config: null, revision: 2 });
        await Promise.resolve();
      });

      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
