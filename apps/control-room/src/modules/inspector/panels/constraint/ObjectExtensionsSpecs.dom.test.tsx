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
vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div aria-label={ariaLabel} data-slot="echart-mock" />
  ),
}));

const mocks = vi.hoisted(() => ({
  sessionScopeKey: "session-1" as string | null,
  patchObject: vi.fn().mockResolvedValue({ revision: 6 }),
  publishCommittedScene: vi.fn(),
  invalidate: vi.fn(),
  selectionSet: vi.fn(),
  sceneData: {
    revision: 5,
    materials: [{ id: "py", name: "Permalloy", properties: { alpha: 0.008 } }],
    objects: [
      {
        id: "strip-1",
        name: "Waveguide",
        role: "magnet",
        material_ref: "py",
        regions: [{ region_id: "edge", name: "Edge" }],
        absorbing_boundary: {
          layers: [
            {
              layer_id: "sal-plane",
              name: "Cut Plane Layer",
              enabled: true,
              region_id: "deleted-reg",
              total_width_m: 40e-9,
              ramp_width_m: 30e-9,
              max_damping: 0,
              profile: "smootherstep",
              frame: "object",
              geometry: {
                kind: "plane",
                origin: [0, 0, 0],
                normal: [1, 0, 0],
              },
            },
          ],
        },
      },
    ],
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObject: mocks.patchObject,
      },
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => mocks.sessionScopeKey,
    },
    resources: {
      invalidate: mocks.invalidate,
      setOptimisticData: vi.fn(),
    },
    selection: {
      set: mocks.selectionSet,
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: mocks.publishCommittedScene,
  useSceneResource: () => ({
    data: mocks.sceneData,
    sessionScopeKey: mocks.sessionScopeKey,
    status: "ready",
    error: null,
  }),
}));

import { ObjectAbsorbingBoundaryInspectorPanel } from "./ObjectExtensionsSpecs";

