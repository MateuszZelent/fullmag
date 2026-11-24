import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import type { UnitOption } from "../../../template";
import {
  asRecord,
  asString,
  type JsonRecord,
} from "../../../panels/antenna/AntennaCoreHelpers";
import {
  antennaCircuitFields,
  CPW_STATION_FIELDS,
  type WidthStationDraft,
} from "../../../panels/antenna/MicrostripGeometryEditorModel";

export const MU0 = 4 * Math.PI * 1e-7;
export const SCENE_ORIGIN_TARGET_VALUE = "__scene_origin__";

export const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const CONDUCTIVITY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "MS/m", toSiFactor: 1e6 },
  { unit: "kS/m", toSiFactor: 1e3 },
  { unit: "S/m", toSiFactor: 1 },
];

export const IMPEDANCE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "Ω", toSiFactor: 1 },
  { unit: "mΩ", toSiFactor: 1e-3 },
  { unit: "kΩ", toSiFactor: 1e3 },
];

export const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "µA", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

export const VOLTAGE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "V", toSiFactor: 1 },
  { unit: "mV", toSiFactor: 1e-3 },
];

export const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "Hz", toSiFactor: 1 },
];

export const ALL_ANTENNA_TOPOLOGIES = [
  "straight_microstrip",
  "cpw",
  "gsg",
  "meander",
  "inductive_loop",
  "piecewise_3d_path",
  "external_cad_lead",
] as const;

export type AntennaTopologyId = (typeof ALL_ANTENNA_TOPOLOGIES)[number];

export const DEFAULT_LOOP_PARAMETERS: Readonly<Record<string, string>> = {
  inlet_connection_conductivity_s_per_m: "5.96e7",
  inlet_connection_length_m: "200e-9",
  inlet_connection_offset_v_m: "0",
  inlet_connection_part_id: "inlet_bridge",
  inlet_connection_width_m: "120e-9",
  inlet_crossbar_length_m: "50e-9",
  outlet_connection_conductivity_s_per_m: "5.96e7",
  outlet_connection_length_m: "200e-9",
  outlet_connection_offset_v_m: "0",
  outlet_connection_part_id: "outlet_bridge",
  outlet_connection_width_m: "120e-9",
  outlet_crossbar_length_m: "50e-9",
};

export interface Waypoint3DDraft {
  rowId: string;
  xM: number;
  yM: number;
  zM: number;
  bendRadiusM: number;
}

export interface AntennaGeometryAndPlacementDraft {
  topology: AntennaTopologyId;
  lengthM: number;
  signalWidthM: number;
  thicknessM: number;
  conductivitySpm: number;
  returnWidthM: number;
  returnOffsetM: number;
  symmetricCpw: boolean;
  cpwGapM: number;
  cpwRightGapM: number;
  groundWidthM: number;
  rightGroundWidthM: number;
  meanderFingerCount: number;
  meanderPitchM: number;
  meanderBendRadiusM: number;
  loopShape: "circular" | "rectangular" | "omega";
  loopInnerRadiusM: number;
  loopTurns: number;
  loopPitchM: number;
  loopFeedGapM: number;
  stations: readonly WidthStationDraft[];
  waypoints: readonly Waypoint3DDraft[];
  cadAssetId: string;
  cadScaleUnit: "nm" | "um" | "mm" | "m";
  placementTargetId: string;
  standoffSide: "above" | "below";
  standoffGapM: number;
  lateralOffsetXM: number;
  lateralOffsetYM: number;
  inPlaneAngleDeg: number;
  closedLoopEnabled: boolean;
  potentialJumpV: number;
  sourceCutOffsetM: number;
  sourceCutNormal: "positive_axis" | "negative_axis";
  bridgeLengthM: number;
  bridgeWidthM: number;
  bridgeConductivitySpm: number;
  loopParameters: Readonly<Record<string, string>>;
}

