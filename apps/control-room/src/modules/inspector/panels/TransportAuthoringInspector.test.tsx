import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { Selection, SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";

import {
  CurrentTransportInspectorPanel,
  SpinTransportInspectorPanel,
} from "./TransportAuthoringInspector";

const currentItems = [
  { future_kind: "charge.v9", opaque: { value: 1 } },
  { future_kind: "charge.v10", opaque: { value: 2 } },
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
        { id: "moved", schema_version: "spin_transport.v1", current_source_id: "charge", mode: "steady", domain: [], materials: [], solver: { engine: "gmres", linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 }, operator_version: "v1", physical_residual_version: "v1" }, requested_execution: { device: "cpu", discretization: "fdm", execution_mode: "strict", precision: "double" }, constitutive_version: "v1" },
        { id: "other", schema_version: "spin_transport.v1", current_source_id: "charge", mode: "steady", domain: [], materials: [], solver: { engine: "gmres", linear: { absolute_tolerance: 1e-12, max_iterations: 10, relative_tolerance: 1e-8 }, operator_version: "v1", physical_residual_version: "v1" }, requested_execution: { device: "cpu", discretization: "fdm", execution_mode: "strict", precision: "double" }, constitutive_version: "v1" },
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
});
