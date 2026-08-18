export const FDM_DISPLAY_CELL_BUDGET = 150_000;

export interface FdmDisplaySampling {
  budget: number;
  displaySamples: number;
  stride: number;
  total: number;
}

/**
 * Select one deterministic, global display sample for an FDM lattice.
 *
 * The active magnetic-support pass and the outside-support (Airbox) pass must
 * filter this same sample. Sampling each semantic pass independently would
 * multiply the configured display budget and produce a misleading HUD stride.
 */
export function sampleFdmDisplayCellIndices(
  totalCells: number,
  displaySamples: number,
): Uint32Array {
  const total = Math.max(0, Math.floor(totalCells));
  const count = Math.min(total, Math.max(0, Math.floor(displaySamples)));
  const indices = new Uint32Array(count);
  if (count === 0) return indices;

  for (let sample = 0; sample < count; sample += 1) {
    indices[sample] = Math.min(
      total - 1,
      Math.floor((sample * total) / count),
    );
  }
  return indices;
}

/**
 * Selects a bounded, deterministic sample from structured-grid cell ordinals.
 *
 * The old display sampler is intentionally flat because it describes the
 * global display stride. Vector glyphs need a different contract: each
 * occupied spatial bin receives a representative first, then remaining
 * samples are allocated proportionally and evenly inside the bins.
 */
export function sampleFdmSpatialCellIndices(
  candidates: ArrayLike<number>,
  gridShape: readonly [number, number, number],
  sampleBudget: number,
): Uint32Array {
  const budget = Math.max(
    0,
    Math.floor(Number.isFinite(sampleBudget) ? sampleBudget : 0),
  );
  if (budget <= 0 || candidates.length <= 0) return new Uint32Array();

  const shape: [number, number, number] = [
    Math.max(1, Math.floor(Number.isFinite(gridShape[0]) ? gridShape[0] : 1)),
    Math.max(1, Math.floor(Number.isFinite(gridShape[1]) ? gridShape[1] : 1)),
    Math.max(1, Math.floor(Number.isFinite(gridShape[2]) ? gridShape[2] : 1)),
  ];
  const totalCells = shape[0] * shape[1] * shape[2];
  const uniqueCandidates: number[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const cellIndex = Number(candidates[index]);
    if (
      !Number.isSafeInteger(cellIndex) ||
      cellIndex < 0 ||
      cellIndex >= totalCells ||
      seen.has(cellIndex)
    ) {
      continue;
    }
    seen.add(cellIndex);
    uniqueCandidates.push(cellIndex);
  }
  if (uniqueCandidates.length <= budget) {
    return Uint32Array.from(uniqueCandidates);
  }

  const targetCount = Math.min(uniqueCandidates.length, budget);
  const binShape = resolveFdmSpatialBinShape(shape, targetCount);
  const buckets = new Map<number, number[]>();
  for (const cellIndex of uniqueCandidates) {
    const x = cellIndex % shape[0];
    const y = Math.floor(cellIndex / shape[0]) % shape[1];
    const z = Math.floor(cellIndex / (shape[0] * shape[1])) % shape[2];
    const binX = Math.min(
      binShape[0] - 1,
      Math.floor((x * binShape[0]) / shape[0]),
    );
    const binY = Math.min(
      binShape[1] - 1,
      Math.floor((y * binShape[1]) / shape[1]),
    );
    const binZ = Math.min(
      binShape[2] - 1,
      Math.floor((z * binShape[2]) / shape[2]),
    );
    const bucketKey =
      binX +
      binShape[0] * (binY + binShape[1] * binZ);
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.push(cellIndex);
    } else {
      buckets.set(bucketKey, [cellIndex]);
    }
  }

  const bucketEntries = Array.from(buckets.entries()).sort(
    ([left], [right]) => left - right,
  );
  const extraCount = targetCount - bucketEntries.length;
  const extraCapacity = uniqueCandidates.length - bucketEntries.length;
  const allocations = bucketEntries.map(([key, values]) => {
    const capacity = values.length - 1;
    const exactExtra =
      extraCapacity > 0 ? (capacity * extraCount) / extraCapacity : 0;
    const wholeExtra = Math.floor(exactExtra);
    return {
      key,
      remainder: exactExtra - wholeExtra,
      values,
      extra: wholeExtra,
    };
  });
  let allocatedExtra = allocations.reduce(
    (sum, allocation) => sum + allocation.extra,
    0,
  );
  allocations
    .toSorted(
      (left, right) =>
        right.remainder - left.remainder || left.key - right.key,
    )
    .some((allocation) => {
      if (allocatedExtra >= extraCount) return true;
      allocation.extra += 1;
      allocatedExtra += 1;
      return allocatedExtra >= extraCount;
    });

  const selected: number[] = [];
  for (const allocation of allocations) {
    const slotCount = Math.min(
      allocation.values.length,
      allocation.extra + 1,
    );
    for (let slot = 0; slot < slotCount; slot += 1) {
      const sourceIndex = Math.min(
        allocation.values.length - 1,
        Math.floor(((slot + 0.5) * allocation.values.length) / slotCount),
      );
      selected.push(allocation.values[sourceIndex] ?? 0);
    }
  }
  return Uint32Array.from(selected.slice(0, targetCount));
}

function resolveFdmSpatialBinShape(
  [nx, ny, nz]: readonly [number, number, number],
  sampleBudget: number,
): [number, number, number] {
  const base = Math.max(1, Math.floor(Math.cbrt(sampleBudget)));
  const bins: [number, number, number] = [
    Math.min(nx, base),
    Math.min(ny, base),
    Math.min(nz, base),
  ];
  let binCount = bins[0] * bins[1] * bins[2];
  while (true) {
    let selectedAxis = -1;
    let selectedSpan = -Infinity;
    for (const axis of [0, 1, 2] as const) {
      if (bins[axis] >= [nx, ny, nz][axis]) continue;
      const nextBinCount = (binCount * (bins[axis] + 1)) / bins[axis];
      if (nextBinCount > sampleBudget) continue;
      const span = [nx, ny, nz][axis] / bins[axis];
      if (span > selectedSpan) {
        selectedAxis = axis;
        selectedSpan = span;
      }
    }
    if (selectedAxis < 0) break;
    binCount = (binCount * (bins[selectedAxis] + 1)) / bins[selectedAxis];
    bins[selectedAxis] += 1;
  }
  return bins;
}
export function resolveFdmDisplaySampling(
  totalCells: number,
  displayBudget = FDM_DISPLAY_CELL_BUDGET,
): FdmDisplaySampling {
  const total = Math.max(0, Math.floor(totalCells));
  const budget = Math.max(1, Math.floor(displayBudget));
  const displaySamples = Math.min(total, budget);
  return {
    budget,
    displaySamples,
    stride: displaySamples === 0 ? 1 : Math.max(1, Math.ceil(total / displaySamples)),
    total,
  };
}

export function formatFdmDisplaySamplingSummary(
  sampling: FdmDisplaySampling,
): string {
  return [
    `cells ${sampling.total.toLocaleString("en-US")}`,
    `display samples ${sampling.displaySamples.toLocaleString("en-US")}`,
    `stride ${sampling.stride.toLocaleString("en-US")}`,
    `budget ${sampling.budget.toLocaleString("en-US")}`,
  ].join(" · ");
}

