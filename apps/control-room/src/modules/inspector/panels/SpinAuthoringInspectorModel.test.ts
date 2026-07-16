import { describe, expect, it } from "vitest";

import { isUnsupportedSpinAuthoringResource } from "./SpinAuthoringInspectorModel";

describe("spin authoring opaque compatibility records", () => {
  it("keeps future variants inspectable but read-only", () => {
    const future = {
      id: "future",
      kind: "vendor_future_torque",
      nested: { coefficients: [1, 2, 3] },
    };
    expect(isUnsupportedSpinAuthoringResource("spin_torque", future)).toBe(true);
    expect(JSON.parse(JSON.stringify(future))).toEqual(future);
  });

  it("keeps canonical variants writable", () => {
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "zhang_li", current_density: [1, 0, 0], degree: 0.4, beta: 0 })).toBe(false);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_field", model: "from_current_solution", source: "charge" })).toBe(false);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "slonczewski", id: "s", formula_version: "slonczewski.fullmag.v1", schema_version: null, current_density: null, current_source: " charge ", spin_polarization: [0, 0, 1], degree: 0.4, lambda_asymmetry: 1, epsilon_prime: 0, free_layer_thickness_m: null, fixed_layer_position: "top", target: { object_id: "body", region_id: null }, stack_normal: [0, 0, 1], realization: { kind: "thin_layer_homogenized", realization_version: "slonczewski_thin_layer_homogenized.v1" } })).toBe(false);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_cylinder", id: "oe", current: 1, radius: 1e-9, center: [0, 0, 0], axis: [0, 0, 1], time_dependence: { kind: "sinusoidal", frequency_hz: 1e9, phase_rad: 0, offset: 0 } })).toBe(false);
  });

  it("keeps malformed known-kind and future-version records opaque", () => {
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "zhang_li", current_density: [1, 0], degree: 0.4, beta: 0 })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "prescribed_sot", drive: {}, xi_dl: 1, xi_fl: 0, schema_version: "prescribed_sot.v2", formula_version: "prescribed_sot.fullmag.v2" })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_cylinder", axis: [0, 0], center: [0, 0, 0], radius: 1, current: 1 })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { kind: "prescribed_sot", drive: { kind: "constant" }, free_layer_thickness_m: 1e-9, xi_dl: 1, xi_fl: 0, schema_version: "prescribed_sot.v1", formula_version: "prescribed_sot.fullmag.v1" })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_cylinder", axis: [0, 0, 1], center: [0, 0, 0], radius: 1, current: 1, time_dependence: { kind: "pulse", t_on: 0 } })).toBe(true);
    const slon = { kind: "slonczewski", formula_version: "slonczewski.fullmag.v1", spin_polarization: [0, 0, 1], degree: 0.4, lambda_asymmetry: 1, epsilon_prime: 0 };
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, id: null })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, current_source: 3 })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, free_layer_thickness_m: "1e-9" })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, target: { object_id: 3 } })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, realization: { kind: "future", realization_version: "v2" } })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...slon, fixed_layer_position: 4 })).toBe(true);
    const sot = { kind: "prescribed_sot", drive: { kind: "signed_scalar", current_density_Apm2: 1, sigma_hat: [0, 1, 0] }, free_layer_thickness_m: 1e-9, xi_dl: 1, xi_fl: 0, schema_version: "prescribed_sot.v1", formula_version: "prescribed_sot.fullmag.v1" };
    expect(isUnsupportedSpinAuthoringResource("spin_torque", { ...sot, compatibility_origin: { source_ir_version: "v1", authored_kind: 2 } })).toBe(true);
    expect(isUnsupportedSpinAuthoringResource("oersted_field", { kind: "oersted_field", id: null, model: "from_current_solution", source: "charge" })).toBe(true);
  });
});
