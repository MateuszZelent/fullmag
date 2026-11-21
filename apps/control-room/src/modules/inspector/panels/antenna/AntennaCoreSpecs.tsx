"use client";

import {
  Activity,
  Compass,
  Cpu,
  Layers,
  PlugZap,
  Radio,
  Ruler,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  SCENE_RESOURCE_KEY,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec, UnitOption } from "../../template";
import { formatLengthSmart } from "../mesh-details/MeshDomainSpecs";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import {
  insertWidthStation,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";
import { convertRfPortLevel } from "./rfPowerConverter";

const MU0 = 4 * Math.PI * 1e-7;

const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

const CONDUCTIVITY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "MS/m", toSiFactor: 1e6 },
  { unit: "kS/m", toSiFactor: 1e3 },
  { unit: "S/m", toSiFactor: 1 },
];

const IMPEDANCE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "Ω", toSiFactor: 1 },
  { unit: "mΩ", toSiFactor: 1e-3 },
  { unit: "kΩ", toSiFactor: 1e3 },
];

const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "µA", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

const VOLTAGE_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "V", toSiFactor: 1 },
  { unit: "mV", toSiFactor: 1e-3 },
];

const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
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

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// ============================================================================
// 1. object.antenna — AntennaOverviewInspectorSpecPanel
// ============================================================================

interface AntennaOverviewDraft {
  architecture: "solved_conductor" | "regional_mask";
}

