export interface PinnedQuickChart {
  chartId: string;
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
  selectedSeriesIds: readonly string[];
  tableId: string;
  xAxisId: string;
}

export interface QuickChartWorkspaceState {
  pinned: PinnedQuickChart | null;
}

type QuickChartWorkspaceListener = () => void;

const INITIAL_STATE: QuickChartWorkspaceState = { pinned: null };
const MAX_ID_LENGTH = 512;
const MAX_SERIES = 100;
const MAX_UNITS = 40;
const MAX_UNIT_LENGTH = 24;

class QuickChartWorkspaceStore {
  private readonly listeners = new Set<QuickChartWorkspaceListener>();
  private state = INITIAL_STATE;

  getSnapshot = (): QuickChartWorkspaceState => this.state;

  subscribe = (listener: QuickChartWorkspaceListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  pin(chart: PinnedQuickChart | unknown): void {
    const next = parsePinnedQuickChart(chart);
    if (!next) return;
    if (
      this.state.pinned?.chartId === next.chartId &&
      this.state.pinned.tableId === next.tableId &&
      this.state.pinned.xAxisId === next.xAxisId &&
      sameIds(this.state.pinned.selectedSeriesIds, next.selectedSeriesIds) &&
      sameRange(this.state.pinned.range, next.range) &&
      sameRecord(this.state.pinned.displayUnits, next.displayUnits)
    ) {
      return;
    }
    this.state = { pinned: next };
    this.notify();
  }

  clear(): void {
    if (!this.state.pinned) return;
    this.state = INITIAL_STATE;
    this.notify();
  }

  reset(): void {
    this.state = INITIAL_STATE;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function parsePinnedQuickChart(value: unknown): PinnedQuickChart | null {
  if (!isRecord(value) || containsPayload(value)) return null;
  const chartId = parseId(value.chartId);
  const tableId = parseId(value.tableId);
  const xAxisId = parseId(value.xAxisId);
  if (!chartId || !tableId || !xAxisId) return null;
  const prefix = `data.table:${tableId}:${xAxisId}:`;
  // Compatibility owner: Quick Chart descriptor parser.
  // Removal gate: remove yAxisIds after one released Control Room version writes
  // only selectedSeriesIds and migration tests prove no persisted or Explorer
  // descriptor still depends on yAxisIds.
  const selectedSource = Array.isArray(value.selectedSeriesIds)
    ? value.selectedSeriesIds.slice(0, MAX_SERIES)
    : Array.isArray(value.yAxisIds)
      ? value.yAxisIds.slice(0, MAX_SERIES).map((columnId) =>
          typeof columnId === "string" && columnId !== xAxisId
            ? `${prefix}${columnId}`
            : null,
        )
      : [];
  const selectedSeriesIds: string[] = [];
  for (const candidate of selectedSource) {
    if (
      typeof candidate === "string" &&
      candidate.length <= MAX_ID_LENGTH &&
      candidate.startsWith(prefix) &&
      candidate.length > prefix.length &&
      !selectedSeriesIds.includes(candidate)
    ) {
      selectedSeriesIds.push(candidate);
      if (selectedSeriesIds.length >= MAX_SERIES) break;
    }
  }
  return {
    chartId,
    displayUnits: parseDisplayUnits(value.displayUnits),
    range: parseRange(value.range),
    selectedSeriesIds,
    tableId,
    xAxisId,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameRange(
  left: PinnedQuickChart["range"],
  right: PinnedQuickChart["range"],
): boolean {
  return left === right || Boolean(
    left && right && left.fromSI === right.fromSI && left.toSI === right.toSI,
  );
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => right[key] === value);
}

function parseId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
    ? value
    : null;
}

function parseRange(value: unknown): PinnedQuickChart["range"] {
  if (!isRecord(value)) return null;
  return typeof value.fromSI === "number" && Number.isFinite(value.fromSI) &&
      typeof value.toSI === "number" && Number.isFinite(value.toSI) &&
      value.fromSI < value.toSI
    ? { fromSI: value.fromSI, toSI: value.toSI }
    : null;
}

function parseDisplayUnits(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const units: Record<string, string> = {};
  for (const [key, unit] of Object.entries(value)) {
    if (Object.keys(units).length >= MAX_UNITS) break;
    if (
      key.length > 0 && key.length <= MAX_ID_LENGTH &&
      typeof unit === "string" && unit.length <= MAX_UNIT_LENGTH
    ) units[key] = unit;
  }
  return units;
}

function containsPayload(value: Record<string, unknown>): boolean {
  for (const [key, entry] of Object.entries(value)) {
    if (key === "samples" || key === "series" || key === "option") return true;
    if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const quickChartWorkspaceStore = new QuickChartWorkspaceStore();

export function resetQuickChartWorkspaceForTests(): void {
  quickChartWorkspaceStore.reset();
}
