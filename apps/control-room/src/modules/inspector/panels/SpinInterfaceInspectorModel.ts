interface InterfaceSurfaceDraft {
  objectId: string;
  surfaceId: string;
  orientation: string;
}

export interface InterfaceDraft {
  absorption: string;
  ferromagnetObject: string;
  ferromagnetRegion: string;
  ferromagnetSurface: InterfaceSurfaceDraft | null;
  formulaVersion: string;
  gSml: string;
  smlFormulaVersion: string;
  gDown: string;
  gI: string;
  gR: string;
  gN: string;
  gF: string;
  gLattice: string;
  gUp: string;
  id: string;
  kind: "transparent" | "mixing_conductance";
  normalObject: string;
  normalRegion: string;
  normalSurface: InterfaceSurfaceDraft | null;
  normalToFerromagnet: string;
  normalAToB: string;
  sideAObject: string;
  sideARegion: string;
  sideBObject: string;
  sideBRegion: string;
}


/** Canonical oriented region traces; these are not realized CAD face IDs. */
export const INTERFACE_TRACE_DIRECTIONS = [
  { surfaceId: "x+", normal: [1, 0, 0], oppositeId: "x-", opposite: [-1, 0, 0] },
  { surfaceId: "x-", normal: [-1, 0, 0], oppositeId: "x+", opposite: [1, 0, 0] },
  { surfaceId: "y+", normal: [0, 1, 0], oppositeId: "y-", opposite: [0, -1, 0] },
  { surfaceId: "y-", normal: [0, -1, 0], oppositeId: "y+", opposite: [0, 1, 0] },
  { surfaceId: "z+", normal: [0, 0, 1], oppositeId: "z-", opposite: [0, 0, -1] },
  { surfaceId: "z-", normal: [0, 0, -1], oppositeId: "z+", opposite: [0, 0, 1] },
] as const;

export function canBindInterfaceTraces(draft: InterfaceDraft): boolean {
  return draft.kind === "mixing_conductance" &&
    Boolean(draft.normalObject.trim() && draft.ferromagnetObject.trim()) &&
    (draft.normalObject !== draft.ferromagnetObject || draft.normalRegion !== draft.ferromagnetRegion);
}

export function bindInterfaceTraces(draft: InterfaceDraft, surfaceId: string): Partial<InterfaceDraft> {
  if (!canBindInterfaceTraces(draft)) throw new Error("Select two distinct interface scopes before binding their traces.");
  const direction = INTERFACE_TRACE_DIRECTIONS.find((item) => item.surfaceId === surfaceId);
  if (!direction) throw new Error("Select a canonical axis trace direction.");
  return {
    normalToFerromagnet: direction.normal.join(", "),
    normalSurface: { objectId: draft.normalObject, surfaceId: direction.surfaceId, orientation: direction.normal.join(", ") },
    ferromagnetSurface: { objectId: draft.ferromagnetObject, surfaceId: direction.oppositeId, orientation: direction.opposite.join(", ") },
  };
}

export function interfaceTraceSelection(draft: InterfaceDraft): string {
  const normal = draft.normalSurface;
  const ferromagnet = draft.ferromagnetSurface;
  if (!normal && !ferromagnet) return "";
  if (!normal || !ferromagnet || normal.objectId !== draft.normalObject || ferromagnet.objectId !== draft.ferromagnetObject) return "stored";
  try {
    const same = (value: string, expected: readonly number[]) => vector(value, "Trace orientation").every((component, index) => component === expected[index]);
    return INTERFACE_TRACE_DIRECTIONS.find((direction) =>
      normal.surfaceId === direction.surfaceId && ferromagnet.surfaceId === direction.oppositeId &&
      same(normal.orientation, direction.normal) && same(ferromagnet.orientation, direction.opposite) &&
      same(draft.normalToFerromagnet, direction.normal)
    )?.surfaceId ?? "stored";
  } catch {
    return "stored";
  }
}

