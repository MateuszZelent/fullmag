import type { AntennaFieldSolutionResource } from "@/kernel/api/apiTypes";

export const MAX_FIELD_BASIS_PREVIEW_SAMPLES = 8;

export function fieldBasisSamplingDomain(solution: AntennaFieldSolutionResource): string {
  const carrier = solution.sample_carrier;
  if (!carrier) return "Unrecorded (legacy asset)";
  switch (carrier.domain.kind) {
    case "global": return "Global domain";
    case "object": return `Object: ${carrier.domain.object_id}`;
    case "region": return `Region: ${carrier.domain.object_id}/${carrier.domain.region_id}`;
  }
}

type Basis = AntennaFieldSolutionResource["bases"][number];

export function selectedFieldBasisPort(
  solution: AntennaFieldSolutionResource,
  preferredPort: string,
): string {
  return solution.bases.some((basis) => basis.port_mode_id === preferredPort)
    ? preferredPort
    : solution.bases[0]?.port_mode_id ?? "";
}

export interface AntennaFieldSample {
  positionM: [number, number, number];
  fieldApmPerA: [number, number, number];
}

export function fieldBasisPreviewCount(
  solution: AntennaFieldSolutionResource,
  basis: Basis,
): number {
  const positions = solution.sample_positions;
  const field = basis.magnetic_field_per_ampere;
  if (
    positions.scalar_type !== "float64_le" ||
    field.scalar_type !== "float64_le" ||
    positions.layout !== "sample_xyz_interleaved" ||
    field.layout !== "sample_xyz_interleaved" ||
    positions.unit !== "m" ||
    field.unit !== "A/m/A" ||
    positions.value_count !== field.value_count ||
    !Number.isSafeInteger(positions.value_count) ||
    positions.value_count < 0 ||
    positions.value_count % 3 !== 0
  ) {
    throw new Error("antenna position and H-per-ampere carriers are incompatible");
  }
  return Math.min(MAX_FIELD_BASIS_PREVIEW_SAMPLES, positions.value_count / 3);
}

export function decodeFieldBasisPreview(
  positions: ArrayBuffer,
  field: ArrayBuffer,
  sampleCount: number,
): AntennaFieldSample[] {
  const expectedBytes = sampleCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  if (
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > MAX_FIELD_BASIS_PREVIEW_SAMPLES ||
    positions.byteLength !== expectedBytes ||
    field.byteLength !== expectedBytes
  ) {
    throw new Error("antenna field preview byte range does not match the selected samples");
  }
  const positionView = new DataView(positions);
  const fieldView = new DataView(field);
  return Array.from({ length: sampleCount }, (_, index) => {
    const readVector = (view: DataView): [number, number, number] =>
      [0, 1, 2].map((component) =>
        view.getFloat64((index * 3 + component) * 8, true),
      ) as [number, number, number];
    const positionM = readVector(positionView);
    const fieldApmPerA = readVector(fieldView);
    if ([...positionM, ...fieldApmPerA].some((value) => !Number.isFinite(value))) {
      throw new Error(`antenna field preview sample ${index} contains a non-finite value`);
    }
    return { positionM, fieldApmPerA };
  });
}
