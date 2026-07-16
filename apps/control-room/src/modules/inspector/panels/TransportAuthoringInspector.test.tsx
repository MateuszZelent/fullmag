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

const currentItems = [
  { future_kind: "charge.v9", opaque: { value: 1 } },
  { future_kind: "charge.v10", opaque: { value: 2 } },
  futureCurrent,
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
      ],
      scene_revision: 7,
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
});
