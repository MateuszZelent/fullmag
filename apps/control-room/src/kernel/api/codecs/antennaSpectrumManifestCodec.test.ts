import { describe, expect, it } from "vitest";
import { antennaSpectrumPayloadByteLengths } from "./antennaSpectrumManifestCodec";

type Manifest = Parameters<typeof antennaSpectrumPayloadByteLengths>[0];

function manifest(vector = false, integral = true): Manifest {
  const unit = integral ? "A*m/A" : "A/m/A";
  const amplitudes = vector ? 12 : 4;
  const descriptor = (layout: string, value_count: number, unit: string) => ({
    layout, value_count, unit, scalar_type: "float64_le", sha256: `sha256:${"a".repeat(64)}`, path: "fixture",
  });
  return {
    quantity: "H_ant_source_spectrum", component: vector ? "vector_power" : "x",
    component_labels: vector ? ["x", "y", "z"] : ["x"],
    k_u_count: 2, k_v_count: 2, power_count: 4, amplitude_count: amplitudes,
    normalization: integral ? "integral_si" : "unitary_discrete",
    amplitude_unit: unit, wave_vector_unit: "rad/m",
    payloads: {
      k_u_rad_per_m: descriptor("axis_u_1d", 2, "rad/m"),
      k_v_rad_per_m: descriptor("axis_v_1d", 2, "rad/m"),
      amplitudes_re_im: descriptor("component_kv_ku_complex_re_im", amplitudes * 2, unit),
      power: descriptor("kv_ku_power", 4, `(${unit})^2`),
    },
  };
}

describe("antennaSpectrumPayloadByteLengths", () => {
  it.each([true, false])("accepts canonical scalar/vector descriptors, integral=%s", (integral) => {
    expect(antennaSpectrumPayloadByteLengths(manifest(false, integral))).toEqual({
      payloads: { k_u_rad_per_m: 16, k_v_rad_per_m: 16, amplitudes_re_im: 64, power: 32 }, total: 128,
    });
    expect(antennaSpectrumPayloadByteLengths(manifest(true, integral)).total).toBe(256);
  });

  it.each(["x", "y", "z", "u", "v", "normal"])("accepts supported scalar component %s", (component) => {
    expect(antennaSpectrumPayloadByteLengths({ ...manifest(), component, component_labels: [component] }).total).toBe(128);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid count %s", (k_u_count) => {
    expect(() => antennaSpectrumPayloadByteLengths({ ...manifest(), k_u_count })).toThrow("positive safe integer");
  });

  it.each([
    { quantity: "m" }, { quantity: "H_ant_basis" }, { component: "transverse" }, { component_labels: ["y"] },
    { component: "vector_power", component_labels: ["z", "y", "x"] },
    { power_count: 3 }, { amplitude_count: 3 }, { normalization: "unsupported" },
    { amplitude_unit: "A/m" }, { wave_vector_unit: "1/m" },
  ])("rejects incompatible summary %j", (change) => {
    expect(() => antennaSpectrumPayloadByteLengths({ ...manifest(), ...change })).toThrow();
  });

  it.each([
    { scalar_type: "float32_le" }, { layout: "ku_kv_power" }, { unit: "W" },
    { value_count: 3 }, { sha256: "sha256:invalid" }, { sha256: "a".repeat(64) },
  ])("rejects incompatible binary descriptor %j", (change) => {
    const value = manifest();
    value.payloads!.power = { ...value.payloads!.power, ...change };
    expect(() => antennaSpectrumPayloadByteLengths(value)).toThrow("power descriptor");
  });

  it("rejects absent binary payloads", () => {
    expect(() => antennaSpectrumPayloadByteLengths({ ...manifest(), payloads: null })).toThrow("descriptor");
  });

  it("rejects unsafe grid multiplication before inspecting payloads", () => {
    expect(() => antennaSpectrumPayloadByteLengths({ ...manifest(), k_u_count: Number.MAX_SAFE_INTEGER })).toThrow("k-grid count");
  });

  it("rejects byte overflow after otherwise valid scalar counts", () => {
    const count = Math.floor(Number.MAX_SAFE_INTEGER / 8) + 1;
    const value = manifest();
    value.k_u_count = count; value.k_v_count = 1; value.power_count = count; value.amplitude_count = count;
    value.payloads!.k_u_rad_per_m.value_count = count;
    value.payloads!.k_v_rad_per_m.value_count = 1;
    value.payloads!.amplitudes_re_im.value_count = count * 2;
    value.payloads!.power.value_count = count;
    expect(() => antennaSpectrumPayloadByteLengths(value)).toThrow("byte count");
  });

  it("rejects unsafe complex scalar multiplication before inspecting payloads", () => {
    const count = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    expect(() => antennaSpectrumPayloadByteLengths({
      ...manifest(), k_u_count: count, k_v_count: 1, power_count: count, amplitude_count: count,
    })).toThrow("complex scalar count");
  });

  it("rejects an unsafe total even when each binary length is safe", () => {
    const count = Math.floor(Number.MAX_SAFE_INTEGER / 16);
    const value = manifest();
    value.k_u_count = count; value.k_v_count = 1; value.power_count = count; value.amplitude_count = count;
    value.payloads!.k_u_rad_per_m.value_count = count;
    value.payloads!.k_v_rad_per_m.value_count = 1;
    value.payloads!.amplitudes_re_im.value_count = count * 2;
    value.payloads!.power.value_count = count;
    expect(() => antennaSpectrumPayloadByteLengths(value)).toThrow("total byte count");
  });
});
