import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { KernelContext } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { SpinInterfaceInspectorPanel } from "./SpinInterfaceInspector";

const known = { id: "nf", kind: "mixing_conductance", normal_side: { object_id: "stack", region_id: "n" }, ferromagnet_side: { object_id: "stack", region_id: "f" }, normal_to_ferromagnet: [0, 0, 1], g_up_Spm2: 1, g_down_Spm2: 2, g_r_Spm2: 3, g_i_Spm2: 4, spin_memory_loss: { formula_version: "sml_reservoir.fullmag.v2", g_n_Spm2: 1, g_f_Spm2: 2, g_lattice_Spm2: 3 }, formula_version: "magnetoelectronic.fullmag.v2", absorption: "full_absorption" };
const opaque = { id: "future", kind: "vendor.interface.v9", exact: { preserve: true } };

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  SPIN_INTERFACES_RESOURCE_KEY: "interfaces",
  SPIN_TRANSPORTS_RESOURCE_KEY: "transports",
  useSpinInterfacesResource: () => ({ data: { scene_revision: 4, items: [
    { owner_spin_transport_id: "spin", interface_id: "nf", known: true, interface: known },
    { owner_spin_transport_id: "spin", interface_id: "future", known: false, interface: opaque },
  ] }, status: "ready" }),
  useSpinTransportsResource: () => ({ data: { scene_revision: 4, items: [{ id: "spin", interfaces: [known, opaque] }] }, status: "ready" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ useSessionStatusSelector: (selector: (value: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: { m1_one_way_steady: { authoring_allowed: true, reason: "M1", status: "semantic_only" } } } } }) }));

const kernel = { api: { model: {} }, resources: { invalidate: vi.fn() } } as unknown as KernelApi;
function selection(index: number, id: string): Selection { return { kind: "physics.spin-interface", label: id, moduleSource: "explorer", nodeId: id, objectId: null, ref: { kind: "physics.spin-interface", nodeId: id, spinInterfaceId: id, spinInterfaceIndex: index, spinInterfaceOwnerId: "spin", type: "spin-interface" } }; }

describe("SpinInterfaceInspectorPanel", () => {
  it("renders owner selection for the interface collection root", () => {
    const root: Selection = { kind: "physics.spin-interfaces", label: "Spin Interfaces", moduleSource: "explorer", nodeId: "model:physics:spin-interfaces", objectId: null, ref: { kind: "physics.spin-interfaces", nodeId: "model:physics:spin-interfaces", type: "spin-interface" } };
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={root} /></KernelContext.Provider>);
    expect(html).toContain("Owning spin transport");
    expect(html).toContain("spin");
  });

  it("renders a known mixing interface as model-specific typed SI fields", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={selection(0, "nf")} /></KernelContext.Provider>);
    expect(html).toContain("Normal-metal object");
    expect(html).toContain("Ferromagnet region");
    expect(html).toContain("S/m²");
    expect(html).toContain("magnetoelectronic.fullmag.v2");
    expect(html).toContain("0, 0, 1");
  });

  it("renders an unknown interface losslessly without mutation controls", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinInterfaceInspectorPanel selection={selection(1, "future")} /></KernelContext.Provider>);
    expect(html).toContain("vendor.interface.v9");
    expect(html).toContain("preserve");
    expect(html).toContain("read-only");
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
  });
});
