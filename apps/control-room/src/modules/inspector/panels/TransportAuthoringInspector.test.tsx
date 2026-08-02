import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { Selection, SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";

import {
  CurrentTransportInspectorPanel,
  SpinTransportInspectorPanel,
} from "./TransportAuthoringInspector";
import { readonlyTransportPayload } from "./TransportAuthoringInspectorModel";

const futureCurrent = {
  coupling: "one_way",
  current_density: [1, 2, 3],
  future_solver_metadata: { exact: ["keep", 7] },
  kind: "current_transport",
  model: "magnetoresistive_poisson.v2",
  name: "future-charge",
};

const futureSpin = {
  boundaries: [],
  constitutive_version: "transport_constitutive.future.fullmag.v2",
  current_source_id: "charge",
  domain: [],
  id: "future-spin",
  interfaces: [],
  materials: [],
  mode: "steady",
  requested_execution: {
    device: "cpu",
    discretization: "fdm",
    execution_mode: "strict",
    precision: "double",
  },
  schema_version: "spin_transport.v1",
  solver: {
    default_external_boundary: "spin_insulating",
    engine: "gmres",
    linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 },
    operator_version: "v2",
    physical_residual_version: "v2",
  },
};

const futureMixingSpin = {
  boundaries: [],
  constitutive_version: "transport_constitutive.one_way.fullmag.v1",
  current_source_id: "charge",
  domain: [],
  id: "future-mixing-spin",
  interfaces: [{
    absorption: "partial_absorption.v2",
    ferromagnet_side: { object_id: "stack", region_id: "free" },
    formula_version: "magnetoelectronic.fullmag.v2",
    g_down_Spm2: 2,
    g_i_Spm2: 3,
    g_r_Spm2: 4,
    spin_memory_loss: { formula_version: "sml_reservoir.fullmag.v2", g_n_Spm2: 1, g_f_Spm2: 2, g_lattice_Spm2: 3 },
    g_up_Spm2: 6,
    id: "nf",
    kind: "mixing_conductance",
    normal_side: { object_id: "stack", region_id: "normal" },
    normal_to_ferromagnet: [1, 0, 0],
  }],
  materials: [],
  mode: "steady",
  requested_execution: {
    device: "cpu",
    discretization: "fdm",
    execution_mode: "strict",
    precision: "double",
  },
  schema_version: "spin_transport.v1",
  solver: {
    default_external_boundary: "spin_insulating",
    engine: "gmres",
    linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 },
    operator_version: "fv_spin_upwind_v1",
    physical_residual_version: "transport_balance_integrated_l2.v1",
  },
};

const currentItems = [
  { future_kind: "charge.v9", opaque: { value: 1 } },
  { future_kind: "charge.v10", opaque: { value: 2 } },
  futureCurrent,
  { current_density: [1, 0, 0], kind: "current_transport", model: "prescribed_density", name: "   " },
];

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  CURRENT_TRANSPORTS_RESOURCE_KEY: "model/current-transports",
  SPIN_TRANSPORTS_RESOURCE_KEY: "model/spin-transports",
  useCurrentTransportsResource: () => ({
    data: { items: currentItems, scene_revision: 7 },
    status: "ready",
  }),
  useSpinTransportsResource: () => ({
    data: {
      items: [
        { id: "moved", schema_version: "spin_transport.v1", current_source_id: "charge", mode: "steady", domain: [], materials: [], solver: { default_external_boundary: "spin_insulating", engine: "gmres", linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 }, operator_version: "fv_spin_upwind_v1", physical_residual_version: "transport_balance_integrated_l2.v1" }, requested_execution: { device: "cpu", discretization: "fdm", execution_mode: "strict", precision: "double" }, constitutive_version: "transport_constitutive.one_way.fullmag.v1" },
        { id: "other", schema_version: "spin_transport.v1", current_source_id: "charge", mode: "steady", domain: [], materials: [], solver: { default_external_boundary: "spin_insulating", engine: "gmres", linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 }, operator_version: "fv_spin_upwind_v1", physical_residual_version: "transport_balance_integrated_l2.v1" }, requested_execution: { device: "cpu", discretization: "fdm", execution_mode: "strict", precision: "double" }, constitutive_version: "transport_constitutive.one_way.fullmag.v1" },
        futureSpin,
        futureMixingSpin,
        { ...futureSpin, constitutive_version: "transport_constitutive.one_way.fullmag.v1", id: "", solver: { ...futureSpin.solver, operator_version: "fv_spin_upwind_v1", physical_residual_version: "transport_balance_integrated_l2.v1" } },
      ],
      scene_revision: 7,
    },
    status: "ready",
  }),
}));

vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: unknown) => unknown) => selector({
    data: {
      capabilities: {
        transport_authoring: {
          contract_version: "spin-transport-capabilities.v1",
          m1_one_way_steady: { authoring_allowed: true, reason: "M1", status: "semantic_only" },
          m2_reciprocal: { authoring_allowed: false, reason: "M2 unavailable", status: "unsupported" },
          m3_transient: { authoring_allowed: false, reason: "M3 unavailable", status: "unsupported" },
          gpu: { authoring_allowed: false, reason: "GPU unavailable", status: "unsupported" },
          single_precision: { authoring_allowed: false, reason: "single unavailable", status: "unsupported" },
          hybrid: { authoring_allowed: false, reason: "hybrid unavailable", status: "unsupported" },
        },
      },
    },
    status: "ready",
  }),
}));

const kernel = {
  api: { model: {} },
  resources: { invalidate: vi.fn() },
} as unknown as KernelApi;

function selection(kind: string, ref: SelectionRef | null = null): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer" as const,
    nodeId: `model:${kind}`,
    objectId: null,
    ref,
  };
}

function textareaContent(markup: string): string {
  const match = markup.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/);
  if (!match) throw new Error("Expected rendered textarea markup.");
  return match[1];
}

function expectedOpaqueTextareaContent(value: unknown): string {
  return textareaContent(renderToStaticMarkup(
    <textarea readOnly value={readonlyTransportPayload(value as never)} />,
  ));
}

describe("TransportAuthoringInspector", () => {
  it("routes the current transport collection to a collision-free creation picker", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <CurrentTransportInspectorPanel selection={selection("physics.current-transports")} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("New resource");
    expect(html).toContain('value="position:0"');
    expect(html).toContain('value="position:1"');
    expect(html).toContain("Create");
  });

  it("renders the stable-id spin record after reorder even when selection carries a stale index", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTransportInspectorPanel selection={selection("physics.spin-transport", {
          kind: "physics.spin-transport",
          nodeId: "model:physics:spin-transports:moved",
          spinTransportId: "moved",
          spinTransportIndex: 1,
          type: "spin-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('value="moved"');
    expect(html).not.toContain('value="other"');
  });

  it("renders a future current model losslessly without edit, Replace, or Delete actions", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <CurrentTransportInspectorPanel selection={selection("physics.current-transport", {
          currentTransportId: "future-charge",
          currentTransportIndex: 0,
          kind: "physics.current-transport",
          nodeId: "model:physics:current-transports:future-charge",
          type: "current-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Unknown transport variant is preserved losslessly and is read-only.");
    expect(textareaContent(html)).toBe(expectedOpaqueTextareaContent(futureCurrent));
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Name<");
    expect(html).not.toContain(">Model<");
  });

  it("renders future spin versions losslessly without edit, Replace, or Delete actions", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTransportInspectorPanel selection={selection("physics.spin-transport", {
          kind: "physics.spin-transport",
          nodeId: "model:physics:spin-transports:future-spin",
          spinTransportId: "future-spin",
          spinTransportIndex: 0,
          type: "spin-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Unknown transport variant is preserved losslessly and is read-only.");
    expect(textareaContent(html)).toBe(expectedOpaqueTextareaContent(futureSpin));
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Schema version<");
    expect(html).not.toContain(">Current source id<");
  });

  it("renders future mixing versions losslessly without mutation actions", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTransportInspectorPanel selection={selection("physics.spin-transport", {
          kind: "physics.spin-transport",
          nodeId: "model:physics:spin-transports:future-mixing-spin",
          spinTransportId: "future-mixing-spin",
          type: "spin-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Unknown transport variant is preserved losslessly and is read-only.");
    expect(textareaContent(html)).toBe(expectedOpaqueTextareaContent(futureMixingSpin));
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Interfaces<");
  });

  it("renders a blank-name current record positionally as read-only", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <CurrentTransportInspectorPanel selection={selection("physics.current-transport", {
          currentTransportIndex: 3,
          kind: "physics.current-transport",
          nodeId: "model:physics:current-transports:position:3",
          type: "current-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Unknown transport variant is preserved losslessly and is read-only.");
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
  });

  it("renders a blank-id spin record positionally as read-only", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTransportInspectorPanel selection={selection("physics.spin-transport", {
          kind: "physics.spin-transport",
          nodeId: "model:physics:spin-transports:position:4",
          spinTransportIndex: 4,
          type: "spin-transport",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain("Unknown transport variant is preserved losslessly and is read-only.");
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
  });
});
