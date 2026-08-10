import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import { KernelContext } from "@/kernel/KernelContext";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  buildTorque,
  OerstedFieldInspectorPanel,
  resolveOerstedCurrentSource,
  SpinTorqueInspectorPanel,
  torqueModelPatch,
} from "./SpinAuthoringInspector";
import { torqueCurrentBindingPatch } from "./SpinAuthoringInspectorModel";

const torque = { kind: "zhang_li", id: "selected-torque", current_density: [7, 8, 9], degree: 0.73, beta: 0.21 };
const oersted = { kind: "oersted_cylinder", id: "selected-oersted", center: [1, 2, 3], axis: [0, 1, 0], radius: 4e-9, current: 5 };
const unknownTorque = { kind: "vendor_torque.v9", id: "opaque-torque", exact: { preserve: [1, 2, 3] } };
const prescribedSot = { kind: "prescribed_sot", id: "sot", drive: { kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }, xi_dl: 0.12, xi_fl: -0.03, formula_version: "prescribed_sot.fullmag.v1", schema_version: "prescribed_sot.v1", free_layer_thickness_m: 1e-9 };
const torqueWithUnavailableSource = {
  kind: "zhang_li",
  id: "torque-with-unavailable-source",
  current_source: "deleted-current",
  degree: 0.4,
  beta: 0.02,
  formula_version: "zhang_li.fullmag.v1",
};
const torqueWithSource = {
  kind: "zhang_li",
  id: "torque-with-source",
  current_source: "object-current",
  degree: 0.4,
  beta: 0.02,
  formula_version: "zhang_li.fullmag.v1",
};

