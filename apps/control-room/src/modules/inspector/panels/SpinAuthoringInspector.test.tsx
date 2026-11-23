import { describe, expect, it } from "vitest";

import { buildTorque, resolveOerstedCurrentSource, torqueModelPatch } from "./SpinAuthoringInspector.model";
import { torqueCurrentBindingPatch } from "./SpinAuthoringInspectorModel";

describe("dedicated torque and Oersted authoring models", () => {
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

  it("builds exact mutation payloads with SOT efficiencies only on prescribed_sot", () => {
    const base = { beta: "0", compatibilityOrigin: "", currentDensity: "1, 0, 0", currentSource: "charge", degree: "0.4", drive: JSON.stringify({ kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }), epsilonPrime: "0", fixedLayerPosition: "", formulaVersion: "prescribed_sot.fullmag.v1", freeLayerThickness: "1e-9", id: "sot", kind: "prescribed_sot" as const, landeG: "", lambdaAsymmetry: "1", operatorVersion: "", rawSpinPolarization: "", realization: "", schemaVersion: "prescribed_sot.v1", spinPolarization: "0, 0, 1", stackNormal: "", target: "", timeExpression: "", xiDl: "0.12", xiFl: "-0.03" };
    const sot = buildTorque(base) as Record<string, unknown>;
    expect(sot).toMatchObject({ kind: "prescribed_sot", xi_dl: 0.12, xi_fl: -0.03 });
    const slon = buildTorque({ ...base, kind: "slonczewski", formulaVersion: "slonczewski.fullmag.v2", schemaVersion: "" }) as Record<string, unknown>;
    expect(slon).not.toHaveProperty("xi_dl");
    expect(slon).not.toHaveProperty("xi_fl");

    const timeExpression = { source: "heaviside(t-on)*sin(2*pi*f*t)", constants: { f: 4e9, on: 1e-11 }, event_times_s: [1e-11] };
    expect(buildTorque({
      ...base,
      kind: "slonczewski",
      formulaVersion: "slonczewski.fullmag.v2",
      schemaVersion: "",
      currentSource: "",
      timeExpression: JSON.stringify(timeExpression),
    })).toHaveProperty("time_expression", timeExpression);
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
      target: JSON.stringify({ object_id: "track" }), timeExpression: "", xiDl: "0", xiFl: "0",
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
      spinPolarization: "", stackNormal: "", target: "", timeExpression: "", xiDl: "0", xiFl: "0",
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
      spinPolarization: "", stackNormal: "", target: "", timeExpression: "", xiDl: "0", xiFl: "0",
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
