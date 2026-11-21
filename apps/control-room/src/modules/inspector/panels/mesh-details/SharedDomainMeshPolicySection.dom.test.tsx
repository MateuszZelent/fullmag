import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import type { MeshSharedDomainConfigReplaceRequest } from "@/kernel/api/apiTypes";
import { PendingFormRegistry } from "@/kernel/authoring/PendingFormRegistry";
import { studyComputeDraftBlockedReason } from "@/kernel/authoring/studyComputeDraftGuard";
import { KernelContext } from "@/kernel/KernelContext";
import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { KernelApi } from "@/kernel/types";

import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../../InspectorEditSession";
import { SharedDomainMeshPolicySection } from "./SharedDomainMeshPolicySection";

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/geometryLifecycleResources")>()),
  useMeshSemanticsResource: () => ({
    data: { revision: 4, shared_domain_config: { hmax: "1e-9", hmin: "0.25e-9", growth_rate: "1.3" } },
  }),
}));
vi.mock("@/kernel/resources/meshPolicyResourceCache", () => ({
  publishCommittedMeshPolicyResource: () => undefined,
}));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useRuntimeCommandControlResourceData: () => ({}),
}));
vi.mock("@/kernel/resources/useSessionStatus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/resources/useSessionStatus")>()),
  useSessionResourceIdentity: () => ({ sessionId: "mesh", sessionEpoch: "1", requestScopeEpoch: "1" }),
}));
vi.mock("../../primitives/FormField", () => ({
  FormField: ({ label, value, onChange }: {
    label: string;
    value: string;
    onChange: (event: { target: { value: string } }) => void;
  }) => <button type="button" onClick={() => onChange({
    target: { value: value === "2e-9" ? "1e-9" : "2e-9" },
  })}>{label}</button>,
}));

describe("SharedDomainMeshPolicySection staged changes", () => {
  it("blocks Compute and keeps a change back to the old baseline during a pending Apply & Build", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const scope = "session=mesh&epoch=1&request_scope_epoch=1";
    const store = createInspectorEditSessionStore();
    const pendingForms = new PendingFormRegistry();
    const owner = Symbol("inspector");
    const unsubscribe = store.subscribe(() => {
      const form = store.getCurrentSession();
      if (!form) pendingForms.unregister(owner);
      else if (!pendingForms.update(owner, form)) pendingForms.register(owner, form);
    });
    let finish!: () => void;
    const replacePolicy = vi.fn((request: MeshSharedDomainConfigReplaceRequest) =>
      new Promise((resolve) => { finish = () => resolve({ config: request.config, revision: 5 }); }),
    );
    const execute = vi.fn();
    const kernel = {
      api: { meshing: { sharedDomain: { replacePolicy } } },
      commands: { execute, getSessionScopeKey: () => scope },
      resources: { invalidate: vi.fn() },
    } as unknown as KernelApi;
    const click = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button"))
        .find((entry) => entry.textContent.trim() === label);
      if (!button) throw new Error(`Missing button: ${label}`);
      await act(async () => button.click());
    };
    const reason = () => studyComputeDraftBlockedReason({
      pendingForms, sessionScopeKey: scope, source: "ribbon",
    });

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel}>
          <InspectorEditSessionProvider store={store}>
            <SharedDomainMeshPolicySection />
          </InspectorEditSessionProvider>
        </KernelContext.Provider>,
      ));
      expect(reason()).toBeNull();
      await click("Global max element size (h_max)");
      expect(reason()).toContain("Apply or discard");
      await click("Apply & Build Shared-Domain Mesh");
      expect(reason()).toContain("save to finish");
      expect(replacePolicy.mock.calls[0][0].config.hmax).toBe("2e-9");

      await click("Global max element size (h_max)");
      await act(async () => finish());

      expect(reason()).toContain("Apply or discard");
      expect(container.textContent).toContain("Newer draft edits still need Apply or Revert.");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      unsubscribe();
      dom.restore();
    }
  });
});