vi.mock("@/kernel/resources/spinAuthoringResources", () => ({
  CURRENT_TRANSPORTS_RESOURCE_KEY: "current",
  OERSTED_FIELDS_RESOURCE_KEY: "oersted",
  SPIN_TORQUES_RESOURCE_KEY: "torque",
  useCurrentTransportsResource: () => ({
    data: {
      items: [{
        coupling: "one_way",
        current_density: [1, 0, 0],
        kind: "current_transport",
        model: "prescribed_density",
        name: "object-current",
        solve_region: "pillar",
      }],
      scene_revision: 9,
    },
    status: "ready",
  }),
  useOerstedFieldsResource: () => ({ data: { items: [oersted], scene_revision: 9 }, status: "ready" }),
  useSpinTorquesResource: () => ({ data: { items: [torque, unknownTorque, prescribedSot, torqueWithUnavailableSource, torqueWithSource], scene_revision: 9 }, status: "ready" }),
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({
  useSessionStatusSelector: (selector: (value: unknown) => unknown) => selector({ data: { capabilities: { transport_authoring: { m1_one_way_steady: { authoring_allowed: true, reason: "M1", status: "semantic_only" } } } } }),
}));

const kernel = { api: { model: {} }, resources: { invalidate: vi.fn() } } as unknown as KernelApi;

function selection(
  ref: NonNullable<Selection["ref"]>,
  objectId: string | null = null,
): Selection {
  return { kind: ref.kind, label: ref.kind, moduleSource: "explorer", nodeId: ref.nodeId, objectId, ref };
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
    expect(html).toContain('data-scope-kind="global"');
    expect(html).toContain("global:physics");
  });

  it("initializes a new torque target from the exact selected region", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTorqueInspectorPanel selection={selection({
          kind: "object.physics",
          nodeId: "model:object:pillar:physics:spin_torque",
          objectId: "pillar",
          regionId: "free",
          type: "scene-object",
          visualizationTargetId: "region:pillar:free",
        }, "pillar")} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('&quot;object_id&quot;: &quot;pillar&quot;');
    expect(html).toContain('&quot;region_id&quot;: &quot;free&quot;');
    expect(html).toContain('data-scope-kind="region"');
    expect(html).toContain("region:pillar:free");
  });

  it("resolves an Oersted source only for one exact current candidate", () => {
    const currents = [
      {
        coupling: "one_way",
        current_density: [1, 0, 0],
        kind: "current_transport",
        model: "prescribed_density",
        name: "object-current",
        solve_region: "pillar",
      },
      {
        boundaries: [],
        coupling: "one_way",
        domain: [{ object_id: "pillar", region_id: "free" }],
        gauge: "dirichlet_reference",
        kind: "current_transport",
        materials: [],
        model: "ohmic_poisson",
        name: "region-current",
        solver: {
          engine: "cg",
          linear: { absolute_tolerance: 1e-14, max_iterations: 100, relative_tolerance: 1e-10 },
          operator_version: "fv_charge_harmonic_v1",
          physical_residual_version: "charge_balance_integrated_l2.v1",
        },
      },
    ];

    expect(resolveOerstedCurrentSource(currents as never, {
      objectId: "pillar",
      regionId: "free",
    })).toBe("region-current");
    expect(resolveOerstedCurrentSource(currents as never, {
      objectId: "pillar",
    })).toBeNull();
    expect(resolveOerstedCurrentSource([currents[0]] as never, {
      objectId: "pillar",
    })).toBe("object-current");
  });

  it("initializes a new global Oersted module from one unambiguous selected-object current", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <OerstedFieldInspectorPanel selection={selection({
          kind: "object.physics",
          nodeId: "model:object:pillar:physics:oersted_field",
          objectId: "pillar",
          type: "scene-object",
          visualizationTargetId: "object:pillar",
        }, "pillar")} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('value="oersted_field" selected=""');
    expect(html).toContain('value="oersted:object-current"');
    expect(html).toContain('<option value="object-current" selected="">object-current</option>');
    expect(html).toContain('data-scope-kind="global"');
    expect(html).toContain("global:physics");
  });

  it("offers graph current modules as typed sources for a source-bound torque", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTorqueInspectorPanel selection={selection({
          kind: "physics.spin-torque",
          nodeId: "torque-with-source",
          spinTorqueId: "torque-with-source",
          spinTorqueIndex: 4,
          type: "spin-torque",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('<option value="current_transport" selected="">Current transport</option>');
    expect(html).toContain("Current source");
    expect(html).toContain('<option value="object-current" selected="">object-current</option>');
    expect(html).not.toContain('aria-label="Current density"');
  });

  it("preserves an unavailable current-source identity as an explicit option", () => {
    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <SpinTorqueInspectorPanel selection={selection({
          kind: "physics.spin-torque",
          nodeId: "torque-with-unavailable-source",
          spinTorqueId: "torque-with-unavailable-source",
          spinTorqueIndex: 3,
          type: "spin-torque",
        })} />
      </KernelContext.Provider>,
    );

    expect(html).toContain('<option value="deleted-current" selected="">deleted-current (unavailable)</option>');
    expect(html).toContain('<option value="object-current">object-current</option>');
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
    const base = { beta: "0", compatibilityOrigin: "", currentDensity: "1, 0, 0", currentSource: "charge", degree: "0.4", drive: JSON.stringify({ kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }), epsilonPrime: "0", fixedLayerPosition: "", formulaVersion: "prescribed_sot.fullmag.v1", freeLayerThickness: "1e-9", id: "sot", kind: "prescribed_sot" as const, landeG: "", lambdaAsymmetry: "1", operatorVersion: "", rawSpinPolarization: "", realization: "", schemaVersion: "prescribed_sot.v1", spinPolarization: "0, 0, 1", stackNormal: "", target: "", xiDl: "0.12", xiFl: "-0.03" };
    const sot = buildTorque(base) as Record<string, unknown>;
    expect(sot).toMatchObject({ kind: "prescribed_sot", xi_dl: 0.12, xi_fl: -0.03 });
    const slon = buildTorque({ ...base, kind: "slonczewski", formulaVersion: "slonczewski.fullmag.v2", schemaVersion: "" }) as Record<string, unknown>;
    expect(slon).not.toHaveProperty("xi_dl");
    expect(slon).not.toHaveProperty("xi_fl");
  });

  it("builds the complete canonical Zhang-Li identity without dropping operator physics", () => {
    const torque = buildTorque({
      beta: "0.02", compatibilityOrigin: "", currentDensity: "1e11, 0, 0",
      currentSource: "", degree: "0.4", drive: "", epsilonPrime: "0",
      fixedLayerPosition: "", formulaVersion: "zhang_li.fullmag.v1",
      freeLayerThickness: "", id: "zl-canonical", kind: "zhang_li",
      landeG: "2.1", lambdaAsymmetry: "1",
      operatorVersion: "zl_central_reference_v1", rawSpinPolarization: "",
      realization: "", schemaVersion: "zhang_li_torque.v1",
      spinPolarization: "", stackNormal: "",
      target: JSON.stringify({ object_id: "track" }), xiDl: "0", xiFl: "0",
    }) as Record<string, unknown>;

    expect(torque).toMatchObject({
      formula_version: "zhang_li.fullmag.v1",
      lande_g: 2.1,
      operator_version: "zl_central_reference_v1",
      schema_version: "zhang_li_torque.v1",
      target: { object_id: "track" },
    });
  });

  it("resets formula identity when the torque model changes", () => {
    const draft = {
      beta: "0", compatibilityOrigin: "", currentDensity: "1, 0, 0",
      currentSource: "", degree: "0.4", drive: "", epsilonPrime: "0",
      fixedLayerPosition: "", formulaVersion: "prescribed_sot.fullmag.v1",
      freeLayerThickness: "", id: "torque", kind: "prescribed_sot" as const,
      landeG: "2.1", lambdaAsymmetry: "1", operatorVersion: "zl_central_reference_v1",
      rawSpinPolarization: "", realization: "", schemaVersion: "prescribed_sot.v1",
      spinPolarization: "", stackNormal: "", target: "", xiDl: "0", xiFl: "0",
    };

    expect(torqueModelPatch(draft, "zhang_li")).toMatchObject({
      kind: "zhang_li",
      formulaVersion: "zhang_li.legacy_fullmag.v0",
      landeG: "",
      operatorVersion: "",
      schemaVersion: "",
    });
    expect(torqueModelPatch(draft, "slonczewski")).toMatchObject({
      kind: "slonczewski",
      formulaVersion: "slonczewski.fullmag.v2",
      schemaVersion: "",
    });
  });

  it("keeps current binding exclusive when switching torque input modes", () => {
    const draft = {
      beta: "0", compatibilityOrigin: "", currentDensity: "1, 0, 0",
      currentSource: "charge", degree: "0.4", drive: "", epsilonPrime: "0",
      fixedLayerPosition: "", formulaVersion: "zhang_li.fullmag.v1",
      freeLayerThickness: "", id: "torque", kind: "zhang_li" as const,
      landeG: "", lambdaAsymmetry: "1", operatorVersion: "zl_central_reference_v1",
      rawSpinPolarization: "", realization: "", schemaVersion: "",
      spinPolarization: "", stackNormal: "", target: "", xiDl: "0", xiFl: "0",
    };

    expect(torqueCurrentBindingPatch(draft, "current_transport")).toEqual({
      currentDensity: "",
      currentSource: "charge",
    });
    expect(torqueCurrentBindingPatch(
      { ...draft, currentSource: "" },
      "current_transport",
      "added-current",
    )).toEqual({
      currentDensity: "",
      currentSource: "added-current",
    });
    expect(torqueCurrentBindingPatch({ ...draft, currentDensity: "", currentSource: "charge" }, "prescribed_density")).toEqual({
      currentDensity: "0, 0, 0",
      currentSource: "",
    });
  });
});
