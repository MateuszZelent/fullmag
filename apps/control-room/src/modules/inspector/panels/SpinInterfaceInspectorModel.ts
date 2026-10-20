export interface InterfaceDraft {
  absorption: string;
  ferromagnetObject: string;
  ferromagnetRegion: string;
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
  normalToFerromagnet: string;
  normalAToB: string;
  sideAObject: string;
  sideARegion: string;
  sideBObject: string;
  sideBRegion: string;
}

const DEFAULT_INTERFACE: InterfaceDraft = {
  absorption: "transverse_absorption.fullmag.v1",
  ferromagnetObject: "",
  ferromagnetRegion: "",
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
    if (local[key] === baseline[key]) continue;
    Object.assign(draft, { [key]: local[key] });
    if (server[key] !== baseline[key] && server[key] !== local[key]) conflicts.push(key);
  }
  return { draft, conflicts };
}
