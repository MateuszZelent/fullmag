import type { AntennaSourceSpectrumResource, AntennaSpectrumPayloadKind } from "../apiTypes";

type SpectrumPayloadManifest = Pick<AntennaSourceSpectrumResource,
  "amplitude_count" | "amplitude_unit" | "component" | "component_labels" |
  "k_u_count" | "k_v_count" | "normalization" | "payloads" | "power_count" |
  "quantity" | "wave_vector_unit"
>;

export interface AntennaSpectrumPayloadByteLengths {
  payloads: Record<AntennaSpectrumPayloadKind, number>;
  total: number;
}

function positiveCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Antenna spectrum ${label} must be a positive safe integer.`);
  }
  return value;
}

function safeProduct(left: number, right: number, label: string): number {
  if (left > Math.floor(Number.MAX_SAFE_INTEGER / right)) {
    throw new Error(`Antenna spectrum ${label} exceeds safe integer precision.`);
  }
  return left * right;
}

/** Validate binary descriptors before GET; this is not a browser memory policy. */
export function antennaSpectrumPayloadByteLengths(
  spectrum: SpectrumPayloadManifest,
): AntennaSpectrumPayloadByteLengths {
  const u = positiveCount(spectrum.k_u_count, "k_u count");
  const v = positiveCount(spectrum.k_v_count, "k_v count");
  const cells = safeProduct(u, v, "k-grid count");
  const labels = spectrum.component === "vector_power" ? ["x", "y", "z"]
    : ["x", "y", "z", "u", "v", "normal"].includes(spectrum.component)
      ? [spectrum.component] : null;
  if (spectrum.quantity !== "H_ant_source_spectrum" || !labels ||
      !Array.isArray(spectrum.component_labels) ||
      spectrum.component_labels.length !== labels.length ||
      labels.some((label, index) => spectrum.component_labels[index] !== label)) {
    throw new Error("Antenna spectrum quantity or component layout is incompatible.");
  }
  const amplitudeCount = safeProduct(cells, labels.length, "amplitude count");
  if (positiveCount(spectrum.power_count, "power count") !== cells ||
      positiveCount(spectrum.amplitude_count, "amplitude count") !== amplitudeCount) {
    throw new Error("Antenna spectrum counts do not match its k-grid and components.");
  }
  const amplitudeUnit = spectrum.normalization === "integral_si" ? "A*m/A"
    : spectrum.normalization === "unitary_discrete" ? "A/m/A" : null;
  if (!amplitudeUnit || spectrum.amplitude_unit !== amplitudeUnit ||
      spectrum.wave_vector_unit !== "rad/m") {
    throw new Error("Antenna spectrum normalization or SI units are incompatible.");
  }
  const expected = {
    k_u_rad_per_m: { count: u, layout: "axis_u_1d", unit: "rad/m" },
    k_v_rad_per_m: { count: v, layout: "axis_v_1d", unit: "rad/m" },
    amplitudes_re_im: { count: safeProduct(amplitudeCount, 2, "complex scalar count"), layout: "component_kv_ku_complex_re_im", unit: amplitudeUnit },
    power: { count: cells, layout: "kv_ku_power", unit: `(${amplitudeUnit})^2` },
  };
  const payloads = {} as Record<AntennaSpectrumPayloadKind, number>;
  let total = 0;
  for (const kind of Object.keys(expected) as AntennaSpectrumPayloadKind[]) {
    const descriptor = spectrum.payloads?.[kind];
    const contract = expected[kind];
    if (!descriptor || descriptor.scalar_type !== "float64_le" ||
        descriptor.layout !== contract.layout || descriptor.unit !== contract.unit ||
        descriptor.value_count !== contract.count ||
        typeof descriptor.sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(descriptor.sha256)) {
      throw new Error(`Antenna spectrum ${kind} descriptor is incompatible.`);
    }
    const bytes = safeProduct(contract.count, 8, `${kind} byte count`);
    if (total > Number.MAX_SAFE_INTEGER - bytes) {
      throw new Error("Antenna spectrum total byte count exceeds safe integer precision.");
    }
    payloads[kind] = bytes;
    total += bytes;
  }
  return { payloads, total };
}