export function createDefaultAntennaGeometryDraft(
  topology: AntennaTopologyId = "straight_microstrip",
): AntennaGeometryAndPlacementDraft {
  return {
    bridgeConductivitySpm: 5.96e7,
    bridgeLengthM: 200e-9,
    bridgeWidthM: 120e-9,
    cadAssetId: "cad_lead_1",
    cadScaleUnit: "nm",
    closedLoopEnabled: false,
    conductivitySpm: 5.96e7,
    cpwGapM: 60e-9,
    cpwRightGapM: 60e-9,
    groundWidthM: 200e-9,
    inPlaneAngleDeg: 0,
    lateralOffsetXM: 0,
    lateralOffsetYM: 0,
    lengthM: 2.4e-6,
    loopFeedGapM: 40e-9,
    loopInnerRadiusM: 250e-9,
    loopParameters: { ...DEFAULT_LOOP_PARAMETERS },
    loopPitchM: 250e-9,
    loopShape: "circular",
    loopTurns: 1,
    meanderBendRadiusM: 60e-9,
    meanderFingerCount: 4,
    meanderPitchM: 300e-9,
    placementTargetId: SCENE_ORIGIN_TARGET_VALUE,
    potentialJumpV: 0.25,
    returnOffsetM: 200e-9,
    returnWidthM: 600e-9,
    rightGroundWidthM: 200e-9,
    signalWidthM: 150e-9,
    sourceCutNormal: "positive_axis",
    sourceCutOffsetM: -125e-9,
    standoffGapM: 50e-9,
    standoffSide: "above",
    stations: [
      {
        leftGapM: "60e-9",
        leftGroundWidthM: "200e-9",
        rightGapM: "60e-9",
        rightGroundWidthM: "200e-9",
        rowId: "st:0",
        s: "0",
        signalWidthM: "150e-9",
      },
      {
        leftGapM: "60e-9",
        leftGroundWidthM: "200e-9",
        rightGapM: "60e-9",
        rightGroundWidthM: "200e-9",
        rowId: "st:1",
        s: "1",
        signalWidthM: "150e-9",
      },
    ],
    symmetricCpw: true,
    thicknessM: 50e-9,
    topology,
    waypoints: [
      { bendRadiusM: 20e-9, rowId: "wp:0", xM: -500e-9, yM: 0, zM: 50e-9 },
      { bendRadiusM: 20e-9, rowId: "wp:1", xM: 500e-9, yM: 0, zM: 50e-9 },
    ],
  };
}

