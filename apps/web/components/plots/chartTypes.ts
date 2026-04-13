/**
 * @module components/plots/chartTypes
 *
 * Type definitions, preset configurations, and quantity group catalog
 * for the Charts viewport quantity selector.
 *
 * ## Architecture
 *
 * Two levels of series identity coexist:
 *
 * 1. **Flat scalar keys** (`"mx"`, `"e_total"`) — used for v1 scalar_rows
 *    compatibility. `activeSeriesKeys` in `ChartState` uses these.
 *
 * 2. **Semantic `ChartSeriesSpec`** — the target model for v2+ where each
 *    series carries scope, quantity, reducer, and component. This type is
 *    defined here but not yet consumed by the UI; it exists so the
 *    persistence layer and selector can evolve toward it without a rewrite.
 *
 * The quantity groups can be built either from the hardcoded fallback
 * catalog (`FALLBACK_QUANTITY_GROUPS`) or dynamically from runtime
 * `QuantityDescriptor[]` via `buildQuantityGroups()`.
 */

import type { QuantityDescriptor } from "@/lib/session/types";

// ─────────────────────────────────────────────────────────────────
// Semantic series model (v2 foundation — §4 of the plan)
// ─────────────────────────────────────────────────────────────────

/** Scope: Universe or a specific ferromagnetic object. */
export type ChartScopeKind = "universe" | "object";

export interface ChartScopeRef {
  kind: ChartScopeKind;
  /** Object id, null for universe scope. */
  id: string | null;
  /** Human-readable label shown in badges. */
  label: string;
}

/** How the raw field is reduced to a scalar timeline value. */
export type ChartReducer =
  | "scalar_native"    // already exists as a scalar_row column
  | "avg_component"    // spatially averaged component (x/y/z)
  | "avg_magnitude"    // spatially averaged |v|
  | "max_magnitude";   // max |v| over domain

/** Vector component selector. */
export type ChartComponent = "x" | "y" | "z" | "magnitude";

/**
 * Fully-qualified series descriptor.
 *
 * This is the target semantic model. For now, scalar-native series
 * can be round-tripped to flat keys via `scalarKeyToSeriesSpec()`.
 */
export interface ChartSeriesSpec {
  /** Stable unique id, e.g. "universe:e_total:scalar_native" */
  id: string;
  scope: ChartScopeRef;
  quantityId: string;
  reducer: ChartReducer;
  component: ChartComponent | null;
  xAxis: "step" | "time";
  label: string;
  unit: string;
}

/**
 * Build a `ChartSeriesSpec` for a scalar-native key.
 * This is the v1 bridge: flat keys → semantic specs.
 */
export function scalarKeyToSeriesSpec(
  key: string,
  xAxis: "step" | "time" = "time",
): ChartSeriesSpec | null {
  const entry = resolveSeriesEntry(key);
  if (!entry) return null;
  return {
    id: `universe:${key}:scalar_native`,
    scope: { kind: "universe", id: null, label: "Universe" },
    quantityId: key,
    reducer: "scalar_native",
    component: null,
    xAxis,
    label: entry.label,
    unit: entry.unit,
  };
}

// ─────────────────────────────────────────────────────────────────
// Sampling config (§11 of the plan)
// ─────────────────────────────────────────────────────────────────

export interface ChartSamplingConfig {
  mode: "auto" | "steps" | "time";
  everyNSteps: number | null;
  everyDt: number | null;
  source: "frontend" | "script" | "backend";
}

// ─────────────────────────────────────────────────────────────────
// Preset system
// ─────────────────────────────────────────────────────────────────

export type ChartPresetId =
  | "energy"
  | "magnetization"
  | "convergence"
  | "timestep"
  | "all";

export interface ChartPresetConfig {
  label: string;
  icon: string;
  yColumns: readonly string[];
}

export const CHART_PRESETS: Record<ChartPresetId, ChartPresetConfig> = {
  energy: {
    label: "Energy",
    icon: "⚡",
    yColumns: ["e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total"],
  },
  magnetization: {
    label: "M avg",
    icon: "🧲",
    yColumns: ["mx", "my", "mz"],
  },
  convergence: {
    label: "Convergence",
    icon: "📉",
    yColumns: ["max_dm_dt", "max_h_eff", "max_h_demag", "max_torque_T"],
  },
  timestep: {
    label: "Δt",
    icon: "⏱",
    yColumns: ["solver_dt"],
  },
  all: {
    label: "All",
    icon: "📊",
    yColumns: [
      "e_total", "max_dm_dt", "solver_dt", "max_h_eff",
      "mx", "my", "mz",
    ],
  },
} as const;

export const PRESET_ORDER: readonly ChartPresetId[] = [
  "energy",
  "magnetization",
  "convergence",
  "timestep",
  "all",
];

// ─────────────────────────────────────────────────────────────────
// Series configuration (flat v1 model)
// ─────────────────────────────────────────────────────────────────

export type SeriesCategory =
  | "magnetization"
  | "energy"
  | "convergence"
  | "solver"
  | "field";

