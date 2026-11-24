import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  ObjectPhysicsInspectorPanel,
  PhysicsModuleInspectorPanel,
} from "../../inspectors/objects/physics";
import { ROTATED_DMI_EXCHANGE_ERROR } from "../../inspectors/objects/physics/physicsShared";
import {
  findElement,
  mountWave4TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
    <button role="menuitem" type="button" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));
vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

const SUPPORTED_OP = {
  state: "supported" as const,
  reason_code: "ok",
  reason: "Supported",
  requires: [] as string[],
};

function makeBilayerScene(overrides?: {
  exchangeEnabled?: boolean;
  rotatedDmi?: number | null;
  topExchangeEnabled?: boolean;
  bottomExchangeEnabled?: boolean;
}) {
  return {
    revision: 10,
    scene_revision: 10,
    study: {
      exchange_enabled: overrides?.exchangeEnabled ?? false,
      demag_enabled: true,
      rotated_interfacial_dmi: overrides?.rotatedDmi ?? null,
    },
    materials: [
      { id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12 } },
    ],
    objects: [
      {
        id: "BottomLayer",
        name: "BottomLayer",
        role: "magnet",
        material_ref: "py",
        physics_stack: [
          {
            kind: "exchange",
            enabled: overrides?.bottomExchangeEnabled ?? true,
            params: null,
          },
          { kind: "demag", enabled: true, params: null },
        ],
      },
      {
        id: "TopLayer",
        name: "TopLayer",
        role: "magnet",
        material_ref: "py",
        physics_stack: [
          {
            kind: "exchange",
            enabled: overrides?.topExchangeEnabled ?? true,
            params: null,
          },
          { kind: "demag", enabled: true, params: null },
        ],
      },
      {
        id: "Spacer",
        name: "Spacer",
        role: "conductor",
        material_ref: "",
        physics_stack: [],
      },
    ],
  };
}

const mocks = vi.hoisted(() => ({
  sceneData: null as ReturnType<typeof makeBilayerScene> | null,
  interactionData: {
    scene_revision: 10,
    object_id: "BottomLayer",
    interaction_kind: "exchange",
    present: true,
    enabled: true,
    params: {},
  },
  patchObjectInteraction: vi.fn(),
  commitTransaction: vi.fn(),
  publishCommittedSceneResource: vi.fn(),
  invalidate: vi.fn(),
  getRevision: vi.fn(() => 10),
  setSelection: vi.fn(),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  SESSION_STATUS_RESOURCE_KEY: "session:status",
  useSessionResourceIdentity: () => ({
    sessionId: "api-bilayer-smoke",
    sessionEpoch: "1",
    requestScopeEpoch: "1",
  }),
  useSessionStatusSelector: (
    selector: (arg: { data: Record<string, unknown> | null; status: string }) => unknown,
  ) =>
    selector({
      status: "ready",
      data: {
        session: { session_id: "api-bilayer-smoke" },
        capabilities: {
          active_lane: {
            source: { kind: "planner" },
            resolved: { discretization: "fdm" },
            operations: {},
          },
        },
      },
    }),
}));