function resolveStationScalar(
  stationRaw: string | undefined,
  allStationsRaw: readonly (string | undefined)[],
  topLevelValue: number,
  defaultSeedValue: number,
): number {
  const parsed = stationRaw !== undefined && stationRaw.trim().length > 0 ? Number(stationRaw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return topLevelValue;
  const allAtSeed =
    allStationsRaw.length > 0 &&
    allStationsRaw.every((v) => v !== undefined && Number(v) === defaultSeedValue);
  if (allAtSeed && topLevelValue !== defaultSeedValue) {
    return topLevelValue;
  }
  return parsed;
}

export function buildAntennaTopologyGeometryPayload(
  draft: AntennaGeometryAndPlacementDraft,
): JsonObject {
  switch (draft.topology) {
    case "straight_microstrip": {
      const stationWidths = draft.stations.map((s) => s.signalWidthM);
      const stations = draft.stations.map((st, idx) => ({
        s:
          idx === 0
            ? 0
            : idx === draft.stations.length - 1
              ? 1
              : Number(st.s),
        signal_width_m: resolveStationScalar(
          st.signalWidthM,
          stationWidths,
          draft.signalWidthM,
          150e-9,
        ),
      }));
      return {
        geometry_kind: "MicrostripAntennaLayout",
        geometry_params: {
          conductivity_s_per_m: draft.conductivitySpm,
          length_m: draft.lengthM,
          return_offset_m: draft.returnOffsetM,
          return_width_m: draft.returnWidthM,
          stations:
            stations.length >= 2
              ? stations
              : [
                  { s: 0, signal_width_m: draft.signalWidthM },
                  { s: 1, signal_width_m: draft.signalWidthM },
                ],
          thickness_m: draft.thicknessM,
        },
      };
    }
    case "cpw":
    case "gsg": {
      const symmetric = draft.topology === "gsg" || draft.symmetricCpw;
      const rightGapDefault = symmetric ? draft.cpwGapM : draft.cpwRightGapM;
      const rightGroundDefault = symmetric ? draft.groundWidthM : draft.rightGroundWidthM;

      const stationWidths = draft.stations.map((s) => s.signalWidthM);
      const leftGaps = draft.stations.map((s) => s.leftGapM);
      const rightGaps = draft.stations.map((s) => s.rightGapM);
      const leftGrounds = draft.stations.map((s) => s.leftGroundWidthM);
      const rightGrounds = draft.stations.map((s) => s.rightGroundWidthM);

      const stations =
        draft.stations.length >= 2
          ? draft.stations.map((st, idx) => {
              const leftGap = resolveStationScalar(
                st.leftGapM,
                leftGaps,
                draft.cpwGapM,
                60e-9,
              );
              const leftGround = resolveStationScalar(
                st.leftGroundWidthM,
                leftGrounds,
                draft.groundWidthM,
                200e-9,
              );
              const rightGap = resolveStationScalar(
                st.rightGapM,
                rightGaps,
                rightGapDefault,
                60e-9,
              );
              const rightGround = resolveStationScalar(
                st.rightGroundWidthM,
                rightGrounds,
                rightGroundDefault,
                200e-9,
              );
              return {
                left_gap_m: leftGap,
                left_ground_width_m: leftGround,
                right_gap_m: rightGap,
                right_ground_width_m: rightGround,
                s:
                  idx === 0
                    ? 0
                    : idx === draft.stations.length - 1
                      ? 1
                      : Number(st.s),
                signal_width_m: resolveStationScalar(
                  st.signalWidthM,
                  stationWidths,
                  draft.signalWidthM,
                  150e-9,
                ),
              };
            })
          : [0, 1].map((s) => ({
              left_gap_m: draft.cpwGapM,
              left_ground_width_m: draft.groundWidthM,
              right_gap_m: rightGapDefault,
              right_ground_width_m: rightGroundDefault,
              s,
              signal_width_m: draft.signalWidthM,
            }));

      return {
        geometry_kind: "CPWAntennaLayout",
        geometry_params: {
          conductivity_s_per_m: draft.conductivitySpm,
          length_m: draft.lengthM,
          stations,
          thickness_m: draft.thicknessM,
        },
      };
    }
    case "meander":
      return {
        geometry_kind: "MeanderAntennaLayout",
        geometry_params: {
          bend_radius_m: draft.meanderBendRadiusM,
          conductivity_s_per_m: draft.conductivitySpm,
          finger_count: Math.round(draft.meanderFingerCount),
          length_m: draft.lengthM,
          pitch_m: draft.meanderPitchM,
          signal_width_m: draft.signalWidthM,
          thickness_m: draft.thicknessM,
        },
      };
    case "inductive_loop":
      return {
        geometry_kind: "InductiveLoopLayout",
        geometry_params: {
          conductivity_s_per_m: draft.conductivitySpm,
          feed_gap_m: draft.loopFeedGapM,
          inner_radius_m: draft.loopInnerRadiusM,
          loop_shape: draft.loopShape,
          pitch_m: draft.loopPitchM,
          signal_width_m: draft.signalWidthM,
          thickness_m: draft.thicknessM,
          turns: Math.round(draft.loopTurns),
        },
      };
    case "piecewise_3d_path":
      return {
        geometry_kind: "PiecewisePath3DLayout",
        geometry_params: {
          conductivity_s_per_m: draft.conductivitySpm,
          signal_width_m: draft.signalWidthM,
          thickness_m: draft.thicknessM,
          waypoints: draft.waypoints.map((wp) => ({
            bend_radius_m: wp.bendRadiusM,
            width_m: draft.signalWidthM,
            x_m: wp.xM,
            y_m: wp.yM,
            z_m: wp.zM,
          })),
        },
      };
    case "external_cad_lead":
      return {
        geometry_kind: "ImportedGeometry",
        geometry_params: {
          asset_id: draft.cadAssetId,
          scale_unit: draft.cadScaleUnit,
        },
      };
  }
}

export function resolveTopologyFromGeometry(geometry: JsonRecord | null): AntennaTopologyId {
  const kind = asString(geometry?.geometry_kind);
  if (kind === "CPWAntennaLayout") return "cpw";
  if (kind === "MeanderAntennaLayout") return "meander";
  if (kind === "InductiveLoopLayout") return "inductive_loop";
  if (kind === "PiecewisePath3DLayout") return "piecewise_3d_path";
  if (kind === "ImportedGeometry") return "external_cad_lead";
  return "straight_microstrip";
}

export function validateStationsDraft(
  stations: readonly WidthStationDraft[],
  isCpwLike: boolean,
): string | null {
  if (stations.length < 2) {
    return "At least two width stations (s = 0 and s = 1) are required.";
  }
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i]!;
    const s = Number(st.s);
    const w = Number(st.signalWidthM);
    if (!st.s.trim() || !Number.isFinite(s)) {
      return `Station ${i + 1} position s must be finite.`;
    }
    if (!st.signalWidthM.trim() || !Number.isFinite(w) || w <= 0) {
      return `Station ${i + 1} signal width must be positive in m.`;
    }
    if (i > 0 && s <= Number(stations[i - 1]!.s)) {
      return "Width station positions s must be strictly increasing.";
    }
    if (isCpwLike) {
      for (const field of CPW_STATION_FIELDS) {
        const raw = st[field.key];
        if (raw !== undefined && (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) <= 0)) {
          return `Station ${i + 1} ${field.label} must be positive in m.`;
        }
      }
    }
  }
  if (Number(stations[0]!.s) !== 0 || Number(stations.at(-1)!.s) !== 1) {
    return "Width stations must start at s = 0 and end at s = 1.";
  }
  return null;
}