export interface ChartSeriesEntry {
  /** ScalarRow key (e.g. "e_total", "mx") */
  key: string;
  /** Human label */
  label: string;
  /** SI unit string */
  unit: string;
  /** Category for grouping */
  category: SeriesCategory;
  /** Whether this comes from a scalar_row column (true) or needs history (false) */
  scalarNative: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Quantity groups catalog
// ─────────────────────────────────────────────────────────────────

export interface ChartQuantityGroup {
  category: SeriesCategory;
  label: string;
  items: ChartSeriesEntry[];
}

/**
 * Hardcoded fallback catalog — always available even when backend
 * hasn't sent QuantityDescriptor[] yet.
 */
export const FALLBACK_QUANTITY_GROUPS: readonly ChartQuantityGroup[] = [
  {
    category: "magnetization",
    label: "Magnetization",
    items: [
      { key: "mx", label: "m_x avg", unit: "", category: "magnetization", scalarNative: true },
      { key: "my", label: "m_y avg", unit: "", category: "magnetization", scalarNative: true },
      { key: "mz", label: "m_z avg", unit: "", category: "magnetization", scalarNative: true },
    ],
  },
  {
    category: "energy",
    label: "Energy",
    items: [
      { key: "e_ex", label: "E_exchange", unit: "J", category: "energy", scalarNative: true },
      { key: "e_demag", label: "E_demag", unit: "J", category: "energy", scalarNative: true },
      { key: "e_ext", label: "E_external", unit: "J", category: "energy", scalarNative: true },
      { key: "e_ani", label: "E_anisotropy", unit: "J", category: "energy", scalarNative: true },
      { key: "e_dmi", label: "E_DMI", unit: "J", category: "energy", scalarNative: true },
      { key: "e_total", label: "E_total", unit: "J", category: "energy", scalarNative: true },
    ],
  },
  {
    category: "convergence",
    label: "Convergence",
    items: [
      { key: "max_dm_dt", label: "max |dm/dt|", unit: "1/s", category: "convergence", scalarNative: true },
      { key: "max_h_eff", label: "max |H_eff|", unit: "A/m", category: "convergence", scalarNative: true },
      { key: "max_h_demag", label: "max |H_demag|", unit: "A/m", category: "convergence", scalarNative: true },
      { key: "max_torque_T", label: "max |m×B_eff|", unit: "T", category: "convergence", scalarNative: true },
    ],
  },
  {
    category: "solver",
    label: "Solver",
    items: [
      { key: "solver_dt", label: "Δt", unit: "s", category: "solver", scalarNative: true },
    ],
  },
];

// ── Backward compat alias ────────────────────────────────────────

/**
 * @deprecated Use `buildQuantityGroups()` with runtime descriptors instead.
 * Kept for backward compat; points to the fallback catalog.
 */
export const CHART_QUANTITY_GROUPS: readonly ChartQuantityGroup[] = FALLBACK_QUANTITY_GROUPS;

// ── Dynamic quantity group builder ───────────────────────────────

/**
 * Infer a `SeriesCategory` from a `QuantityDescriptor`.
 */
function inferCategory(desc: QuantityDescriptor): SeriesCategory {
  const id = desc.id.toLowerCase();
  if (id.startsWith("e_") || id === "e_total") return "energy";
  if (id.startsWith("m") && desc.normalization_hint === "unit_vector") return "magnetization";
  if (id.startsWith("max_") || id === "solver_dt") return "solver";
  if (desc.kind === "field" || desc.n_comp === 3) return "field";
  return "convergence";
}

/** Well-known scalar_row keys that already exist in ScalarRow. */
const SCALAR_ROW_KEYS = new Set([
  "step", "time", "solver_dt",
  "mx", "my", "mz",
  "e_ex", "e_demag", "e_ext", "e_ani", "e_dmi", "e_total",
  "max_dm_dt", "max_h_eff", "max_h_demag", "max_torque_Apm", "max_torque_T",
]);

/**
 * Build quantity groups by merging the hardcoded fallback catalog with
 * dynamic entries from backend `QuantityDescriptor[]`.
 *
 * Backend descriptors that have `supports_history` and `n_comp === 3`
 * expand into component entries (avg.x, avg.y, avg.z, avg.|v|).
 *
 * Scalar-native quantities from the fallback catalog are always included
 * and take precedence (stable keys, matching ScalarRow columns).
 */
export function buildQuantityGroups(
  descriptors: QuantityDescriptor[],
): ChartQuantityGroup[] {
  // Start with a mutable copy of the fallback
  const groupMap = new Map<SeriesCategory, ChartSeriesEntry[]>();
  for (const group of FALLBACK_QUANTITY_GROUPS) {
    groupMap.set(group.category, [...group.items]);
  }
  const seenKeys = new Set(
    FALLBACK_QUANTITY_GROUPS.flatMap((g) => g.items.map((i) => i.key)),
  );

  for (const desc of descriptors) {
    // Skip if already covered by fallback scalar entries
    if (desc.scalar_metric_key && seenKeys.has(desc.scalar_metric_key)) continue;

    // Skip non-history, non-scalar-metric quantities
    if (!desc.supports_history && !desc.scalar_metric_key) continue;
    if (!desc.available) continue;

    const category = inferCategory(desc);

    // Scalar metric quantity not in fallback → add as scalar_native
    if (desc.scalar_metric_key && SCALAR_ROW_KEYS.has(desc.scalar_metric_key)) {
      if (seenKeys.has(desc.scalar_metric_key)) continue;
      const items = groupMap.get(category) ?? [];
      items.push({
        key: desc.scalar_metric_key,
        label: desc.label,
        unit: desc.unit,
        category,
        scalarNative: true,
      });
      groupMap.set(category, items);
      seenKeys.add(desc.scalar_metric_key);
      continue;
    }

    // History-capable vector quantity → expand to avg components
    if (desc.supports_history && desc.n_comp === 3) {
      const items = groupMap.get("field") ?? [];
      for (const comp of ["x", "y", "z", "magnitude"] as const) {
        const key = `${desc.id}.avg.${comp}`;
        if (seenKeys.has(key)) continue;
        const suffix = comp === "magnitude" ? "|" + desc.label + "|" : `${desc.label}.${comp}`;
        items.push({
          key,
          label: `${suffix} avg`,
          unit: desc.unit,
          category: "field",
          scalarNative: false,
        });
        seenKeys.add(key);
      }
      groupMap.set("field", items);
      continue;
    }

    // History-capable scalar quantity
    if (desc.supports_history && desc.n_comp === 1) {
      const key = `${desc.id}.avg`;
      if (seenKeys.has(key)) continue;
      const items = groupMap.get(category) ?? [];
      items.push({
        key,
        label: `${desc.label} avg`,
        unit: desc.unit,
        category,
        scalarNative: false,
      });
      groupMap.set(category, items);
      seenKeys.add(key);
    }
  }

  // Category display order
  const ORDER: SeriesCategory[] = ["magnetization", "energy", "convergence", "field", "solver"];
  const LABELS: Record<SeriesCategory, string> = {
    magnetization: "Magnetization",
    energy: "Energy",
    convergence: "Convergence",
    field: "Fields (history)",
    solver: "Solver",
  };

  return ORDER
    .filter((cat) => (groupMap.get(cat)?.length ?? 0) > 0)
    .map((cat) => ({
      category: cat,
      label: LABELS[cat],
      items: groupMap.get(cat)!,
    }));
}

// ── Flat lookup ──────────────────────────────────────────────────

/** Flat lookup map: key → entry (built from fallback, extended at runtime) */
let entryMap: Map<string, ChartSeriesEntry> | null = null;

function getEntryMap(): Map<string, ChartSeriesEntry> {
  if (!entryMap) {
    entryMap = new Map(
      FALLBACK_QUANTITY_GROUPS.flatMap((group) =>
        group.items.map((item) => [item.key, item]),
      ),
    );
  }
  return entryMap;
}

/** Update the entry map with dynamically-resolved groups. */
export function extendEntryMap(groups: ChartQuantityGroup[]): void {
  const map = getEntryMap();
  for (const group of groups) {
    for (const item of group.items) {
      if (!map.has(item.key)) {
        map.set(item.key, item);
      }
    }
  }
}

/** Resolve a scalar key to its series metadata. */
export function resolveSeriesEntry(
  key: string,
): ChartSeriesEntry | undefined {
  return getEntryMap().get(key);
}

/** All available scalar keys. */
export function allSeriesKeys(): string[] {
  return [...getEntryMap().keys()];
}

// ─────────────────────────────────────────────────────────────────
// X-axis options
// ─────────────────────────────────────────────────────────────────

export interface XAxisOption {
  key: string;
  label: string;
  unit: string;
}

export const X_AXIS_OPTIONS: readonly XAxisOption[] = [
  { key: "time", label: "Time", unit: "auto" },
  { key: "step", label: "Step", unit: "" },
] as const;

// ─────────────────────────────────────────────────────────────────
// Chart state (v1 — flat keys, evolves to ChartSeriesSpec[])
// ─────────────────────────────────────────────────────────────────

export interface ChartState {
  xColumn: string;
  activeSeriesKeys: string[];
  activePreset: ChartPresetId | null;
  selectedDomain: string | null;
}

export const DEFAULT_CHART_STATE: ChartState = {
  xColumn: "time",
  activeSeriesKeys: [...CHART_PRESETS.energy.yColumns],
  activePreset: "energy",
  selectedDomain: null,
};

// ─────────────────────────────────────────────────────────────────
// Series colors
// ─────────────────────────────────────────────────────────────────

const SERIES_PALETTE = [
  "#60a5fa", // blue-400
  "#34d399", // emerald-400
  "#f472b6", // pink-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#fb923c", // orange-400
  "#38bdf8", // sky-400
  "#e879f9", // fuchsia-400
  "#4ade80", // green-400
  "#f87171", // red-400
  "#22d3ee", // cyan-400
  "#facc15", // yellow-400
] as const;

/** Stable color assignment for a series key at a given index. */
export function seriesColor(index: number): string {
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}
