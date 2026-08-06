export const FDM_DISPLAY_CELL_BUDGET = 120_000;

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
