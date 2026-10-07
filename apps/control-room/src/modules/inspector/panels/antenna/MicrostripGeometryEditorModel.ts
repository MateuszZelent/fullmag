import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";

export interface WidthStationDraft {
  rowId: string;
  s: string;
  signalWidthM: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function microstripGeometry(scene: SceneResource | null, objectId: string): JsonObject | null {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = record(object?.geometry);
  return geometry?.geometry_kind === "MicrostripAntennaLayout" ? geometry as JsonObject : null;
}

export function widthStationDraft(geometry: JsonObject, previous: WidthStationDraft[] = []): WidthStationDraft[] {
  const stations = record(geometry.geometry_params)?.stations;
  const rowIds = new Map(previous.filter((station) => station.s.trim() && Number.isFinite(Number(station.s)))
    .map((station) => [Number(station.s), station.rowId]));
  const reservedIds = new Set(previous.map((station) => station.rowId));
  const assignedIds = new Set<string>();
  return Array.isArray(stations) ? stations.map((entry, index) => {
    const station = record(entry);
    const s = String(station?.s ?? "");
    let rowId = s.trim() && Number.isFinite(Number(s)) ? rowIds.get(Number(s)) : undefined;
    if (!rowId || assignedIds.has(rowId)) {
      rowId = `source:${index}:${s}`;
      while (reservedIds.has(rowId) || assignedIds.has(rowId)) rowId += ":new";
    }
    assignedIds.add(rowId);
    return {
      rowId,
      s,
      signalWidthM: String(station?.signal_width_m ?? ""),
    };
  }) : [];
}

function sameNumber(left: string, right: string): boolean {
  return Boolean(left.trim() && right.trim()) && Number.isFinite(Number(left)) && Number(left) === Number(right);
}

/** UI row identity and input formatting are not physical geometry changes. */
export function widthStationsEqual(left: WidthStationDraft[], right: WidthStationDraft[]): boolean {
  return left.length === right.length && left.every((station, index) =>
    sameNumber(station.s, right[index].s) && sameNumber(station.signalWidthM, right[index].signalWidthM));
}

export function insertWidthStation(stations: WidthStationDraft[], rowId: string): WidthStationDraft[] {
  if (stations.length < 2) return stations;
  let widestIndex = 0;
  let widestGap = -Infinity;
  for (let index = 0; index < stations.length - 1; index += 1) {
    const gap = Number(stations[index + 1].s) - Number(stations[index].s);
    if (gap > widestGap) {
      widestGap = gap;
      widestIndex = index;
    }
  }
  if (!Number.isFinite(widestGap) || widestGap <= 0) return stations;
  const left = stations[widestIndex];
  const right = stations[widestIndex + 1];
  const station = {
    rowId,
    s: String((Number(left.s) + Number(right.s)) / 2),
    signalWidthM: String((Number(left.signalWidthM) + Number(right.signalWidthM)) / 2),
  };
  return [...stations.slice(0, widestIndex + 1), station, ...stations.slice(widestIndex + 1)];
}

export function buildMicrostripGeometry(geometry: JsonObject, stations: WidthStationDraft[]): JsonObject {
  if (stations.length < 2) throw new Error("At least two width stations are required.");
  const parsed = stations.map((station, index) => {
    if (!station.s.trim() || !station.signalWidthM.trim()) {
      throw new Error(`Station ${index + 1} requires position and signal width.`);
    }
    const s = Number(station.s);
    const signalWidthM = Number(station.signalWidthM);
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new Error(`Station ${index + 1} position must lie in [0, 1].`);
    }
    if (!Number.isFinite(signalWidthM) || signalWidthM <= 0) {
      throw new Error(`Station ${index + 1} signal width must be positive in m.`);
    }
    if (index > 0 && s <= Number(stations[index - 1].s)) {
      throw new Error("Width station positions must be strictly increasing.");
    }
    return { s, signal_width_m: signalWidthM };
  });
  if (parsed[0].s !== 0 || parsed.at(-1)?.s !== 1) {
    throw new Error("Width stations must start at s=0 and end at s=1.");
  }
  const params = record(geometry.geometry_params);
  if (geometry.geometry_kind !== "MicrostripAntennaLayout" || !params) {
    throw new Error("A canonical MicrostripAntennaLayout is required.");
  }
  return {
    geometry_kind: "MicrostripAntennaLayout",
    geometry_params: { ...params, stations: parsed } as JsonObject,
  };
}
