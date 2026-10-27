import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import { InspectorFooter } from "@/modules/inspector/InspectorFooter";
import { InspectorEditSessionProvider } from "@/modules/inspector/InspectorEditSession";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  findElements,
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

vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => mocks.identity,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "meshing:build-current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "meshing:build-latest-successful",
  MESH_UNIVERSE_POLICY_RESOURCE_KEY: "meshing:universe-policy",
  SCENE_RESOURCE_KEY: "model:scene",
  useGeometryDiagnosticsResource: () => ({ data: null, error: null, status: "idle" }),
  useSceneResource: () => ({ data: null, error: null, status: "idle" }),
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

function inspectorTree(children: ReactNode) {
  return (
    <InspectorEditSessionProvider>
      <KernelContext.Provider value={kernel()}>
        {children}
        <InspectorFooter onFocus={() => undefined} />
      </KernelContext.Provider>
    </InspectorEditSessionProvider>
  );
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

  it("keeps empty automatic bounds unset and exposes manual fields only after choosing Manual", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(inspectorTree(
        <AirboxMeshParametersPanel selection={null as never} />,
      )));

      const mode = control(container, "Domain mode");
      expect(mode.textContent).toContain("Auto");
      expect(mode.textContent).toContain("Manual");
      expect(findElements(container, (element) => ["Size X", "Size Y", "Size Z", "Center X", "Center Y", "Center Z"].includes(element.getAttribute("aria-label") ?? ""))).toHaveLength(0);
      expect(container.textContent).toContain("Automatic is the canonical default.");
      expect(container.textContent).toContain("Bounds are determined after geometry is available; no zero extents are created.");

      mode.value = "manual";
      await act(async () => mode.dispatchEvent(new TestEvent("change", { bubbles: true })));

      expect(control(container, "Size X").value).toBe("");
      expect(control(container, "Size Y").value).toBe("");
      expect(control(container, "Size Z").value).toBe("");
      expect(control(container, "Center X").value).toBe("");
      expect(container.textContent).toContain("Center may be omitted (canonical origin)");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
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
      await act(async () => root.render(inspectorTree(
        <AirboxMeshParametersPanel selection={null as never} />,
      )));
      const maximumSize = control(container, "Maximum element size");
      maximumSize.value = "2e-9";
      await act(async () => {
        maximumSize.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      expect(
        findElements(
          container,
          (element) => element.tagName === "BUTTON" && element.textContent.includes("Apply Airbox Policy"),
        ),
      ).toHaveLength(0);

      const apply = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent.trim() === "Apply",
        "Inspector footer Apply button",
      );
      await act(async () => {
        apply.dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(mocks.replace).toHaveBeenCalledWith(
        { config: { airbox_hmax: 2e-9 }, expected_revision: 1 },
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
      await act(async () => root.render(inspectorTree(
        <AirboxMeshParametersPanel selection={null as never} />,
      )));
      const maximumSize = control(container, "Maximum element size");
      maximumSize.value = "2e-9";
      await act(async () => {
        maximumSize.dispatchEvent(new TestEvent("input", { bubbles: true }));
      });
      expect(
        findElements(
          container,
          (element) => element.tagName === "BUTTON" && element.textContent.includes("Apply Airbox Policy"),
        ),
      ).toHaveLength(0);
      const apply = findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent.trim() === "Apply",
        "Inspector footer Apply button",
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
