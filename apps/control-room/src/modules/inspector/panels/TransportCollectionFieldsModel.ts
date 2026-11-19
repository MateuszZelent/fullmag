import type { SceneResource } from "@/kernel/api/apiTypes";
export type CollectionRow = Record<string, unknown>;
export function transportRows(value: string): CollectionRow[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Collection requires authored object rows.");
  return parsed as CollectionRow[];
}
export function updateTransportRow(value: string, index: number, path: readonly string[], text: string, _kind: "text" | "number" | "vector" | "reaction" = "text"): string {
  const rows = transportRows(value);
  if (!rows[index] || !path.length) throw new Error("Selected row is unavailable.");
  const row = structuredClone(rows[index]);
  let target = row;
  for (const key of path.slice(0, -1)) {
    const nested = target[key];
    if (nested !== undefined && (nested === null || typeof nested !== "object" || Array.isArray(nested))) throw new Error("Unrecognized nested payload is read-only.");
    target[key] = nested === undefined ? {} : { ...(nested as CollectionRow) };
    target = target[key] as CollectionRow;
  }
  const key = path[path.length - 1];
  if (!text.trim()) delete target[key];
  else target[key] = text;
  return JSON.stringify(rows.map((item, i) => i === index ? row : item));
}
export function transportScopeOptions(scene: SceneResource | null): Array<{ objectId: string; regionId: string; label: string }> {
  return (scene?.objects ?? []).flatMap((object) => [
    { objectId: object.id, regionId: "", label: object.name || object.id },
    ...(object.regions ?? []).flatMap((region) => {
      const regionId = region.region_id;
      return region.enabled !== false && typeof regionId === "string" && regionId.trim()
        ? [{ objectId: object.id, regionId, label: `${object.name || object.id} / ${region.name || regionId}` }]
        : [];
    }),
  ]);
}
export const chargeMaterialFields = [["sigma_Spm", "Conductivity", "S/m"], ["sigma_parallel_Spm", "Parallel conductivity", "S/m"], ["sigma_perpendicular_Spm", "Perpendicular conductivity", "S/m"], ["sigma_AHE_Spm", "Anomalous Hall conductivity", "S/m"]] as const;
export const spinMaterialFields = [["sigma_s_Spm", "Spin conductivity", "S/m"], ["lambda_sf_m", "Spin-flip length", "m"], ["lambda_j_m", "Exchange length (or disabled)", "m"], ["lambda_phi_m", "Dephasing length (or disabled)", "m"], ["polarization_p", "Polarization", "1"], ["theta_sh", "Spin Hall angle", "1"], ["spin_capacitance_As_per_V_m3", "Spin capacitance", "A s/(V m³)"], ["density_of_states_per_spin_Jinv_m3", "DOS per spin", "1/(J m³)"], ["capacitance_formula_version", "Capacitance formula version", ""]] as const;
export const chargeBoundaryKinds = ["equipotential_current_terminal", "voltage_electrode", "normal_current_electrode", "insulating"] as const;
export const spinBoundaryKinds = ["spin_insulating", "homogeneous_spin_potential_gradient", "spin_sink", "specified_spin_potential", "specified_spin_flux", "periodic_spin"] as const;
export function changeTransportBoundaryKind(value: string, index: number, kind: string): string {
  const rows = transportRows(value);
  const old = rows[index];
  if (!old || ![...chargeBoundaryKinds, ...spinBoundaryKinds].includes(kind as never)) throw new Error("Unknown boundary kind.");
  const next: CollectionRow = { ...old, kind };
  for (const key of ["potential_V", "outward_current_density_Apm2", "spin_potential_V", "normal_spin_flux_Apm2"]) delete next[key as keyof typeof next];
  if (kind === "periodic_spin") { delete next.surfaces; next.minus_surface = {}; next.plus_surface = {}; }
  else { delete next.minus_surface; delete next.plus_surface; delete next.translation_m; next.surfaces = old.surfaces ?? []; }
  return JSON.stringify(rows.map((row, i) => i === index ? next : row));
}

/** Normalize only canonical numeric paths on a clone immediately before payload construction. */
export function normalizeTransportCollection(value: string, family: "current_transport" | "spin_transport", collection: "materials" | "boundaries"): string {
  const rows = transportRows(value);
  const number = (value: unknown, label: string): number => {
    if ((typeof value !== "string" && typeof value !== "number") || typeof value === "string" && !value.trim() || !Number.isFinite(Number(value))) throw new Error(`${label} must be finite.`);
    return Number(value);
  };
  const scalar = (row: CollectionRow, key: string) => { if (key in row) row[key] = number(row[key], key); };
  const vector = (row: CollectionRow, key: string) => {
    if (!(key in row)) return;
    const raw = row[key];
    const parts = typeof raw === "string" ? raw.split(/[\s,;]+/).filter(Boolean) : raw;
    if (!Array.isArray(parts) || parts.length !== 3) throw new Error(`${key} requires three finite components.`);
    row[key] = parts.map((part) => number(part, key));
  };
  const surface = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) vector(value as CollectionRow, "orientation");
  };
  for (const row of rows) {
    if (collection === "materials") {
      const material = row.material;
      if (!material || typeof material !== "object" || Array.isArray(material)) throw new Error("Material requires authored parameters.");
      const parameters = material as CollectionRow;
      for (const [key] of family === "spin_transport" ? spinMaterialFields : chargeMaterialFields) {
        if (key === "capacitance_formula_version") continue;
        if ((key === "lambda_j_m" || key === "lambda_phi_m") && parameters[key] === "disabled") continue;
        scalar(parameters, key);
      }
    } else {
      scalar(row, "potential_V"); scalar(row, "outward_current_density_Apm2");
      vector(row, "spin_potential_V"); vector(row, "normal_spin_flux_Apm2"); vector(row, "translation_m");
      if (Array.isArray(row.surfaces)) row.surfaces.forEach(surface);
      surface(row.minus_surface); surface(row.plus_surface);
    }
  }
  return JSON.stringify(rows);
}
