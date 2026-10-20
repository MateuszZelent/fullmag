export type AntennaPlaneFrameDraft = { originM: string; axisU: string; axisV: string };

/** Preserve textual cells, including blanks and incomplete exponents. Never truncate legacy text. */
export function antennaVectorDraftCells(value: string): [string, string, string] | null {
  if (!value.trim()) return ["", "", ""];
  if (value.trim().startsWith("[")) {
    try {
      const cells: unknown = JSON.parse(value);
      return Array.isArray(cells) && cells.length === 3 && cells.every(cell => typeof cell === "string") ? cells as [string, string, string] : null;
    } catch { return null; }
  }
  const cells = value.includes(",") ? value.split(",") : value.includes(";") ? value.split(";") : value.trim().split(/\s+/);
  return cells.length === 3 ? cells.map(cell => cell.trim()) as [string, string, string] : null;
}

export const antennaPlaneOrientations = [
  { id: "xy", label: "XY · normal +Z", axisU: "1,0,0", axisV: "0,1,0" },
  { id: "xz", label: "XZ · normal −Y", axisU: "1,0,0", axisV: "0,0,1" },
  { id: "yz", label: "YZ · normal +X", axisU: "0,1,0", axisV: "0,0,1" },
] as const;

export function antennaPlaneOrientation(values: AntennaPlaneFrameDraft): string {
  const u = antennaVectorDraftCells(values.axisU), v = antennaVectorDraftCells(values.axisV);
  if (!u || !v || [...u, ...v].some(cell => !cell.trim() || !Number.isFinite(Number(cell)))) return "custom";
  return antennaPlaneOrientations.find(option => option.axisU.split(",").every((cell,index) => Number(cell) === Number(u[index]))
    && option.axisV.split(",").every((cell,index) => Number(cell) === Number(v[index])))?.id ?? "custom";
}

export function buildAntennaPlaneVector(value: string, label: string): [number, number, number] {
  const cells = antennaVectorDraftCells(value);
  if (!cells || cells.some(cell => !cell.trim() || !Number.isFinite(Number(cell)))) throw new Error(`${label} requires three finite values.`);
  return cells.map(Number) as [number, number, number];
}
