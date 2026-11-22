import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
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
    <button type="button" onClick={() => onSelect?.()}>
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
vi.mock("@radix-ui/react-select", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));

const mocks = vi.hoisted(() => ({
  patchObject: vi.fn().mockResolvedValue({ revision: 9 }),
  commitTransaction: vi.fn().mockResolvedValue({ committed_scene: { revision: 9 }, scene_revision: 9 }),
  setSelection: vi.fn(),
  sceneData: {
    revision: 8,
    materials: [{ id: "py", name: "Permalloy", properties: { Ms: 8e5, Aex: 13e-12, alpha: 0.008 } }],
    couplings: [],
    objects: [
      {
        id: "disk-1",
        name: "Skyrmion Disk",
        role: "magnet",
        visible: true,
        material_ref: "py",
        region_name: "free_layer",
        notes: "CoFeB nanodisk",
        tags: ["mesh:ready"],
        geometry: {
          geometry_kind: "Cylinder",
          geometry_params: { radius: 100e-9, height: 2e-9 },
        },
        regions: [{ region_id: "rim", name: "Rim" }],
      },
    ],
  },
  frozenDefinitions: [
    {
      id: "frozen-compound-1",
      name: "Compound Rim Pinning",
      enabled: true,
      schema_version: "fullmag.frozen-spins.v1",
      selector: {
        kind: "and",
        expressions: [
          { kind: "in_object", object_id: "disk-1" },
          { kind: "in_region", object_id: "disk-1", region_id: "rim" },
        ],
      },
      reference: { kind: "capture_current_at_activation" },
      membership: { kind: "static" },
      activation: { kind: "all_stages" },
    },
  ],
  objectMetrics: {
    has_solver_sample: true,
    step: 42,
    time_seconds: 1.5e-10,
    source: "solver_live",
    magnetization_average: { mx: 0.125, my: -0.25, mz: 0.96 },
    energies: {
      exchange: 1.2e-18,
      demag: 3.4e-18,
      zeeman: -2.1e-19,
      anisotropy: 5.6e-19,
      dmi: -8.9e-19,
      total: 4.06e-18,
    },
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObject: mocks.patchObject,
        commitTransaction: mocks.commitTransaction,
        frozenSpins: {
          create: vi.fn().mockResolvedValue({ revision: 9 }),
          patch: vi.fn().mockResolvedValue({ revision: 9 }),
        },
      },
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => "session-1",
    },
    resources: {
      invalidate: vi.fn(),
      setOptimisticData: vi.fn(),
    },
    selection: {
      get: () => ({ objectId: "disk-1" }),
      clear: vi.fn(),
      set: mocks.setSelection,
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  MESH_BUILD_CURRENT_RESOURCE_KEY: "mesh-current",
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY: "mesh-latest",
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({
    data: mocks.sceneData,
    sessionScopeKey: "session-1",
    status: "ready",
    error: null,
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useObjectMetricsResource: () => ({
    data: mocks.objectMetrics,
    status: "ready",
    error: null,
  }),
}));

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY: "frozen-spins:preview",
  frozenSpinsDefinitionResourceKey: (id: string) => `frozen-spins:${id}`,
  useFrozenSpinsCollectionResource: () => ({
    data: { revision: 8, definitions: mocks.frozenDefinitions },
    status: "ready",
  }),
}));

vi.mock("@/kernel/object-extensions/useObjectExtensionActivation", () => ({
  useObjectExtensionActivation: () => ({
    activation: { enabled: {} },
    setEnabled: vi.fn(),
  }),
}));

import { ObjectOverviewInspectorPanel } from "./ObjectOverviewSpec";

describe("ObjectOverviewInspectorPanel parity", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.patchObject.mockClear();
  });

  it("renders per-object micromagnetic energies, region_name, compound Frozen Spins match, and commits canonical SAL schema", async () => {
    const selection: Selection = {
      kind: "object.root",
      label: "Skyrmion Disk",
      moduleSource: "explorer",
      nodeId: "model:object:disk-1",
      objectId: "disk-1",
      ref: {
        kind: "object.root",
        nodeId: "model:object:disk-1",
        objectId: "disk-1",
        type: "scene-object",
      },
    };

    mounted = mountWave4TestElement(<ObjectOverviewInspectorPanel selection={selection} />);

    // Live micromagnetic energies
    expect(mounted.host.textContent).toContain("Micromagnetic energies");
    expect(mounted.host.textContent).toContain("step 42 @ 1.500000e-10 s");
    expect(mounted.host.textContent).toContain("(0.125000, -0.250000, 0.960000)");
    expect(mounted.host.textContent).toContain("1.200000e-18 J");
    expect(mounted.host.textContent).toContain("4.060000e-18 J");

    // Compound Frozen Spins match shows "Pinned" and Configure button
    expect(mounted.host.textContent).toContain("Pinned");

    // Region (`region_name`) input hydrated
    const inputs = findElements(mounted.host, (el) => el.tagName === "INPUT");
    expect(inputs.some((el) => (el as unknown as { value?: string }).value === "free_layer")).toBe(
      true,
    );

    // Zero raw <select> and zero "unknown"/"unavailable"
    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
    expect(mounted.host.textContent).not.toMatch(/\b(unknown|unavailable)\b/i);

    // Toggle SAL ON -> sends canonical SpatialAbsorbingLayer (`layer_id`, `total_width_m`, `ramp_width_m`, `max_damping`, `faces`)
    const salSwitch = findElement(
      mounted.host,
      (el) => el.getAttribute("aria-label") === "Toggle Absorbing boundary (SAL)",
    );
    expect(salSwitch).not.toBeNull();
    await act(async () => {
      salSwitch?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    expect(mocks.patchObject).toHaveBeenCalledTimes(1);
    const [, patchPayload] = mocks.patchObject.mock.calls[0]!;
    expect(patchPayload.absorbing_boundary.layers[0]).toEqual(
      expect.objectContaining({
        layer_id: "layer-1",
        name: "Layer 1",
        enabled: true,
        geometry: expect.objectContaining({ kind: "faces" }),
      }),
    );
    expect(typeof patchPayload.absorbing_boundary.layers[0].total_width_m).toBe("number");
    expect(typeof patchPayload.absorbing_boundary.layers[0].ramp_width_m).toBe("number");
    expect(typeof patchPayload.absorbing_boundary.layers[0].max_damping).toBe("number");
  });
});