export function AntennaOverviewInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "antenna";
  const scene = useSceneResource({ enabled: Boolean(objectId) });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const antennaObj = useMemo(() => {
    const objs = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
    return objs.map(asRecord).find((o) => asString(o?.id) === objectId) ?? null;
  }, [objectId, sceneRec]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;
  const ports = useMemo(() => {
    const raw = Array.isArray(sceneRec?.antenna_port_modes)
      ? sceneRec.antenna_port_modes
      : [];
    return raw
      .map(asRecord)
      .filter((p) => asString(p?.source_object_id) === objectId);
  }, [objectId, sceneRec]);

  const solveStages = useMemo(() => {
    const raw = Array.isArray(sceneRec?.antenna_field_solve_stages)
      ? sceneRec.antenna_field_solve_stages
      : [];
    return raw
      .map(asRecord)
      .filter((s) => asString(s?.source_object_id) === objectId);
  }, [objectId, sceneRec]);

  const hasMaskDrive = useMemo(() => {
    const fieldDrivesState = asRecord(sceneRec?.field_drives);
    const maskList = Array.isArray(sceneRec?.mask_field_drives)
      ? sceneRec.mask_field_drives
      : Array.isArray(asRecord(sceneRec?.mask_field_drives)?.drives)
        ? (asRecord(sceneRec?.mask_field_drives)?.drives as unknown[])
        : Array.isArray(fieldDrivesState?.mask_drives)
          ? (fieldDrivesState.mask_drives as unknown[])
          : [];
    const regionalList = Array.isArray(fieldDrivesState?.drives)
      ? (fieldDrivesState.drives as unknown[])
      : Array.isArray(sceneRec?.field_drives)
        ? sceneRec.field_drives
        : [];
    const matchedMask = maskList.map(asRecord).some((d) => {
      const target = asRecord(d?.target);
      return (
        asString(target?.object_id) === objectId ||
        asString(asRecord(d?.spatial_profile)?.object_id) === objectId ||
        asString(d?.source_object_id) === objectId
      );
    });
    const matchedRegional = regionalList
      .map(asRecord)
      .some((d) => asString(asRecord(d?.spatial_profile)?.object_id) === objectId);
    return matchedMask || matchedRegional;
  }, [objectId, sceneRec]);

  const baseline = useMemo<AntennaOverviewDraft>(
    () => ({
      architecture:
        hasMaskDrive && ports.length === 0 ? "regional_mask" : "solved_conductor",
    }),
    [hasMaskDrive, ports.length],
  );

  const checklistSteps = useMemo(
    () => [
      {
        id: "geometry",
        label: "1. Conductor geometry & standoff placement",
        ready: Boolean(antennaObj?.geometry),
        target: {
          kind: "object.antenna.geometry",
          label: "Geometry & Layout",
          nodeId: `model:object:${objectId}:antenna:geometry`,
          objectId,
          ref: null,
        },
      },
      {
        id: "conductor",
        label: "2. Ohmic conductor conductivity σ",
        ready: Boolean(asRecord(asRecord(antennaObj?.geometry)?.geometry_params)?.conductivity_s_per_m),
        target: {
          kind: "object.antenna.conductor",
          label: "Conductor",
          nodeId: `model:object:${objectId}:antenna:conductor`,
          objectId,
          ref: null,
        },
      },
      {
        id: "terminals",
        label: "3. Current terminals & electrodes",
        ready: true,
        target: {
          kind: "object.antenna.terminals",
          label: "Terminals",
          nodeId: `model:object:${objectId}:antenna:terminals`,
          objectId,
          ref: null,
        },
      },
      {
        id: "port",
        label: "4. RF port impedance Z₀ & branches",
        ready: ports.length > 0,
        target: {
          kind: "object.antenna.port",
          label: "Port 1",
          nodeId: `model:object:${objectId}:antenna:port:${asString(ports[0]?.id) ?? "port_1"}`,
          objectId,
          ref: null,
        },
      },
      {
        id: "solution",
        label: "5. Quasi-static J & Oersted field solve",
        ready: solveStages.length > 0,
        target: {
          kind: "object.antenna.solution",
          label: "Field Solution",
          nodeId: `model:object:${objectId}:antenna:solution:${asString(solveStages[0]?.id) ?? "solve_1"}`,
          objectId,
          ref: null,
        },
      },
      {
        id: "drive",
        label: "6. Waveform drive I(t) & k-space spectrum",
        ready: solveStages.length > 0 && ports.length > 0,
        target: {
          kind: "object.antenna.drive",
          label: "Drive",
          nodeId: `model:object:${objectId}:antenna:drive:drive_1`,
          objectId,
          ref: null,
        },
      },
    ],
    [antennaObj, objectId, ports, solveStages],
  );

  const spec = useMemo<InspectorSpec<AntennaOverviewDraft>>(
    () => ({
      id: "object.antenna",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: {
              kind: "objects.root",
              label: "Objects",
              nodeId: "model:objects",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "obj",
            label: antennaName,
            selection: {
              kind: "object.root",
              label: antennaName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "antenna", label: "Antenna" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "physics",
        entityId: `antenna:${objectId}`,
        icon: Radio,
        kindLabel: "Spin-wave RF excitation subsystem",
        statePill: (d) =>
          d.architecture === "regional_mask"
            ? { label: "Analytical mask", tone: "info" }
            : solveStages.length > 0
              ? { label: "Configured", tone: "ok" }
              : { label: "Setup required", tone: "warn" },
        title: () => `${antennaName} Antenna`,
      },
      facts: (d) => [
        {
          id: "arch",
          label: "Architecture",
          value: d.architecture === "solved_conductor" ? "Solved 3D J → B" : "Regional mask",
        },
        { id: "ports", label: "RF ports", value: String(ports.length) },
        { id: "solves", label: "Field solves", value: String(solveStages.length) },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Radio,
          id: "architecture",
          rows: [
            {
              key: "architecture",
              label: "Excitation architecture",
              options: [
                { label: "Solved 3D Conductor (J → B_ant)", value: "solved_conductor" },
                { label: "Analytical Regional Mask", value: "regional_mask" },
              ],
              structural: true,
              type: "segmented",
            },
          ],
          title: "Antenna excitation architecture",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "readiness-checklist",
          rows: [
            {
              render: (ctx) =>
                ctx.draft.architecture === "regional_mask" ? (
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode({
                        kind: "object.antenna.regional",
                        label: "Regional Field Mask",
                        nodeId: `model:object:${objectId}:antenna:regional`,
                        objectId,
                        ref: null,
                      })
                    }
                  >
                    Open Regional Field Mask Editor
                  </Button>
                ) : (
                  <div className="fm-inspector-stack">
                    {checklistSteps.map((step) => (
                      <div key={step.id} className="fm-inspector-checklist-row">
                        <span>{step.label}</span>
                        <div className="fm-inspector-inline-actions">
                          <Badge variant={step.ready ? "success" : "warning"}>
                            {step.ready ? "Ready" : "Configure"}
                          </Badge>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => ctx.selectNode(step.target)}
                          >
                            Open
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ),
              type: "custom",
              wide: true,
            },
          ],
          title: "6-step antenna readiness checklist",
        },
      ],
      commitBar: {
        cleanMessage: () => "Antenna architecture is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: {
                antenna_architectures: {
                  [objectId]: draft.architecture,
                },
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      antennaName,
      checklistSteps,
      kernel.api.model,
      kernel.resources,
      objectId,
      ports.length,
      sceneRec,
      sessionScopeKey,
      solveStages.length,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 2. object.antenna.geometry — AntennaGeometryInspectorSpecPanel (P0 MA-P0-1)
// ============================================================================

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
    loopPitchM: 250e-9,
    loopShape: "circular",
    loopTurns: 1,
    meanderBendRadiusM: 60e-9,
    meanderFingerCount: 4,
    meanderPitchM: 300e-9,
    placementTargetId: "",
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
      { rowId: "st:0", s: "0", signalWidthM: "150e-9" },
      { rowId: "st:1", s: "1", signalWidthM: "150e-9" },
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

export function buildAntennaTopologyGeometryPayload(
  draft: AntennaGeometryAndPlacementDraft,
): JsonObject {
  switch (draft.topology) {
    case "straight_microstrip": {
      const stations = draft.stations.map((st, idx) => ({
        s: Number(st.s),
        signal_width_m:
          idx === 0 || idx === draft.stations.length - 1
            ? draft.signalWidthM
            : Number(st.signalWidthM) || draft.signalWidthM,
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
      const rightGap = symmetric ? draft.cpwGapM : draft.cpwRightGapM;
      const rightGround = symmetric ? draft.groundWidthM : draft.rightGroundWidthM;
      return {
        geometry_kind: "CPWAntennaLayout",
        geometry_params: {
          conductivity_s_per_m: draft.conductivitySpm,
          length_m: draft.lengthM,
          stations: [
            {
              left_gap_m: draft.cpwGapM,
              left_ground_width_m: draft.groundWidthM,
              right_gap_m: rightGap,
              right_ground_width_m: rightGround,
              s: 0,
              signal_width_m: draft.signalWidthM,
            },
            {
              left_gap_m: draft.cpwGapM,
              left_ground_width_m: draft.groundWidthM,
              right_gap_m: rightGap,
              right_ground_width_m: rightGround,
              s: 1,
              signal_width_m: draft.signalWidthM,
            },
          ],
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

function resolveTopologyFromGeometry(geometry: JsonRecord | null): AntennaTopologyId {
  const kind = asString(geometry?.geometry_kind);
  if (kind === "CPWAntennaLayout") {
    const stations = asRecord(geometry?.geometry_params)?.stations;
    const st0 = Array.isArray(stations) ? asRecord(stations[0]) : null;
    if (
      st0 &&
      asNumber(st0.left_gap_m) === asNumber(st0.right_gap_m) &&
      asNumber(st0.left_ground_width_m) === asNumber(st0.right_ground_width_m)
    ) {
      return "cpw";
    }
    return "cpw";
  }
  if (kind === "MeanderAntennaLayout") return "meander";
  if (kind === "InductiveLoopLayout") return "inductive_loop";
  if (kind === "PiecewisePath3DLayout") return "piecewise_3d_path";
  if (kind === "ImportedGeometry") return "external_cad_lead";
  return "straight_microstrip";
}

function AntennaCrossSectionSchematic({
  draft,
}: {
  draft: AntennaGeometryAndPlacementDraft;
}): ReactNode {
  const isCpwLike = draft.topology === "cpw" || draft.topology === "gsg";
  return (
    <svg
      aria-label="Waveguide cross-section schematic above magnetic film"
      className="fm-antenna-cross-section-svg"
      role="img"
      viewBox="0 0 320 92"
    >
      <rect
        fill="var(--fm-field-bg)"
        height="90"
        rx="6"
        stroke="var(--fm-border-subtle)"
        width="318"
        x="1"
        y="1"
      />
      {isCpwLike ? (
        <>
          <rect
            fill="var(--fm-border-control)"
            height="16"
            rx="2"
            width="58"
            x="24"
            y="18"
          />
          <rect
            fill="var(--fm-accent)"
            height="16"
            rx="2"
            width="76"
            x="122"
            y="18"
          />
          <rect
            fill="var(--fm-border-control)"
            height="16"
            rx="2"
            width="58"
            x="238"
            y="18"
          />
        </>
      ) : (
        <rect
          fill="var(--fm-accent)"
          height="16"
          rx="2"
          width="116"
          x="102"
          y="18"
        />
      )}
      <line
        stroke="var(--fm-text-muted)"
        strokeDasharray="4 3"
        x1="24"
        x2="296"
        y1="48"
        y2="48"
      />
      <rect
        fill="var(--fm-info)"
        fillOpacity="0.35"
        height="14"
        rx="2"
        stroke="var(--fm-info)"
        width="260"
        x="30"
        y="62"
      />
      <text fill="var(--fm-text-secondary)" fontSize="12" x="128" y="14">
        w = {(draft.signalWidthM * 1e9).toFixed(0)} nm
      </text>
      <text fill="var(--fm-text-muted)" fontSize="12" x="218" y="45">
        Δz = {(draft.standoffGapM * 1e9).toFixed(0)} nm
      </text>
    </svg>
  );
}

export function AntennaGeometryInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const objects = useMemo(
    () => (Array.isArray(sceneRec?.objects) ? sceneRec.objects.map(asRecord).filter(Boolean) : []),
    [sceneRec],
  );
  const antennaObj = useMemo(
    () => objects.find((o) => asString(o?.id) === objectId) ?? null,
    [objectId, objects],
  );
  const magneticTargets = useMemo(
    () =>
      objects
        .filter((o) => asString(o?.id) !== objectId)
        .map((o) => ({
          label: `${asString(o?.name) ?? asString(o?.id)} (${asString(o?.id)})`,
          value: asString(o?.id) ?? "",
        }))
        .filter((opt) => opt.value.length > 0),
    [objectId, objects],
  );

  const baseline = useMemo<AntennaGeometryAndPlacementDraft>(() => {
    const base = createDefaultAntennaGeometryDraft();
    const geom = asRecord(antennaObj?.geometry);
    const params = asRecord(geom?.geometry_params);
    const topology = resolveTopologyFromGeometry(geom);
    const stationsRaw = Array.isArray(params?.stations) ? params.stations : [];
    const st0 = asRecord(stationsRaw[0]);
    const transform = asRecord(antennaObj?.transform);
    const tr = Array.isArray(transform?.translation) ? transform.translation : [0, 0, 50e-9];
    const thicknessM = asNumber(params?.thickness_m) ?? base.thicknessM;
    const zTrans = asNumber(tr[2]) ?? 60e-9;

    return {
      ...base,
      conductivitySpm: asNumber(params?.conductivity_s_per_m) ?? base.conductivitySpm,
      cpwGapM: asNumber(st0?.left_gap_m) ?? base.cpwGapM,
      cpwRightGapM: asNumber(st0?.right_gap_m) ?? base.cpwRightGapM,
      groundWidthM: asNumber(st0?.left_ground_width_m) ?? base.groundWidthM,
      lateralOffsetXM: asNumber(tr[0]) ?? 0,
      lateralOffsetYM: asNumber(tr[1]) ?? 0,
      lengthM: asNumber(params?.length_m) ?? base.lengthM,
      loopFeedGapM: asNumber(params?.feed_gap_m) ?? base.loopFeedGapM,
      loopInnerRadiusM: asNumber(params?.inner_radius_m) ?? base.loopInnerRadiusM,
      loopPitchM: asNumber(params?.pitch_m) ?? base.loopPitchM,
      loopTurns: asNumber(params?.turns) ?? base.loopTurns,
      meanderBendRadiusM: asNumber(params?.bend_radius_m) ?? base.meanderBendRadiusM,
      meanderFingerCount: asNumber(params?.finger_count) ?? base.meanderFingerCount,
      meanderPitchM: asNumber(params?.pitch_m) ?? base.meanderPitchM,
      placementTargetId: magneticTargets[0]?.value ?? "",
      returnOffsetM: asNumber(params?.return_offset_m) ?? base.returnOffsetM,
      returnWidthM: asNumber(params?.return_width_m) ?? base.returnWidthM,
      rightGroundWidthM: asNumber(st0?.right_ground_width_m) ?? base.rightGroundWidthM,
      signalWidthM:
        asNumber(params?.signal_width_m) ??
        asNumber(st0?.signal_width_m) ??
        base.signalWidthM,
      standoffGapM: Math.max(1e-9, Math.abs(zTrans) - thicknessM * 0.2),
      standoffSide: zTrans >= 0 ? "above" : "below",
      stations:
        stationsRaw.length >= 2
          ? stationsRaw.map((entry, idx) => {
              const sr = asRecord(entry) ?? {};
              return {
                rowId: `st:${idx}`,
                s: String(sr.s ?? (idx === 0 ? 0 : 1)),
                signalWidthM: String(sr.signal_width_m ?? 150e-9),
              };
            })
          : base.stations,
      thicknessM,
      topology,
    };
  }, [antennaObj, magneticTargets]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const spec = useMemo<InspectorSpec<AntennaGeometryAndPlacementDraft>>(
    () => ({
      id: "object.antenna.geometry",
      header: {
        breadcrumbs: [
          {
            id: "obj",
            label: antennaName,
            selection: {
              kind: "object.root",
              label: antennaName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "geometry", label: "Geometry & Layout" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "geometry",
        entityId: `object:${objectId}:geometry`,
        icon: Ruler,
        kindLabel: "Parametric 3D conductor layout & standoff",
        statePill: () => ({ label: "Committed", tone: "ok" }),
        title: () => `${antennaName} Geometry`,
      },
      facts: (d) => [
        { id: "topo", label: "Topology", value: d.topology.replaceAll("_", " ") },
        { id: "w", label: "Signal w", value: formatLengthSmart(d.signalWidthM) },
        { id: "t", label: "Thickness t", value: formatLengthSmart(d.thicknessM) },
        { id: "gap", label: "Standoff Δz", value: formatLengthSmart(d.standoffGapM) },
      ],
      modeTabs: [
        { id: "layout", label: "Conductor Layout" },
        { id: "placement", label: "Standoff & 3D Placement" },
        { id: "loop", label: "Closed-Loop Return" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Layers,
          id: "cross-section-preview",
          modeTabId: "layout",
          rows: [
            {
              render: (ctx) => <AntennaCrossSectionSchematic draft={ctx.draft} />,
              type: "custom",
              wide: true,
            },
          ],
          title: "Waveguide cross-section schematic",
        },
        {
          defaultOpen: true,
          icon: Ruler,
          id: "conductor-dimensions",
          modeTabId: "layout",
          rows: [
            {
              key: "topology",
              label: "Topology",
              options: [
                {
                  label: "Straight Microstrip — Signal + Return Plane",
                  value: "straight_microstrip",
                },
                { label: "Coplanar Waveguide (CPW)", value: "cpw" },
                { label: "GSG Waveguide — Symmetric Ground–Signal–Ground", value: "gsg" },
                { label: "Meander / U-Turn Grating Antenna", value: "meander" },
                { label: "Inductive Loop / Coil", value: "inductive_loop" },
                { label: "3D Piecewise Path", value: "piecewise_3d_path" },
                { label: "External CAD Lead (STEP / STL / BREP)", value: "external_cad_lead" },
              ],
              structural: true,
              type: "select",
            },
            {
              defaultDisplayUnit: "µm",
              key: "lengthM",
              label: "Conductor length",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) =>
                ["straight_microstrip", "cpw", "gsg", "meander"].includes(d.topology),
              symbol: <>L</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "signalWidthM",
              label: "Signal trace width",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology !== "external_cad_lead",
              symbol: <>w</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "thicknessM",
              label: "Conductor thickness",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology !== "external_cad_lead",
              symbol: <>t</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "returnWidthM",
              label: "Return plane width",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "straight_microstrip",
              symbol: (
                <>
                  w<sub>ret</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "returnOffsetM",
              label: "Vertical return offset",
              min: 0,
              showWhen: (d) => d.topology === "straight_microstrip",
              symbol: (
                <>
                  d<sub>ret</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "symmetricCpw",
              label: "Symmetric left / right gaps & grounds",
              showWhen: (d) => d.topology === "cpw",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "cpwGapM",
              label: "Signal-to-ground gap",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "cpw" || d.topology === "gsg",
              symbol: <>g</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "cpwRightGapM",
              label: "Right signal-to-ground gap",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "cpw" && !d.symmetricCpw,
              symbol: (
                <>
                  g<sub>R</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "groundWidthM",
              label: "Ground strip width",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "cpw" || d.topology === "gsg",
              symbol: (
                <>
                  w<sub>g</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "rightGroundWidthM",
              label: "Right ground strip width",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "cpw" && !d.symmetricCpw,
              symbol: (
                <>
                  w<sub>gR</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "meanderFingerCount",
              label: "Meander finger count",
              max: 64,
              min: 2,
              showWhen: (d) => d.topology === "meander",
              symbol: (
                <>
                  N<sub>f</sub>
                </>
              ),
              type: "number",
            },
            {
              defaultDisplayUnit: "nm",
              key: "meanderPitchM",
              label: "Meander center-to-center pitch",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "meander",
              symbol: <>&Lambda;</>,
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) =>
                val <= d.signalWidthM
                  ? "Meander pitch Λ must exceed signal trace width w."
                  : null,
            },
            {
              defaultDisplayUnit: "nm",
              key: "meanderBendRadiusM",
              label: "U-turn bend radius",
              min: 0,
              showWhen: (d) => d.topology === "meander",
              symbol: (
                <>
                  R<sub>bend</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) =>
                2 * val + d.signalWidthM > d.meanderPitchM
                  ? "2 R_bend + w must not exceed meander pitch Λ."
                  : null,
            },
            {
              format: (d) =>
                d.meanderPitchM > 0
                  ? `${(Math.PI / (d.meanderPitchM * 1e6)).toFixed(2)} rad/µm`
                  : "—",
              label: "Dominant grating wavevector",
              showWhen: (d) => d.topology === "meander",
              symbol: (
                <>
                  k<sub>1</sub>
                </>
              ),
              type: "readonly",
            },
            {
              key: "loopShape",
              label: "Inductive loop shape",
              options: [
                { label: "Circular", value: "circular" },
                { label: "Rectangular", value: "rectangular" },
                { label: "Omega (Ω)", value: "omega" },
              ],
              showWhen: (d) => d.topology === "inductive_loop",
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "loopInnerRadiusM",
              label: "Loop inner radius",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "inductive_loop",
              symbol: (
                <>
                  R<sub>loop</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "loopTurns",
              label: "Planar coil turns",
              max: 16,
              min: 1,
              showWhen: (d) => d.topology === "inductive_loop",
              symbol: (
                <>
                  N<sub>turns</sub>
                </>
              ),
              type: "number",
            },
            {
              columns: [
                {
                  header: "x [nm]",
                  id: "x",
                  mono: true,
                  renderCell: (r) =>
                    ((r as Waypoint3DDraft).xM * 1e9).toFixed(1),
                },
                {
                  header: "y [nm]",
                  id: "y",
                  mono: true,
                  renderCell: (r) =>
                    ((r as Waypoint3DDraft).yM * 1e9).toFixed(1),
                },
                {
                  header: "z [nm]",
                  id: "z",
                  mono: true,
                  renderCell: (r) =>
                    ((r as Waypoint3DDraft).zM * 1e9).toFixed(1),
                },
                {
                  header: "R_bend [nm]",
                  id: "r",
                  mono: true,
                  renderCell: (r) =>
                    ((r as Waypoint3DDraft).bendRadiusM * 1e9).toFixed(1),
                },
              ],
              label: "3D piecewise path waypoints",
              onAddRow: (ctx) => {
                const last = ctx.draft.waypoints.at(-1);
                ctx.setField("waypoints", [
                  ...ctx.draft.waypoints,
                  {
                    bendRadiusM: 20e-9,
                    rowId: `wp:${ctx.draft.waypoints.length}:${Date.now()}`,
                    xM: (last?.xM ?? 0) + 250e-9,
                    yM: last?.yM ?? 0,
                    zM: last?.zM ?? 50e-9,
                  },
                ]);
              },
              rowKey: (r) => (r as Waypoint3DDraft).rowId,
              rows: (d) => d.waypoints,
              showWhen: (d) => d.topology === "piecewise_3d_path",
              type: "table",
              wide: true,
            },
            {
              key: "cadAssetId",
              label: "Imported CAD asset ID",
              mono: true,
              showWhen: (d) => d.topology === "external_cad_lead",
              type: "text",
            },
            {
              key: "cadScaleUnit",
              label: "CAD file length unit",
              options: [
                { label: "Nanometers (nm)", value: "nm" },
                { label: "Micrometers (µm)", value: "um" },
                { label: "Millimeters (mm)", value: "mm" },
                { label: "Meters (m)", value: "m" },
              ],
              showWhen: (d) => d.topology === "external_cad_lead",
              type: "select",
            },
          ],
          title: "Conductor dimensions",
        },
        {
          defaultOpen: false,
          icon: SlidersHorizontal,
          id: "taper-stations",
          modeTabId: "layout",
          rows: [
            {
              columns: [
                {
                  header: "s ∈ [0, 1]",
                  id: "s",
                  mono: true,
                  renderCell: (r) => (r as WidthStationDraft).s,
                },
                {
                  align: "right",
                  header: "w(s) [nm]",
                  id: "w",
                  mono: true,
                  renderCell: (r) =>
                    (Number((r as WidthStationDraft).signalWidthM) * 1e9).toFixed(1),
                },
              ],
              label: "Taper width stations",
              onAddRow: (ctx) => {
                ctx.setField(
                  "stations",
                  insertWidthStation(
                    [...ctx.draft.stations],
                    `st:ins:${ctx.draft.stations.length}`,
                  ),
                );
              },
              rowKey: (r) => (r as WidthStationDraft).rowId,
              rows: (d) => d.stations,
              type: "table",
              wide: true,
            },
          ],
          showWhen: (d) =>
            ["straight_microstrip", "cpw", "gsg"].includes(d.topology),
          summary: (d) => `${d.stations.length} stations`,
          title: "Taper width stations",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "standoff-placement",
          modeTabId: "placement",
          rows: [
            {
              key: "placementTargetId",
              label: "Magnetic placement target",
              options:
                magneticTargets.length > 0
                  ? magneticTargets
                  : [{ label: "Scene origin", value: "" }],
              type: "select",
            },
            {
              key: "standoffSide",
              label: "Placement side",
              options: [
                { label: "Above +Z", value: "above" },
                { label: "Below −Z", value: "below" },
              ],
              type: "segmented",
            },
            {
              defaultDisplayUnit: "nm",
              key: "standoffGapM",
              label: "Standoff gap",
              min: 1e-10,
              minExclusive: true,
              symbol: (
                <>
                  h<sub>gap</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "lateralOffsetXM",
              label: "Lateral offset X",
              symbol: (
                <>
                  &Delta;x
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "lateralOffsetYM",
              label: "Lateral offset Y",
              symbol: (
                <>
                  &Delta;y
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "inPlaneAngleDeg",
              label: "In-plane rotation angle",
              max: 180,
              min: -180,
              step: 5,
              symbol: (
                <>
                  &phi;<sub>z</sub>
                </>
              ),
              type: "number",
              unitSuffix: "deg",
            },
          ],
          title: "Standoff z & 3D placement",
        },
        {
          defaultOpen: true,
          icon: PlugZap,
          id: "closed-loop",
          modeTabId: "loop",
          rows: [
            {
              disabledReason: (d) =>
                d.topology !== "straight_microstrip"
                  ? "Closed-loop bridge closure applies to Straight Microstrip signal + return layouts."
                  : null,
              key: "closedLoopEnabled",
              label: "Enable closed 3D conducting loop",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "V",
              key: "potentialJumpV",
              label: "Source-cut potential jump",
              showWhen: (d) => d.closedLoopEnabled,
              symbol: <>&Delta;V</>,
              type: "quantity",
              units: VOLTAGE_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "sourceCutOffsetM",
              label: "Source-cut Z offset",
              showWhen: (d) => d.closedLoopEnabled,
              symbol: (
                <>
                  z<sub>cut</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "sourceCutNormal",
              label: "Source-cut normal",
              options: [
                { label: "+Z local", value: "positive_axis" },
                { label: "−Z local", value: "negative_axis" },
              ],
              showWhen: (d) => d.closedLoopEnabled,
              type: "segmented",
            },
          ],
          title: "Closed-loop return & voltage cut",
        },
      ],
      commitBar: {
        cleanMessage: () => "Conductor layout & 3D placement are synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const nextGeometry = buildAntennaTopologyGeometryPayload(draft);
          const signZ = draft.standoffSide === "above" ? 1 : -1;
          const zTranslation = signZ * (draft.standoffGapM + draft.thicknessM * 0.5);
          const patchedObjects = objects.map((obj) =>
            asString(obj?.id) === objectId
              ? {
                  ...obj,
                  geometry: nextGeometry,
                  transform: {
                    ...(asRecord(obj?.transform) ?? {}),
                    rotation: [0, 0, (draft.inPlaneAngleDeg * Math.PI) / 180],
                    translation: [
                      draft.lateralOffsetXM,
                      draft.lateralOffsetYM,
                      zTranslation,
                    ],
                  },
                }
              : obj,
          );

          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: {
                objects: patchedObjects,
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      antennaName,
      kernel.api.model,
      kernel.resources,
      magneticTargets,
      objectId,
      objects,
      sceneRec,
      sessionScopeKey,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3. object.antenna.conductor — AntennaConductorInspectorSpecPanel
// ============================================================================

const CONDUCTOR_METALS = [
  { id: "cu", label: "Copper (Cu) — 59.6 MS/m", sigmaSpm: 5.96e7 },
  { id: "au", label: "Gold (Au) — 41.0 MS/m", sigmaSpm: 4.1e7 },
  { id: "al", label: "Aluminum (Al) — 37.7 MS/m", sigmaSpm: 3.77e7 },
  { id: "ag", label: "Silver (Ag) — 63.0 MS/m", sigmaSpm: 6.3e7 },
  { id: "pt", label: "Platinum (Pt) — 9.43 MS/m", sigmaSpm: 9.43e6 },
  { id: "w", label: "Tungsten (W) — 17.9 MS/m", sigmaSpm: 1.79e7 },
  { id: "ta", label: "β-Tantalum (Ta) — 0.53 MS/m", sigmaSpm: 5.3e5 },
] as const;

interface AntennaConductorDraft {
  metalPreset: string;
  conductivitySpm: number;
  referenceFreqHz: number;
}

function matchMetalPreset(sigmaSpm: number): string {
  for (const metal of CONDUCTOR_METALS) {
    if (Math.abs(sigmaSpm - metal.sigmaSpm) / metal.sigmaSpm < 0.015) {
      return metal.id;
    }
  }
  return "custom";
}

export function AntennaConductorInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const objects = useMemo(
    () => (Array.isArray(sceneRec?.objects) ? sceneRec.objects.map(asRecord).filter(Boolean) : []),
    [sceneRec],
  );
  const antennaObj = useMemo(
    () => objects.find((o) => asString(o?.id) === objectId) ?? null,
    [objectId, objects],
  );
  const geomParams = useMemo(
    () => asRecord(asRecord(antennaObj?.geometry)?.geometry_params),
    [antennaObj],
  );
  const thicknessM = asNumber(geomParams?.thickness_m) ?? 50e-9;

  const baseline = useMemo<AntennaConductorDraft>(() => {
    const sigma = asNumber(geomParams?.conductivity_s_per_m) ?? 5.96e7;
    return {
      conductivitySpm: sigma,
      metalPreset: matchMetalPreset(sigma),
      referenceFreqHz: 10e9,
    };
  }, [geomParams]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const spec = useMemo<InspectorSpec<AntennaConductorDraft>>(
    () => ({
      id: "object.antenna.conductor",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "conductor", label: "Conductor" },
        ],
      },
      identity: {
        domain: "material",
        entityId: `cond:${objectId}`,
        icon: Zap,
        kindLabel: "Ohmic charge transport material",
        statePill: () => ({ label: "Committed", tone: "ok" }),
        title: () => `${antennaName} Conductor`,
      },
      facts: (d) => {
        const skinDepthM =
          d.conductivitySpm > 0 && d.referenceFreqHz > 0
            ? 1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm)
            : null;
        const presetLabel =
          CONDUCTOR_METALS.find((m) => m.id === d.metalPreset)?.id.toUpperCase() ??
          "Custom";
        return [
          { id: "metal", label: "Metal preset", value: presetLabel },
          {
            id: "sigma",
            label: "Conductivity σ",
            value:
              d.conductivitySpm > 0
                ? `${(d.conductivitySpm / 1e6).toFixed(2)} MS/m`
                : "Not configured",
          },
          {
            id: "rho",
            label: "Resistivity ρ",
            value:
              d.conductivitySpm > 0
                ? `${((1 / d.conductivitySpm) * 1e8).toFixed(2)} µΩ·cm`
                : null,
          },
          {
            id: "delta",
            label: "Skin depth δ",
            value: formatLengthSmart(skinDepthM),
          },
        ];
      },
      notices: (d): readonly InspectorNotice<AntennaConductorDraft>[] => {
        const skinDepthM =
          d.conductivitySpm > 0 && d.referenceFreqHz > 0
            ? 1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm)
            : null;
        if (skinDepthM !== null && thicknessM > skinDepthM) {
          return [
            {
              id: "skin-depth-warn",
              text: `Conductor thickness t = ${formatLengthSmart(thicknessM)} exceeds AC skin depth δ = ${formatLengthSmart(skinDepthM)} at ${(d.referenceFreqHz / 1e9).toFixed(1)} GHz.`,
              title: "AC skin-effect regime",
              tone: "warn",
            },
          ];
        }
        return [];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Zap,
          id: "primary-conductor",
          rows: [
            {
              key: "metalPreset",
              label: "Conductor metal preset",
              options: [
                ...CONDUCTOR_METALS.map((m) => ({ label: m.label, value: m.id })),
                { label: "Custom Conductivity", value: "custom" },
              ],
              type: "select",
            },
            {
              defaultDisplayUnit: "MS/m",
              key: "conductivitySpm",
              label: "Electrical conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              symbol: <>&sigma;</>,
              type: "quantity",
              units: CONDUCTIVITY_UNITS,
            },
            {
              format: (d) =>
                d.conductivitySpm > 0
                  ? `${((1 / d.conductivitySpm) * 1e8).toFixed(3)} µΩ·cm`
                  : "Not configured",
              label: "DC resistivity",
              symbol: <>&rho;</>,
              type: "readonly",
            },
          ],
          title: "Primary conductor material",
        },
        {
          defaultOpen: false,
          icon: Activity,
          id: "skin-depth",
          live: true,
          rows: [
            {
              defaultDisplayUnit: "GHz",
              key: "referenceFreqHz",
              label: "Reference RF frequency",
              min: 1e3,
              minExclusive: true,
              symbol: (
                <>
                  f<sub>ref</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS,
            },
            {
              format: (d) => {
                if (d.conductivitySpm <= 0 || d.referenceFreqHz <= 0) {
                  return "Not computed";
                }
                const delta =
                  1 / Math.sqrt(Math.PI * d.referenceFreqHz * MU0 * d.conductivitySpm);
                return `${formatLengthSmart(delta)} (${thicknessM <= delta ? "t <= δ quasi-static" : "t > δ AC skin regime"})`;
              },
              label: "Skin depth at f_ref",
              symbol: <>&delta;</>,
              type: "readonly",
            },
          ],
          title: "Reference skin-depth check",
        },
      ],
      commitBar: {
        cleanMessage: () => "Conductor conductivity is synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const patchedObjects = objects.map((obj) => {
            if (asString(obj?.id) !== objectId) return obj;
            const g = asRecord(obj?.geometry) ?? {};
            const gp = asRecord(g.geometry_params) ?? {};
            return {
              ...obj,
              geometry: {
                ...g,
                geometry_params: {
                  ...gp,
                  conductivity_s_per_m: draft.conductivitySpm,
                },
              },
            };
          });
          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: { objects: patchedObjects } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      antennaName,
      kernel.api.model,
      kernel.resources,
      objectId,
      objects,
      sceneRec,
      sessionScopeKey,
      thicknessM,
    ],
  );

  const handleConductorFieldChange = useCallback(
    <K extends keyof AntennaConductorDraft & string>(
      key: K,
      value: AntennaConductorDraft[K],
      helpers: { patchDraft: (partial: Partial<AntennaConductorDraft>) => void },
    ) => {
      if (key === "metalPreset" && typeof value === "string" && value !== "custom") {
        const matched = CONDUCTOR_METALS.find((m) => m.id === value);
        if (matched) {
          helpers.patchDraft({ conductivitySpm: matched.sigmaSpm });
        }
      } else if (key === "conductivitySpm" && typeof value === "number") {
        helpers.patchDraft({ metalPreset: matchMetalPreset(value) });
      }
    },
    [],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleConductorFieldChange}
    />
  );
}

// ============================================================================
// 4. object.antenna.terminals — AntennaTerminalsInspectorSpecPanel (Zero unit="1")
// ============================================================================

interface AntennaTerminalsDraft {
  enableLeadPreparation: boolean;
  leadLengthM: number;
  extrusionLayers: number;
  outwardNormal: readonly [number, number, number];
}

export function AntennaTerminalsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const terminalFaces = useMemo(
    () => [
      { cap: "signal:inlet", id: "sig-in", role: "Source + (Current In)" },
      { cap: "signal:outlet", id: "sig-out", role: "Ground / Sink − (V = 0)" },
    ],
    [],
  );

  const baseline = useMemo<AntennaTerminalsDraft>(
    () => ({
      enableLeadPreparation: false,
      extrusionLayers: 4,
      leadLengthM: 200e-9,
      outwardNormal: [1, 0, 0],
    }),
    [],
  );

  const spec = useMemo<InspectorSpec<AntennaTerminalsDraft>>(
    () => ({
      id: "object.antenna.terminals",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "terminals", label: "Terminals" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "physics",
        entityId: `terminals:${objectId}`,
        icon: Activity,
        kindLabel: "Current closure & electrode faces",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: () => "Current Terminals & Electrodes",
      },
      facts: () => [
        { id: "mode", label: "Source mode", value: "Boundary Terminals" },
        { id: "src", label: "Source (+) faces", value: "1" },
        { id: "gnd", label: "Sink (−) faces", value: "1" },
        { id: "bal", label: "Current balance", tone: "ok", value: "∑I = 0" },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Activity,
          id: "terminal-assignment",
          rows: [
            {
              columns: [
                {
                  header: "Conductor cap",
                  id: "cap",
                  mono: true,
                  renderCell: (r) => (r as (typeof terminalFaces)[number]).cap,
                },
                {
                  header: "Assigned role",
                  id: "role",
                  renderCell: (r) => (r as (typeof terminalFaces)[number]).role,
                },
              ],
              label: "Terminal faces assignment",
              rowKey: (r) => (r as (typeof terminalFaces)[number]).id,
              rows: () => terminalFaces,
              type: "table",
              wide: true,
            },
          ],
          title: "Current closure & terminal assignment",
        },
        {
          defaultOpen: false,
          icon: Layers,
          id: "lead-extensions",
          rows: [
            {
              key: "enableLeadPreparation",
              label: "Enable external lead extensions",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "leadLengthM",
              label: "Lead extension length",
              min: 1e-9,
              minExclusive: true,
              showWhen: (d) => d.enableLeadPreparation,
              symbol: (
                <>
                  L<sub>lead</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              integer: true,
              key: "extrusionLayers",
              label: "Extrusion layers",
              max: 32,
              min: 1,
              showWhen: (d) => d.enableLeadPreparation,
              symbol: (
                <>
                  N<sub>ext</sub>
                </>
              ),
              type: "number",
            },
            {
              axisPresets: true,
              key: "outwardNormal",
              label: "World outward normal",
              normalizeAction: true,
              showWhen: (d) => d.enableLeadPreparation,
              symbol: <>{"d\u0302"}</>,
              symbolInfo: {
                definition:
                  "Unit direction vector along which electrode lead extensions extrude into exterior space.",
                name: "World outward normal",
                siUnit: "dimensionless",
              },
              type: "vector3",
            },
          ],
          title: "External lead extensions",
        },
      ],
      commitBar: {
        cleanMessage: () => "Terminal assignments & lead settings are synchronized",
        mode: "staged",
        onApply: async (draft) => {
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: {
                antenna_terminal_preparations: {
                  [objectId]: draft.enableLeadPreparation
                    ? {
                        extrusion_layers: draft.extrusionLayers,
                        lead_length_m: draft.leadLengthM,
                        outward_normal: [...draft.outwardNormal],
                      }
                    : null,
                },
              } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      kernel.api.model,
      kernel.resources,
      objectId,
      sceneRec,
      sessionScopeKey,
      terminalFaces,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. object.antenna.port — AntennaPortInspectorSpecPanel (dBm <-> mW <-> V <-> A)
// ============================================================================

interface PortBranchRow {
  rowId: string;
  id: string;
  inlet: string;
  outlet: string;
  weight: number;
}

interface AntennaPortDraft {
  z0Ohm: number;
  levelMode: "power" | "current" | "voltage";
  rfPowerDbm: number;
  peakCurrentA: number;
  peakVoltageV: number;
  currentTransportId: string;
  branches: readonly PortBranchRow[];
}

export function AntennaPortInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId = selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = asRecord(scene.data);

  const portRec = useMemo(() => {
    const raw = Array.isArray(sceneRec?.antenna_port_modes)
      ? sceneRec.antenna_port_modes
      : [];
    return (
      raw
        .map(asRecord)
        .find((p) => asString(p?.source_object_id) === objectId) ?? null
    );
  }, [objectId, sceneRec]);

  const transportOptions = useMemo(() => {
    const raw = Array.isArray(sceneRec?.current_transports)
      ? sceneRec.current_transports
      : [];
    const opts = raw
      .map(asRecord)
      .map((ct) => {
        const name = asString(ct?.name) ?? "";
        return { label: name, value: name };
      })
      .filter((o) => o.value.length > 0);
    return opts.length > 0 ? opts : [{ label: "ct_antenna", value: "ct_antenna" }];
  }, [sceneRec]);

  const baseline = useMemo<AntennaPortDraft>(() => {
    const z0Ohm = asNumber(portRec?.impedance_ohm) ?? 50;
    const rfPowerDbm = asNumber(portRec?.rf_power_dbm) ?? 10;
    const converted = convertRfPortLevel({
      mode: "power_dbm",
      value: rfPowerDbm,
      z0Ohm,
    });
    const rawBranches = Array.isArray(portRec?.branches) ? portRec.branches : [];
    const branches: PortBranchRow[] =
      rawBranches.length > 0
        ? rawBranches.map((b, idx) => {
            const br = asRecord(b) ?? {};
            return {
              id: asString(br.id) ?? `branch_${idx + 1}`,
              inlet: asString(br.inlet_terminal_ref) ?? "signal:inlet",
              outlet: asString(br.outlet_terminal_ref) ?? "signal:outlet",
              rowId: `br:${idx}`,
              weight: asNumber(br.weight) ?? 1.0,
            };
          })
        : [
            {
              id: "signal_main",
              inlet: "signal:inlet",
              outlet: "signal:outlet",
              rowId: "br:0",
              weight: 1.0,
            },
          ];

    return {
      branches,
      currentTransportId:
        asString(portRec?.current_transport_id) ?? transportOptions[0]!.value,
      levelMode: "power",
      peakCurrentA: converted.peakCurrentA,
      peakVoltageV: converted.peakVoltageV,
      rfPowerDbm,
      z0Ohm,
    };
  }, [portRec, transportOptions]);

  const portId = asString(portRec?.id) ?? "port_1";

  const spec = useMemo<InspectorSpec<AntennaPortDraft>>(
    () => ({
      id: "object.antenna.port",
      header: {
        breadcrumbs: [
          {
            id: "antenna",
            label: "Antenna",
            selection: {
              kind: "object.antenna",
              label: "Antenna",
              nodeId: `model:object:${objectId}:antenna`,
              objectId,
              ref: null,
            },
          },
          { id: "port", label: `Port (${portId})` },
        ],
      },
      identity: {
        domain: "physics",
        entityId: `port:${portId}`,
        icon: PlugZap,
        kindLabel: "Antenna RF port mode & impedance",
        statePill: () => ({ label: "Configured", tone: "ok" }),
        title: () => `RF Port (${portId})`,
      },
      facts: (d) => {
        const conv = convertRfPortLevel({
          mode:
            d.levelMode === "power"
              ? "power_dbm"
              : d.levelMode === "current"
                ? "current_a"
                : "voltage_v",
          value:
            d.levelMode === "power"
              ? d.rfPowerDbm
              : d.levelMode === "current"
                ? d.peakCurrentA
                : d.peakVoltageV,
          z0Ohm: d.z0Ohm,
        });
        return [
          { id: "z0", label: "Impedance Z₀", value: `${d.z0Ohm.toFixed(1)} Ω` },
          {
            id: "power",
            label: "RF Power",
            value: Number.isFinite(conv.powerDbm)
              ? `${conv.powerDbm >= 0 ? "+" : ""}${conv.powerDbm.toFixed(1)} dBm (${conv.powerMw.toFixed(2)} mW)`
              : "0 mW",
          },
          {
            id: "i0",
            label: "Peak current I₀",
            value: `${conv.peakCurrentMa.toFixed(2)} mA`,
          },
          {
            id: "v0",
            label: "Peak voltage V₀",
            value: `${conv.peakVoltageV.toFixed(3)} V`,
          },
        ];
      },
      sections: [
        {
          defaultOpen: true,
          icon: Radio,
          id: "rf-converter",
          rows: [
            {
              defaultDisplayUnit: "Ω",
              key: "z0Ohm",
              label: "Characteristic impedance",
              min: 0.1,
              minExclusive: true,
              symbol: (
                <>
                  Z<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: IMPEDANCE_UNITS,
            },
            {
              key: "levelMode",
              label: "Specify drive level by",
              options: [
                { label: "RF Power P [dBm]", value: "power" },
                { label: "Peak Current I₀", value: "current" },
                { label: "Peak Voltage V₀", value: "voltage" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "rfPowerDbm",
              label: "Input RF power",
              showWhen: (d) => d.levelMode === "power",
              step: 0.5,
              symbol: (
                <>
                  P<sub>RF</sub>
                </>
              ),
              type: "number",
              unitSuffix: "dBm",
            },
            {
              defaultDisplayUnit: "mA",
              key: "peakCurrentA",
              label: "Peak current amplitude",
              min: 0,
              showWhen: (d) => d.levelMode === "current",
              symbol: (
                <>
                  I<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: CURRENT_UNITS,
            },
            {
              defaultDisplayUnit: "V",
              key: "peakVoltageV",
              label: "Peak voltage amplitude",
              min: 0,
              showWhen: (d) => d.levelMode === "voltage",
              symbol: (
                <>
                  V<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: VOLTAGE_UNITS,
            },
            {
              format: (d) => {
                const conv = convertRfPortLevel({
                  mode:
                    d.levelMode === "power"
                      ? "power_dbm"
                      : d.levelMode === "current"
                        ? "current_a"
                        : "voltage_v",
                  value:
                    d.levelMode === "power"
                      ? d.rfPowerDbm
                      : d.levelMode === "current"
                        ? d.peakCurrentA
                        : d.peakVoltageV,
                  z0Ohm: d.z0Ohm,
                });
                return `${conv.peakCurrentMa.toFixed(2)} mA (${(conv.iRmsA * 1e3).toFixed(2)} mA rms) · ${conv.peakVoltageV.toFixed(3)} V (${conv.vRmsV.toFixed(4)} V rms) · ${conv.powerMw.toFixed(2)} mW`;
              },
              label: "Derived CW equivalents",
              type: "readonly",
            },
          ],
          title: "Port impedance & RF level converter",
        },
        {
          defaultOpen: true,
          icon: Cpu,
          id: "port-branches",
          rows: [
            {
              key: "currentTransportId",
              label: "Current transport reference",
              options: transportOptions,
              type: "select",
            },
            {
              columns: [
                {
                  header: "Branch",
                  id: "id",
                  mono: true,
                  renderCell: (r) => (r as PortBranchRow).id,
                },
                {
                  header: "Inlet (+)",
                  id: "in",
                  mono: true,
                  renderCell: (r) => (r as PortBranchRow).inlet,
                },
                {
                  header: "Outlet (−)",
                  id: "out",
                  mono: true,
                  renderCell: (r) => (r as PortBranchRow).outlet,
                },
                {
                  align: "right",
                  header: "Signed weight",
                  id: "w",
                  mono: true,
                  renderCell: (r) => (r as PortBranchRow).weight.toFixed(2),
                },
              ],
              label: "Port terminal branches",
              onAddRow: (ctx) => {
                ctx.setField("branches", [
                  ...ctx.draft.branches,
                  {
                    id: `return_${ctx.draft.branches.length}`,
                    inlet: "return:outlet",
                    outlet: "return:inlet",
                    rowId: `br:${ctx.draft.branches.length}:${Date.now()}`,
                    weight: -1.0,
                  },
                ]);
              },
              rowKey: (r) => (r as PortBranchRow).rowId,
              rows: (d) => d.branches,
              type: "table",
              wide: true,
            },
          ],
          title: "Port terminal branches",
        },
      ],
      commitBar: {
        cleanMessage: () => "RF port impedance & branches match scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          const conv = convertRfPortLevel({
            mode:
              draft.levelMode === "power"
                ? "power_dbm"
                : draft.levelMode === "current"
                  ? "current_a"
                  : "voltage_v",
            value:
              draft.levelMode === "power"
                ? draft.rfPowerDbm
                : draft.levelMode === "current"
                  ? draft.peakCurrentA
                  : draft.peakVoltageV,
            z0Ohm: draft.z0Ohm,
          });
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;
          const existingPorts = Array.isArray(sceneRec?.antenna_port_modes)
            ? sceneRec.antenna_port_modes
            : [];
          const nextPort = {
            ...(portRec ?? {}),
            branches: draft.branches.map((b) => ({
              id: b.id,
              inlet_terminal_ref: b.inlet,
              outlet_terminal_ref: b.outlet,
              weight: b.weight,
            })),
            current_transport_id: draft.currentTransportId,
            id: portId,
            impedance_ohm: draft.z0Ohm,
            peak_current_a: conv.peakCurrentA,
            rf_power_dbm: Number.isFinite(conv.powerDbm) ? conv.powerDbm : null,
            source_object_id: objectId,
          };
          const patchedPorts = portRec
            ? existingPorts.map((p) =>
                asString(asRecord(p)?.id) === portId ? nextPort : p,
              )
            : [...existingPorts, nextPort];

          await kernel.api.model.commitTransaction(
            {
              base_revision: baseRev,
              kind: "merge_patch",
              patch: { antenna_port_modes: patchedPorts } as JsonObject,
            } as never,
            { sessionScopeKey },
          );
          kernel.resources.invalidate(SCENE_RESOURCE_KEY, `w5:${Date.now()}`);
          return true;
        },
      },
    }),
    [
      kernel.api.model,
      kernel.resources,
      objectId,
      portId,
      portRec,
      sceneRec,
      sessionScopeKey,
      transportOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
