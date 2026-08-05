export const FDM_DISPLAY_CELL_BUDGET = 120_000;

export interface FdmDisplaySampling {
  budget: number;
  displaySamples: number;
  stride: number;
  total: number;
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