vi.mock("@/kernel/resources/useActiveLaneCapabilities", () => ({
  useActiveLaneCapabilities: () => ({
    source: { kind: "planner" },
    resolved: { discretization: "fdm" },
    operations: {
      "interaction.exchange": SUPPORTED_OP,
      "interaction.uniaxial_anisotropy": SUPPORTED_OP,
      "interaction.cubic_anisotropy": SUPPORTED_OP,
      "interaction.interfacial_dmi": SUPPORTED_OP,
      "interaction.bulk_dmi": SUPPORTED_OP,
    },
  }),
  resolveActiveLaneOperation: (
    snapshot: {
      operations?: Record<
        string,
        { state: string; reason: string; reason_code: string; requires: string[] }
      >;
    } | null,
    opId: string,
  ) => {
    const op = snapshot?.operations?.[opId] ?? SUPPORTED_OP;
    return { ...op, enabled: op.state === "supported" };
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      resourceCacheScope: "test-scope",
      model: {
        scene: vi.fn().mockImplementation(async () => mocks.sceneData),
        patchObjectInteraction: mocks.patchObjectInteraction,
        commitTransaction: mocks.commitTransaction,
      },
    },
    resources: {
      invalidate: mocks.invalidate,
      getRevision: mocks.getRevision,
    },
    authoringHistory: null,
    selection: { set: mocks.setSelection, get: () => null },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: (...args: unknown[]) =>
    mocks.publishCommittedSceneResource(...args),
  resolveMaterialResourceKey: (id: string) =>
    `/api/v2/sessions/current/model/materials/${encodeURIComponent(id)}`,
  resolveObjectInteractionResourceKey: (objId: string, kind: string) =>
    `/api/v2/sessions/current/model/objects/${encodeURIComponent(objId)}/interactions/${encodeURIComponent(kind)}`,
  resolveSceneResourceRevision: (s: { revision?: number; scene_revision?: number } | null) =>
    s?.scene_revision ?? s?.revision ?? null,
  useSceneResource: () => ({
    data: mocks.sceneData,
    status: "ready",
    error: null,
    refetch: vi.fn(),
  }),
  useObjectInteractionResource: () => ({
    data: mocks.interactionData,
    status: "ready",
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/kernel/resources/physicsGraphResources", () => ({
  usePhysicsGraphResource: () => ({
    data: {
      schema_version: "physics_graph.v1",
      scene_revision: 10,
      modules: [],
      edges: [],
    },
    status: "ready",
    refetch: vi.fn(),
  }),
}));

const bottomPhysicsSelection: Selection = {
  kind: "object.physics",
  label: "Physics",
  moduleSource: "explorer",
  nodeId: "model:object:BottomLayer:physics",
  objectId: "BottomLayer",
  ref: null,
};

const bottomExchangeModuleSelection: Selection = {
  kind: "physics.module",
  label: "Symmetric exchange",
  moduleSource: "explorer",
  nodeId: "model:object:BottomLayer:physics:module:exchange",
  objectId: "BottomLayer",
  ref: {
    kind: "physics.module",
    nodeId: "model:object:BottomLayer:physics:module:exchange",
    physicsActivation: "inactive",
    physicsModuleId: "exchange",
    physicsModuleKind: "exchange",
    physicsScopeKind: "object",
    type: "physics-module",
  },
};

describe("ObjectPhysics Symmetric exchange toggle & study sync", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.sceneData = null;
    mocks.patchObjectInteraction.mockReset();
    mocks.commitTransaction.mockReset();
    mocks.publishCommittedSceneResource.mockReset();
    mocks.invalidate.mockReset();
    mocks.setSelection.mockReset();
  });

  it("syncs study.exchange_enabled = true when toggling Symmetric exchange ON in ObjectPhysicsSpec while study.exchange_enabled is false", async () => {
    mocks.sceneData = makeBilayerScene({ exchangeEnabled: false });
    mocks.patchObjectInteraction.mockResolvedValue({
      scene_revision: 11,
      object_id: "BottomLayer",
      interaction_kind: "exchange",
      present: true,
      enabled: true,
      params: {},
    });
    const updatedScene = makeBilayerScene({ exchangeEnabled: true });
    updatedScene.revision = 12;
    updatedScene.scene_revision = 12;
    mocks.commitTransaction.mockResolvedValue({
      scene_revision: 12,
      committed_scene: updatedScene,
    });

    mounted = mountWave4TestElement(
      <ObjectPhysicsInspectorPanel selection={bottomPhysicsSelection} />,
    );

    const exchangeSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Toggle Symmetric exchange",
      "Toggle Symmetric exchange switch",
    );
    // Initial state: study.exchange_enabled is false -> switch is OFF, KPI is 0 active / 0 of 5
    expect(exchangeSwitch.getAttribute("aria-checked")).toBe("false");
    expect(mounted.host.textContent).toContain("0 active");
    expect(mounted.host.textContent).toContain("0 of 5");

    await act(async () => {
      exchangeSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "BottomLayer",
      "exchange",
      { base_revision: 10, present: true, enabled: true },
      { sessionScopeKey: "session=api-bilayer-smoke&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 11,
        merge_patch: { study: { exchange_enabled: true } },
      },
      { sessionScopeKey: "session=api-bilayer-smoke&epoch=1&request_scope_epoch=1" },
    );
    expect(mocks.publishCommittedSceneResource).toHaveBeenCalledWith(
      expect.anything(),
      updatedScene,
      12,
      undefined,
      true,
      "session=api-bilayer-smoke&epoch=1&request_scope_epoch=1",
      "test-scope",
    );
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_SCENE_PATH, 12);
    expect(mocks.invalidate).toHaveBeenCalledWith(MODEL_PHYSICS_GRAPH_PATH, 12);

    // Rerender with committed scene -> Switch turns ON and KPI strip updates to 1 active / 1 of 5
    mocks.sceneData = updatedScene;
    mounted.rerender(
      <ObjectPhysicsInspectorPanel selection={bottomPhysicsSelection} />,
    );
    const updatedSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Toggle Symmetric exchange",
    );
    expect(updatedSwitch.getAttribute("aria-checked")).toBe("true");
    expect(mounted.host.textContent).toContain("1 active");
    expect(mounted.host.textContent).toContain("1 of 5");
  });

  it("keeps study.exchange_enabled = true when another magnet still has exchange enabled, and disables study.exchange_enabled when disabling the last active magnet", async () => {
    mocks.sceneData = makeBilayerScene({
      exchangeEnabled: true,
      bottomExchangeEnabled: true,
      topExchangeEnabled: true,
    });
    mocks.patchObjectInteraction.mockResolvedValue({ scene_revision: 11 });

    mounted = mountWave4TestElement(
      <ObjectPhysicsInspectorPanel selection={bottomPhysicsSelection} />,
    );
    const exchangeSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Toggle Symmetric exchange",
    );
    expect(exchangeSwitch.getAttribute("aria-checked")).toBe("true");

    // TopLayer still has exchange enabled -> do NOT disable study.exchange_enabled
    await act(async () => {
      exchangeSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "BottomLayer",
      "exchange",
      { base_revision: 10, present: true, enabled: false },
      expect.any(Object),
    );
    expect(mocks.commitTransaction).not.toHaveBeenCalled();

    // Now TopLayer already has exchange disabled -> disabling BottomLayer disables study.exchange_enabled
    mocks.patchObjectInteraction.mockClear();
    mocks.sceneData = makeBilayerScene({
      exchangeEnabled: true,
      bottomExchangeEnabled: true,
      topExchangeEnabled: false,
    });
    mocks.commitTransaction.mockResolvedValue({
      scene_revision: 12,
      committed_scene: makeBilayerScene({
        exchangeEnabled: false,
        bottomExchangeEnabled: false,
        topExchangeEnabled: false,
      }),
    });
    mounted.rerender(
      <ObjectPhysicsInspectorPanel selection={bottomPhysicsSelection} />,
    );
    await act(async () => {
      findElement(
        mounted!.host,
        (el) => el.getAttribute("aria-label") === "Toggle Symmetric exchange",
      ).dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 11,
        merge_patch: { study: { exchange_enabled: false } },
      },
      expect.any(Object),
    );
  });

  it("blocks disabling the last active magnet's exchange when study rotated_interfacial_dmi is non-zero", async () => {
    mocks.sceneData = makeBilayerScene({
      exchangeEnabled: true,
      bottomExchangeEnabled: true,
      topExchangeEnabled: false,
      rotatedDmi: 0.003,
    });

    mounted = mountWave4TestElement(
      <ObjectPhysicsInspectorPanel selection={bottomPhysicsSelection} />,
    );
    await act(async () => {
      findElement(
        mounted!.host,
        (el) => el.getAttribute("aria-label") === "Toggle Symmetric exchange",
      ).dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObjectInteraction).not.toHaveBeenCalled();
    expect(mocks.commitTransaction).not.toHaveBeenCalled();
    expect(mounted.host.textContent).toContain(ROTATED_DMI_EXCHANGE_ERROR);
  });

  it("hydrates Configure Symmetric exchange (PhysicsModuleSpec) as Disabled when study.exchange_enabled is false and syncs study.exchange_enabled on Apply", async () => {
    mocks.sceneData = makeBilayerScene({
      exchangeEnabled: false,
      bottomExchangeEnabled: true,
    });
    mocks.patchObjectInteraction.mockResolvedValue({
      scene_revision: 11,
      object_id: "BottomLayer",
      interaction_kind: "exchange",
      present: true,
      enabled: true,
      params: {},
    });
    const updatedScene = makeBilayerScene({ exchangeEnabled: true });
    updatedScene.revision = 12;
    updatedScene.scene_revision = 12;
    mocks.commitTransaction.mockResolvedValue({
      scene_revision: 12,
      committed_scene: updatedScene,
    });

    mounted = mountWave4TestElement(
      <PhysicsModuleInspectorPanel selection={bottomExchangeModuleSelection} />,
    );

    // Even though GET .../interactions/exchange returned enabled: true, study.exchange_enabled === false
    // means Configure Symmetric exchange must show Disabled (not Active) so the user can enable it.
    expect(mounted.host.textContent).toContain("Disabled");
    const enableSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("role") === "switch",
      "Enable Hamiltonian term switch",
    );
    expect(enableSwitch.getAttribute("aria-checked")).toBe("false");

    act(() => {
      enableSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(enableSwitch.getAttribute("aria-checked")).toBe("true");

    const applyBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Apply")),
      "Apply button",
    );
    await act(async () => {
      applyBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObjectInteraction).toHaveBeenCalledWith(
      "BottomLayer",
      "exchange",
      { base_revision: 10, present: true, enabled: true },
      expect.any(Object),
    );
    expect(mocks.commitTransaction).toHaveBeenCalledWith(
      {
        kind: "merge_patch",
        base_revision: 11,
        merge_patch: { study: { exchange_enabled: true } },
      },
      expect.any(Object),
    );
  });
});
