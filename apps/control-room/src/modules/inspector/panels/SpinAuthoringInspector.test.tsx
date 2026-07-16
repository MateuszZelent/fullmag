import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { KernelContext } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { buildTorque, OerstedFieldInspectorPanel, SpinTorqueInspectorPanel } from "./SpinAuthoringInspector";

const torque = { kind: "zhang_li", id: "selected-torque", current_density: [7, 8, 9], degree: 0.73, beta: 0.21 };
const oersted = { kind: "oersted_cylinder", id: "selected-oersted", center: [1, 2, 3], axis: [0, 1, 0], radius: 4e-9, current: 5 };
const unknownTorque = { kind: "vendor_torque.v9", id: "opaque-torque", exact: { preserve: [1, 2, 3] } };
const prescribedSot = { kind: "prescribed_sot", id: "sot", drive: { kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }, xi_dl: 0.12, xi_fl: -0.03, formula_version: "prescribed_sot.fullmag.v1", schema_version: "prescribed_sot.v1", free_layer_thickness_m: 1e-9 };

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  CURRENT_TRANSPORTS_RESOURCE_KEY: "current",
  OERSTED_FIELDS_RESOURCE_KEY: "oersted",
  SPIN_TORQUES_RESOURCE_KEY: "torque",
  useCurrentTransportsResource: () => ({ data: { items: [], scene_revision: 9 }, status: "ready" }),
  useOerstedFieldsResource: () => ({ data: { items: [oersted], scene_revision: 9 }, status: "ready" }),
  useSpinTorquesResource: () => ({ data: { items: [torque, unknownTorque, prescribedSot], scene_revision: 9 }, status: "ready" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: { m1_one_way_steady: { authoring_allowed: true, reason: "M1", status: "semantic_only" } } } } }),
}));

const kernel = { api: { model: {} }, resources: { invalidate: vi.fn() } } as unknown as KernelApi;

function selection(ref: NonNullable<Selection["ref"]>): Selection {
  return { kind: ref.kind, label: ref.kind, moduleSource: "explorer", nodeId: ref.nodeId, objectId: null, ref };
}

describe("dedicated torque and Oersted inspectors", () => {
  it("initializes a selected torque draft from the exact selected payload", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinTorqueInspectorPanel selection={selection({ kind: "physics.spin-torque", nodeId: "torque", spinTorqueId: "selected-torque", spinTorqueIndex: 0, type: "spin-torque" })} /></KernelContext.Provider>);
    expect(html).toContain("selected-torque");
    expect(html).toContain("0.73");
    expect(html).toContain("0.21");
    expect(html).toContain("7, 8, 9");
  });

  it("initializes a selected Oersted draft from the exact selected payload", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><OerstedFieldInspectorPanel selection={selection({ kind: "physics.oersted-field", nodeId: "oersted", oerstedFieldId: "selected-oersted", oerstedFieldIndex: 0, type: "oersted-field" })} /></KernelContext.Provider>);
    expect(html).toContain("selected-oersted");
    expect(html).toContain("4e-9");
    expect(html).toContain("5");
    expect(html).toContain("1, 2, 3");
  });

  it("renders an unknown selected torque losslessly and never substitutes a default", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinTorqueInspectorPanel selection={selection({ kind: "physics.spin-torque", nodeId: "opaque", spinTorqueId: "opaque-torque", spinTorqueIndex: 1, type: "spin-torque" })} /></KernelContext.Provider>);
    expect(html).toContain("vendor_torque.v9");
    expect(html).toContain("preserve");
    expect(html).not.toContain("spin-torque\n");
    expect(html).not.toContain(">Replace<");
    expect(html).not.toContain(">Delete<");
    expect(html).toContain("read-only");
  });

  it("renders prescribed SOT efficiencies as finite typed fields", () => {
    const html = renderToStaticMarkup(<KernelContext.Provider value={kernel}><SpinTorqueInspectorPanel selection={selection({ kind: "physics.spin-torque", nodeId: "sot", spinTorqueId: "sot", spinTorqueIndex: 2, type: "spin-torque" })} /></KernelContext.Provider>);
    expect(html).toContain("Damping-like efficiency xi_dl");
    expect(html).toContain("Field-like efficiency xi_fl");
    expect(html).toContain("0.12");
    expect(html).toContain("-0.03");
  });

  it("builds exact mutation payloads with SOT efficiencies only on prescribed_sot", () => {
    const base = { beta: "0", compatibilityOrigin: "", currentDensity: "1, 0, 0", currentSource: "charge", degree: "0.4", drive: JSON.stringify({ kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }), epsilonPrime: "0", fixedLayerPosition: "", formulaVersion: "prescribed_sot.fullmag.v1", freeLayerThickness: "1e-9", id: "sot", kind: "prescribed_sot" as const, lambdaAsymmetry: "1", rawSpinPolarization: "", realization: "", schemaVersion: "prescribed_sot.v1", spinPolarization: "0, 0, 1", stackNormal: "", target: "", xiDl: "0.12", xiFl: "-0.03" };
    const sot = buildTorque(base) as Record<string, unknown>;
    expect(sot).toMatchObject({ kind: "prescribed_sot", xi_dl: 0.12, xi_fl: -0.03 });
    const slon = buildTorque({ ...base, kind: "slonczewski", formulaVersion: "slonczewski.fullmag.v1", schemaVersion: "" }) as Record<string, unknown>;
    expect(slon).not.toHaveProperty("xi_dl");
    expect(slon).not.toHaveProperty("xi_fl");
  });
});
