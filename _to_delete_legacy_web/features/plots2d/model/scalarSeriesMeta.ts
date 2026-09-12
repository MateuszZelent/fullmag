/**
 * @module features/plots2d/model/scalarSeriesMeta
 *
 * Scalar series metadata catalog — builds ScalarSeriesMeta[]
 * from hardcoded fallback entries and runtime QuantityDescriptors.
 */

import type { QuantityDescriptor } from "@/lib/session/types";
import type { ScalarSeriesMeta, ScalarSeriesKind } from "./plot2dTypes";

// ─────────────────────────────────────────────────────────────────
// Hardcoded fallback catalog
// ─────────────────────────────────────────────────────────────────

const FALLBACK_SERIES: ScalarSeriesMeta[] = [
  // Magnetization
  { key: "mx", label: "m_x avg", unit: "", kind: "magnetization", scope: "universe", native: true, group: "magnetization" },
  { key: "my", label: "m_y avg", unit: "", kind: "magnetization", scope: "universe", native: true, group: "magnetization" },
  { key: "mz", label: "m_z avg", unit: "", kind: "magnetization", scope: "universe", native: true, group: "magnetization" },

  // Energy
  { key: "e_ex", label: "E_exchange", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },
  { key: "e_demag", label: "E_demag", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },
  { key: "e_ext", label: "E_external", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },
  { key: "e_ani", label: "E_anisotropy", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },
  { key: "e_dmi", label: "E_DMI", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },
  { key: "e_total", label: "E_total", unit: "J", kind: "energy", scope: "universe", native: true, group: "energy" },

  // Convergence / diagnostics
  { key: "max_dm_dt", label: "max |dm/dt|", unit: "1/s", kind: "torque", scope: "universe", native: true, group: "convergence" },
  { key: "max_h_eff", label: "max |H_eff|", unit: "A/m", kind: "field", scope: "universe", native: true, group: "convergence" },
  { key: "max_h_demag", label: "max |H_demag|", unit: "A/m", kind: "field", scope: "universe", native: true, group: "convergence" },
  { key: "max_torque_Apm", label: "max |m×H_eff|", unit: "A/m", kind: "torque", scope: "universe", native: true, group: "convergence" },
  { key: "max_torque_T", label: "max |m×B_eff|", unit: "T", kind: "torque", scope: "universe", native: true, group: "convergence" },

  // Solver
  { key: "solver_dt", label: "Δt", unit: "s", kind: "solver", scope: "universe", native: true, group: "solver" },
];

// ─────────────────────────────────────────────────────────────────
// Build from descriptors
// ─────────────────────────────────────────────────────────────────

function inferKind(desc: QuantityDescriptor): ScalarSeriesKind {
  const id = desc.id.toLowerCase();
  if (id.startsWith("e_") || id === "e_total") return "energy";
  if (id.startsWith("m") && desc.normalization_hint === "unit_vector") return "magnetization";
  if (id.startsWith("max_") || id.includes("torque")) return "torque";
  if (desc.kind === "field" || desc.n_comp === 3) return "field";
  if (id === "solver_dt") return "solver";
  return "custom";
}

function inferGroup(kind: ScalarSeriesKind): string {
  switch (kind) {
    case "energy": return "energy";
    case "magnetization": return "magnetization";
    case "torque":
    case "field": return "convergence";
    case "solver": return "solver";
    default: return "custom";
  }
}

/**
 * Build the full series metadata catalog from backend descriptors.
 *
 * Hardcoded fallback entries always take precedence (stable keys).
 * Backend descriptors extend the catalog with dynamic entries.
 */
export function buildScalarSeriesMeta(
  descriptors: QuantityDescriptor[],
): ScalarSeriesMeta[] {
  const seenKeys = new Set(FALLBACK_SERIES.map((s) => s.key));
  const result = [...FALLBACK_SERIES];

  for (const desc of descriptors) {
    if (!desc.available) continue;

    // Scalar metric key from backend → native entry
    if (desc.scalar_metric_key && !seenKeys.has(desc.scalar_metric_key)) {
      const kind = inferKind(desc);
      result.push({
        key: desc.scalar_metric_key,
        label: desc.label,
        unit: desc.unit,
        kind,
        scope: "universe",
        native: true,
        group: inferGroup(kind),
      });
      seenKeys.add(desc.scalar_metric_key);
      continue;
    }

    // History-capable vector → expand to component entries
    if (desc.supports_history && desc.n_comp === 3) {
      for (const comp of ["x", "y", "z", "magnitude"] as const) {
        const key = `${desc.id}.avg.${comp}`;
        if (seenKeys.has(key)) continue;
        const suffix = comp === "magnitude" ? `|${desc.label}|` : `${desc.label}.${comp}`;
        result.push({
          key,
          label: `${suffix} avg`,
          unit: desc.unit,
          kind: "field",
          scope: "universe",
          native: false,
          reducer: "avg",
          component: comp,
          group: "fields",
        });
        seenKeys.add(key);
      }
      continue;
    }

    // History-capable scalar → add as avg
    if (desc.supports_history && desc.n_comp === 1) {
      const key = `${desc.id}.avg`;
      if (seenKeys.has(key)) continue;
      const kind = inferKind(desc);
      result.push({
        key,
        label: `${desc.label} avg`,
        unit: desc.unit,
        kind,
        scope: "universe",
        native: false,
        reducer: "avg",
        group: inferGroup(kind),
      });
      seenKeys.add(key);
    }
  }

  return result;
}

/**
 * Get the fallback catalog (no descriptors needed).
 */
export function getFallbackSeriesMeta(): ScalarSeriesMeta[] {
  return [...FALLBACK_SERIES];
}

/**
 * Build a keyed lookup map from a series metadata list.
 */
export function buildSeriesMetaMap(
  meta: ScalarSeriesMeta[],
): Record<string, ScalarSeriesMeta> {
  const map: Record<string, ScalarSeriesMeta> = {};
  for (const entry of meta) {
    map[entry.key] = entry;
  }
  return map;
}

/**
 * Group series by their group name.
 */
export function groupSeriesMeta(
  meta: ScalarSeriesMeta[],
): Array<{ group: string; label: string; items: ScalarSeriesMeta[] }> {
  const groupMap = new Map<string, ScalarSeriesMeta[]>();
  for (const entry of meta) {
    const group = entry.group ?? "other";
    const existing = groupMap.get(group);
    if (existing) {
      existing.push(entry);
    } else {
      groupMap.set(group, [entry]);
    }
  }

  const ORDER = ["magnetization", "energy", "convergence", "fields", "solver", "custom", "other"];
  const LABELS: Record<string, string> = {
    magnetization: "Magnetization",
    energy: "Energy",
    convergence: "Convergence",
    fields: "Fields (history)",
    solver: "Solver",
    custom: "Custom",
    other: "Other",
  };

  return ORDER
    .filter((g) => groupMap.has(g))
    .map((g) => ({
      group: g,
      label: LABELS[g] ?? g,
      items: groupMap.get(g)!,
    }));
}
