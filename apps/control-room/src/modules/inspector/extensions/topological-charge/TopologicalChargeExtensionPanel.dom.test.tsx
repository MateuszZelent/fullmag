import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElements,
  mountWave4TestElement,
} from "../../panels/model-roots/wave4TestDom.test-support";

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
  Item: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      data: {
        observables: {
          topologicalCharge: vi.fn(),
        },
      },
    },
    commands: { execute: vi.fn(), getSessionScopeKey: () => "session-1" },
    resources: { invalidate: vi.fn() },
    selection: { set: vi.fn() },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({
    data: { objects: [{ id: "disk-1", name: "Skyrmion Disk" }] },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (key: string) => ({
    enabled: true,
    resourceKey: key,
    sessionScopeKey: "session-1",
  }),
}));

vi.mock("@/kernel/resources/useResource", () => ({
  useResource: () => ({
    status: "ready",
    error: null,
    refetch: vi.fn(),
    data: {
      schema_version: "fullmag.topological-charge.v1",
      status: "ready",
      trust: "quantitative",
      charge: -0.998712,
      nearest_integer: -1,
      integer_error: 0.001288,
      resolved_support: { plane: "xy", support: "layer_profile" },
      quality: {
        valid_vertex_count: 1020,
        total_vertex_count: 1024,
        valid_triangle_count: 1998,
        total_triangle_count: 2000,
        valid_triangle_fraction: 0.999,
      },
      method: {
        id: "berg_luscher_solid_angle_v1",
        quantity_id: "m",
      },
      provenance: {
        field_revision: 12,
        mesh_revision: 4,
        domain_generation_id: 3,
        mesh_generation_id: 2,
        requested_execution: { backend: "cuda", device: "gpu:0", precision: "double", mode: "strict" },
        resolved_execution: { backend: "cuda", device: "gpu:0", precision: "double", mode: "strict" },
      },
      profile: [
        {
          index: 0,
          coordinate_m: -1e-9,
          integration_weight_m: 1e-9,
          charge: -0.998,
          status: "ready",
          trust: "quantitative",
        },
        {
          index: 1,
          coordinate_m: 1e-9,
          integration_weight_m: 1e-9,
          charge: -0.999,
          status: "ready",
          trust: "quantitative",
        },
      ],
      warnings: [],
    },
  }),
}));

import { TopologicalChargeExtensionPanel } from "./TopologicalChargeExtensionPanel";

describe("TopologicalChargeExtensionPanel parity", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it("renders valid_vertex_count/total_vertex_count, Support profile, Method/Quantity/Schema, all 6 Provenance rows, profile i & Status columns, and method notes", () => {
    const selection: Selection = {
      kind: "object.extension.topological-charge",
      label: "Topological Charge",
      moduleSource: "explorer",
      nodeId: "model:object:disk-1:extension:topological-charge",
      objectId: "disk-1",
      ref: {
        extensionId: "topological-charge",
        kind: "object.extension.topological-charge",
        nodeId: "model:object:disk-1:extension:topological-charge",
        objectId: "disk-1",
        type: "scene-object",
      },
    };

    mounted = mountWave4TestElement(<TopologicalChargeExtensionPanel selection={selection} />);
    const text = mounted.host.textContent ?? "";

    // Vertex + triangle sampling & Support profile
    expect(text).toContain("1020/1024 valid vertices, 1998/2000 valid triangles");
    expect(text).toContain("2 supports, Q(s)=-0.999000..-0.998000");

    // Method / Quantity / Schema + all 6 Provenance rows
    expect(text).toContain("berg_luscher_solid_angle_v1");
    expect(text).toContain("fullmag.topological-charge.v1");
    expect(text).toContain("Field revision");
    expect(text).toContain("Mesh revision");
    expect(text).toContain("Domain generation");
    expect(text).toContain("Mesh generation");
    expect(text).toContain("Requested execution");
    expect(text).toContain("Resolved execution");
    expect(text).toContain("cuda / gpu:0 / double");

    // Profile table headers include `i` and `Status`
    const headers = findElements(mounted.host, (el) => el.tagName === "TH").map(
      (th) => th.textContent?.trim(),
    );
    expect(headers).toEqual(["i", "s (nm)", "\u0394s (nm)", "Q(s)", "Status", "Trust"]);

    // Method notes & pure <math> MathML
    expect(text).toContain("Zero, missing, or non-finite vectors are rejected before the solid-angle sum.");
    expect(findElements(mounted.host, (el) => el.tagName.toLowerCase() === "math").length).toBeGreaterThanOrEqual(2);
    expect(text).not.toMatch(/\b(unknown|unavailable)\b/i);
  });
});
