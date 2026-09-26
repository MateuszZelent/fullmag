import { act, type ReactNode } from "react";
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
  execute: vi.fn(),
  replace: vi.fn(),
  scopeKey: "session=A&epoch=4&request_scope_epoch=4",
  policy: {
    config: { maximum_element_size: 1e-9 },
    effective_config: null,
    object_id: "film",
    revision: 1,
  },
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionResourceIdentity: () => mocks.identity,
  useSessionStatusSelector: (selector: (value: never) => unknown) =>
    selector({ data: { domain: { discretization: "fem" } } } as never),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/kernel/resources/geometryLifecycleResources")
  >();
  const result = (data: unknown) => ({ data, error: null, revision: 1, status: "ready" as const });
  return {
    ...actual,
    useDomainMetaResource: () => result(null),
    useFdmRegionMembershipBinaryResource: () => result(null),
    useFdmRegionMembershipResource: () => result(null),
    useMeshCapabilitiesResource: () => result({ mesh_capabilities: {} }),
    useObjectMeshPolicyResource: () => result(mocks.policy),
    useObjectMeshQualityResource: () => result(null),
    useObjectMeshReportResource: () => result(null),
    useObjectMeshSizeFieldResource: () => result(null),
    useObjectTopologyResource: () => result(null),
  };
});

vi.mock("@/modules/inspector/InspectorTabState", () => ({
  useInspectorActiveTab: () => "policy",
}));

vi.mock("@/shared/ui/Tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({ HelpCircle: () => null }));

import { ObjectMeshPolicyPanel } from "./ObjectMeshPolicyPanel";

function kernel(): KernelApi {
  return {
    api: {
      meshing: { replaceObjectPolicy: mocks.replace },
    },
    bus: { emit: mocks.emit, on: mocks.on },
    commands: {
      execute: mocks.execute,
      getSessionScopeKey: () => mocks.scopeKey,
    },
    resources: { invalidate: mocks.invalidate },
  } as unknown as KernelApi;
}

function maximumSize(container: Parameters<typeof findElement>[0]) {
  return findElement(
    container,
    (element) => element.getAttribute("aria-label") === "Maximum element size",
    "Maximum element size input",
  );
}

function applyButton(container: Parameters<typeof findElement>[0]) {
  return findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent.includes("Apply Policy"),
    "Apply Policy button",
  );
}

describe("ObjectMeshPolicyPanel session fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity = { sessionEpoch: "4", sessionId: "A", requestScopeEpoch: "4" };
    mocks.scopeKey = "session=A&epoch=4&request_scope_epoch=4";
    mocks.policy = {
      config: { maximum_element_size: 1e-9 },
      effective_config: null,
      object_id: "film",
      revision: 1,
    };
  });

  it("uses the captured session scope and invalidates after a current acknowledgement", async () => {
    mocks.replace.mockImplementation(async (_objectId, request) => ({
      ...mocks.policy,
      config: request.config,
      revision: 2,
    }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <ObjectMeshPolicyPanel selection={{ objectId: "film" } as never} />
        </KernelContext.Provider>,
      ));
      const input = maximumSize(container);
      input.value = "2e-9";
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => {
        applyButton(container).dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      expect(mocks.replace).toHaveBeenCalledWith(
        "film",
        expect.objectContaining({ config: { maximum_element_size: 2e-9 } }),
        { sessionScopeKey: "session=A&epoch=4&request_scope_epoch=4" },
      );
      expect(mocks.invalidate).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("ignores a policy acknowledgement from a no-longer-current session", async () => {
    let finishWrite: ((value: unknown) => void) | null = null;
    mocks.replace.mockReturnValue(new Promise((resolve) => { finishWrite = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(
        <KernelContext.Provider value={kernel()}>
          <ObjectMeshPolicyPanel selection={{ objectId: "film" } as never} />
        </KernelContext.Provider>,
      ));
      const input = maximumSize(container);
      input.value = "2e-9";
      await act(async () => input.dispatchEvent(new TestEvent("input", { bubbles: true })));
      await act(async () => {
        applyButton(container).dispatchEvent(new TestEvent("click", { bubbles: true }));
        await Promise.resolve();
      });
      expect(mocks.replace).toHaveBeenCalledOnce();

      mocks.scopeKey = "session=B&epoch=5&request_scope_epoch=5";
      await act(async () => {
        finishWrite?.({ ...mocks.policy, config: { maximum_element_size: 2e-9 }, revision: 2 });
        await Promise.resolve();
      });

      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