const DEFAULT_INTERFACE: InterfaceDraft = {
  absorption: "full_absorption",
  ferromagnetObject: "",
  ferromagnetRegion: "",
  ferromagnetSurface: null,
  formulaVersion: "magnetoelectronic.fullmag.v2",
  gSml: "",
  smlFormulaVersion: "sml_reservoir.fullmag.v2",
  gDown: "0",
  gI: "0",
  gR: "0",
  gN: "",
  gF: "",
  gLattice: "",
  gUp: "0",
  id: "interface",
  kind: "transparent",
  normalObject: "",
  normalRegion: "",
  normalSurface: null,
  normalToFerromagnet: "",
  normalAToB: "",
  sideAObject: "",
  sideARegion: "",
  sideBObject: "",
  sideBRegion: "",
};

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string { return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value); }
function vectorText(value: unknown): string { return Array.isArray(value) ? value.join(", ") : ""; }
function finite(value: string, label: string): number { const parsed = Number(value); if (!value.trim() || !Number.isFinite(parsed)) throw new Error(`${label} must be finite.`); return parsed; }
function vector(value: string, label: string): number[] { const parsed = value.split(/[\s,]+/).filter(Boolean).map(Number); if (parsed.length !== 3 || parsed.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} requires three finite components.`); return parsed; }

export function region(value: unknown) {
  const item = record(value);
  return { object: text(item?.object_id), region: text(item?.region_id) };
}

function surfaceDraft(value: unknown): InterfaceSurfaceDraft | null {
  const item = record(value);
  return item ? { objectId: text(item.object_id), surfaceId: text(item.surface_id), orientation: vectorText(item.orientation) } : null;
}

function buildSurface(draft: InterfaceSurfaceDraft) {
  if (!draft.objectId.trim() || !draft.surfaceId.trim()) throw new Error("Surface object and surface id are required.");
  return { object_id: draft.objectId, surface_id: draft.surfaceId, orientation: vector(draft.orientation, "Surface orientation") };
}

export function interfaceDraft(value: unknown): InterfaceDraft {
  const item = record(value);
  if (!item || (item.kind !== "transparent" && item.kind !== "mixing_conductance")) return DEFAULT_INTERFACE;
  const sideA = region(item.side_a);
  const sideB = region(item.side_b);
  const normal = region(item.normal_side);
  const ferromagnet = region(item.ferromagnet_side);
  return {
    absorption: text(item.absorption),
    ferromagnetObject: ferromagnet.object,
    ferromagnetRegion: ferromagnet.region,
    ferromagnetSurface: surfaceDraft(item.ferromagnet_surface),
    formulaVersion: text(item.formula_version),
    gSml: text(item.g_sml_Spm2),
    smlFormulaVersion: text(record(item.spin_memory_loss)?.formula_version) || "sml_reservoir.fullmag.v2",
    gDown: text(item.g_down_Spm2),
    gI: text(item.g_i_Spm2),
    gR: text(item.g_r_Spm2),
    gN: text(record(item.spin_memory_loss)?.g_n_Spm2),
    gF: text(record(item.spin_memory_loss)?.g_f_Spm2),
    gLattice: text(record(item.spin_memory_loss)?.g_lattice_Spm2),
    gUp: text(item.g_up_Spm2),
    id: text(item.id),
    kind: item.kind,
    normalObject: normal.object,
    normalRegion: normal.region,
    normalSurface: surfaceDraft(item.normal_surface),
    normalToFerromagnet: vectorText(item.normal_to_ferromagnet),
    normalAToB: vectorText(item.normal_a_to_b),
    sideAObject: sideA.object,
    sideARegion: sideA.region,
    sideBObject: sideB.object,
    sideBRegion: sideB.region,
  };
}

function regionRef(objectId: string, regionId: string) {
  if (!objectId.trim()) throw new Error("Region object id is required.");
  return { object_id: objectId, ...(regionId.trim() ? { region_id: regionId } : {}) };
}

export function buildInterface(draft: InterfaceDraft): unknown {
  if (!draft.id.trim()) throw new Error("Interface id is required.");
  if (draft.kind === "mixing_conductance" && Boolean(draft.normalSurface) !== Boolean(draft.ferromagnetSurface)) {
    throw new Error("Mixing interface requires both explicit surfaces or neither.");
  }
  return draft.kind === "transparent" ? {
    id: draft.id,
    kind: draft.kind,
    side_a: regionRef(draft.sideAObject, draft.sideARegion),
    side_b: regionRef(draft.sideBObject, draft.sideBRegion),
    normal_a_to_b: vector(draft.normalAToB, "Interface orientation"),
  } : {
    id: draft.id,
    kind: draft.kind,
    normal_side: regionRef(draft.normalObject, draft.normalRegion),
    ferromagnet_side: regionRef(draft.ferromagnetObject, draft.ferromagnetRegion),
    normal_to_ferromagnet: vector(draft.normalToFerromagnet, "Interface orientation"),
    ...(draft.normalSurface && draft.ferromagnetSurface ? {
      normal_surface: buildSurface(draft.normalSurface),
      ferromagnet_surface: buildSurface(draft.ferromagnetSurface),
    } : {}),
    ...(draft.gSml.trim() ? { g_sml_Spm2: finite(draft.gSml, "g_sml") } : {}),
    g_up_Spm2: finite(draft.gUp, "g_up"),
    g_down_Spm2: finite(draft.gDown, "g_down"),
    g_r_Spm2: finite(draft.gR, "g_r"),
    g_i_Spm2: finite(draft.gI, "g_i"),
    formula_version: draft.formulaVersion,
    absorption: draft.absorption,
    ...(draft.gN.trim() || draft.gF.trim() || draft.gLattice.trim() ? {
      spin_memory_loss: {
        g_n_Spm2: finite(draft.gN, "g_n"),
        g_f_Spm2: finite(draft.gF, "g_f"),
        g_lattice_Spm2: finite(draft.gLattice, "g_lattice"),
        formula_version: draft.smlFormulaVersion,
      },
    } : {}),
  };
}

export function reconcileInterfaceDraft(server: InterfaceDraft, local: InterfaceDraft, baseline: InterfaceDraft) {
  const draft = { ...server };
  const conflicts: Array<keyof InterfaceDraft> = [];
  for (const key of Object.keys(server) as Array<keyof InterfaceDraft>) {
    if (JSON.stringify(local[key]) === JSON.stringify(baseline[key])) continue;
    Object.assign(draft, { [key]: local[key] });
    if (JSON.stringify(server[key]) !== JSON.stringify(baseline[key]) && JSON.stringify(server[key]) !== JSON.stringify(local[key])) conflicts.push(key);
  }
  return { draft, conflicts };
}