describe("ObjectAbsorbingBoundaryInspectorPanel parity", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.sessionScopeKey = "session-1";
    mocks.patchObject.mockReset();
    mocks.patchObject.mockResolvedValue({ revision: 6 });
    mocks.publishCommittedScene.mockClear();
    mocks.invalidate.mockClear();
    mocks.selectionSet.mockClear();
  });

  it("preserves maxDamping = 0, exposes Add layer / Duplicate layer / Reverse normal, and surfaces Missing region fallback", () => {
    const selection: Selection = {
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
      moduleSource: "explorer",
      nodeId: "model:object:strip-1:absorbing-boundary",
      objectId: "strip-1",
      ref: {
        kind: "object.absorbing-boundary",
        nodeId: "model:object:strip-1:absorbing-boundary",
        objectId: "strip-1",
        type: "scene-object",
      },
    };

    mounted = mountWave4TestElement(
      <ObjectAbsorbingBoundaryInspectorPanel selection={selection} />,
    );

    // Peak alpha reflects maxDamping = 0 (0.008 + 0 = 0.008), not coerced to 0.5
    expect(mounted.host.textContent).toContain("0.008");
    expect(mounted.host.textContent).toContain("Missing region (deleted-reg)");

    const addBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Add layer")),
    );
    const dupBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Duplicate layer")),
    );
    const reverseBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Reverse normal")),
    );
    expect(addBtn).not.toBeNull();
    expect(dupBtn).not.toBeNull();
    expect(reverseBtn).not.toBeNull();

    // Duplicate layer creates "Cut Plane Layer copy"
    act(() => {
      dupBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mounted.host.textContent).toContain("Cut Plane Layer copy");

    // Inactive layer 1 still has deleted-reg -> cross-layer validation notice appears!
    expect(mounted.host.textContent).toContain("Cut Plane Layer validation error");

    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
    expect(mounted.host.textContent).not.toMatch(/\b(unknown|unavailable)\b/i);
  });

  it("keeps editing the saved layer when the scene acknowledges a collection change", async () => {
    const selection: Selection = {
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
      moduleSource: "explorer",
      nodeId: "model:object:strip-1:absorbing-boundary",
      objectId: "strip-1",
      ref: {
        kind: "object.absorbing-boundary",
        nodeId: "model:object:strip-1:absorbing-boundary",
        objectId: "strip-1",
        type: "scene-object",
      },
    };
    const originalScene = mocks.sceneData;
    const originalObject = originalScene.objects[0]!;
    const first = { ...originalObject.absorbing_boundary.layers[0]!, region_id: "edge" };
    const interior = {
      ...first,
      layer_id: "sal-interior",
      name: "Interior plane",
      geometry: { ...first.geometry, origin: [40e-9, 0, 0] },
    };
    const object = { ...originalObject, absorbing_boundary: { layers: [first, interior] } };
    mocks.sceneData = { ...originalScene, objects: [object] };
    mocks.patchObject.mockImplementationOnce(async (_id, patch: {
      absorbing_boundary: typeof object.absorbing_boundary;
    }) => {
      const scene = {
        ...mocks.sceneData,
        revision: 6,
        objects: [{ ...object, absorbing_boundary: patch.absorbing_boundary }],
      };
      mocks.sceneData = scene;
      return scene;
    });

    try {
      mounted = mountWave4TestElement(<ObjectAbsorbingBoundaryInspectorPanel selection={selection} />);
      const host = mounted.host;
      const button = (name: string) =>
        findElement(host, (element) => element.tagName === "BUTTON" && element.textContent?.trim() === name);
      const field = (key: string) =>
        findElement(host, (element) => Boolean(element.getAttribute("id")?.endsWith(`-${key}`)), key);
      act(() => button("Interior plane").click());
      expect(field("layerName").value).toBe("Interior plane");
      act(() => field("layerEnabled").click());
      const apply = findElement(host, (element) =>
        element.tagName === "BUTTON" && Boolean(element.textContent?.trim().startsWith("Apply")),
      );
      expect(apply).not.toBeNull();
      await act(async () => apply?.click());
      expect(mocks.patchObject).toHaveBeenCalledOnce();
      expect(field("layerName").value).toBe("Interior plane");
      const origin = findElement(host, (element) => element.getAttribute("aria-label") === "Reference origin / center x", "plane origin x");
      expect(origin.value).toBe("40");
      expect(mocks.sceneData.objects[0]?.absorbing_boundary.layers[0]?.geometry.origin).toEqual(first.geometry.origin);
      expect(mocks.sceneData.objects[0]?.absorbing_boundary.layers[1]?.enabled).toBe(false);
    } finally {
      mocks.sceneData = originalScene;
    }
  });

  it("guards SAL delete against stale response when session switches or closes mid-flight", async () => {
    const selection: Selection = {
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
      moduleSource: "explorer",
      nodeId: "model:object:strip-1:absorbing-boundary",
      objectId: "strip-1",
      ref: {
        kind: "object.absorbing-boundary",
        nodeId: "model:object:strip-1:absorbing-boundary",
        objectId: "strip-1",
        type: "scene-object",
      },
    };

    let resolveDelete!: (value: { revision: number }) => void;
    mocks.patchObject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    mounted = mountWave4TestElement(
      <ObjectAbsorbingBoundaryInspectorPanel selection={selection} />,
    );

    const removeMenuBtn = findElement(
      mounted.host,
      (el) =>
        el.tagName === "BUTTON" &&
        Boolean(el.textContent?.includes("Remove Absorbing Boundary")),
    );
    expect(removeMenuBtn).not.toBeNull();
    act(() => {
      removeMenuBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });

    const confirmDeleteBtn = findElement(
      mounted.host,
      (el) => el.getAttribute("data-slot") === "alert-dialog-action",
    );
    expect(confirmDeleteBtn).not.toBeNull();
    await act(async () => {
      confirmDeleteBtn?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.patchObject).toHaveBeenCalledWith(
      "strip-1",
      { base_revision: 5, absorbing_boundary: null },
      { baseRevision: 5, sessionScopeKey: "session-1" },
    );

    // Session closes/switches BEFORE delete response resolves
    mocks.sessionScopeKey = null;

    await act(async () => {
      resolveDelete({ revision: 6 });
      await Promise.resolve();
    });

    expect(mocks.publishCommittedScene).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.selectionSet).not.toHaveBeenCalled();
  });
});