export function validateWaypointsDraft(waypoints: readonly Waypoint3DDraft[]): string | null {
  if (waypoints.length < 2) {
    return "At least two 3D waypoints are required.";
  }
  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i]!;
    if (
      !Number.isFinite(wp.xM) ||
      !Number.isFinite(wp.yM) ||
      !Number.isFinite(wp.zM) ||
      !Number.isFinite(wp.bendRadiusM) ||
      wp.bendRadiusM < 0
    ) {
      return `Waypoint ${i + 1} coordinates must be finite and bend radius must be non-negative.`;
    }
  }
  return null;
}

export function validateLoopParametersDraft(
  parameters: Readonly<Record<string, string>>,
  geometryKind: string,
): string | null {
  for (const field of antennaCircuitFields({ geometry_kind: geometryKind })) {
    const raw = parameters[field.key] ?? "";
    if (!raw.trim()) {
      return `${field.label} is required when closed-loop return is enabled.`;
    }
    if (field.numeric) {
      const val = Number(raw);
      const mustBePositive = !field.key.endsWith("offset_v_m");
      if (!Number.isFinite(val) || (mustBePositive && val <= 0)) {
        return `${field.label} must be a finite${mustBePositive ? " positive" : ""} SI value.`;
      }
    }
  }
  return null;
}

export function hasFullMicrostripCircuitPrerequisites(
  scene: SceneResource | null | undefined,
  objectId: string,
  geometry: JsonObject,
): boolean {
  if (!scene) return false;
  const params = asRecord(geometry.geometry_params);
  const conductors = Array.isArray(params?.conductors)
    ? params.conductors.map(asRecord)
    : [];
  const hasSignal = conductors.some((c) => typeof c?.id === "string" && c.kind === "signal");
  const hasReturn = conductors.some((c) => typeof c?.id === "string" && c.kind === "return");
  if (!hasSignal || !hasReturn) return false;

  const transports = (scene.current_transports ?? []).filter(
    (ct) =>
      Array.isArray(ct.domain) &&
      ct.domain.length === 1 &&
      asRecord(ct.domain[0])?.object_id === objectId &&
      asRecord(ct.domain[0])?.region_id === undefined &&
      ct.model === "ohmic_poisson" &&
      ct.coupling === "one_way",
  );
  if (transports.length !== 1) return false;

  const matchingPorts = (scene.antenna_port_modes ?? []).filter(
    (p) =>
      p.source_object_id === objectId &&
      p.current_transport_id === transports[0]!.name &&
      Array.isArray(p.branches) &&
      p.branches.length === 2,
  );
  return matchingPorts.length === 1;
}
