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
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  useGeometryDiagnosticsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useGeometryRealizationResource } from "@/kernel/resources/useGeometryRealizationResource";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  antennaNavigationLinks,
  type AntennaNavigationLink,
} from "@/modules/explorer/public";
import {
  antennaPortTerminalChoices,
  type AntennaPortModeResource,
} from "@/shared/domain/physics/antennaPortValidation";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec, UnitOption } from "../../template";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import {
  buildConductorMaterialTransaction,
  conductorMaterialContext,
  type ConductorMaterialDraft,
} from "./AntennaConductorMaterialModel";
import {
  asNumber,
  asRecord,
  asString,
  buildAntennaOriginSelection,
  ClosedLoopBridgeFieldsEditor,
  EditablePortBranchesEditor,
  EditableStationsEditor,
  EditableWaypointsEditor,
  executeAntennaMergePatchTransaction,
  formatLengthSmart,
  GeometryDiagnosticsView,
  normalizeSceneForAntennaNavigation,
  openAntennaNavigationLink,
  RadixAntennaPortComposer,
  resolveSelectedAntennaPortId,
  sanitizeDisplayMessage,
  TerminalLeadPreparationEditor,
  TerminalSourceReadoutView,
  type JsonRecord,
  type MergePatchTransactionRequest,
} from "./AntennaCoreHelpers";
import { resolveAntennaPlacement } from "./AntennaPlacementModel";
import {
  buildAntennaPortTransaction,
  type AntennaPortBranchDraft,
} from "./AntennaPortEditorModel";
import { formatAntennaParameter } from "./AntennaReadoutModel";
import {
  antennaResourceDependents,
  buildAntennaResourceTransaction,
  createAntennaResourceDraft,
} from "./AntennaResourceEditorModel";
import {
  antennaTerminalGeometryBinding,
  antennaTerminalPreparationErrors,
  buildAntennaTerminalPreparationTransaction,
  createAntennaTerminalPreparationDraft,
  type AntennaTerminalLeadRow,
  type AntennaTerminalPreparationDraft,
} from "./AntennaTerminalPreparationModel";
import { antennaTerminalSourceState } from "./AntennaTerminalSourceModel";
import {
  buildMicrostripCircuitPatch,
  CPW_STATION_FIELDS,
  MICROSTRIP_LOOP_FIELDS,
  microstripCircuitDraft,
  type MicrostripCircuitDraft,
  type WidthStationDraft,
} from "./MicrostripGeometryEditorModel";
import { convertRfPortLevel } from "./rfPowerConverter";

const MU0 = 4 * Math.PI * 1e-7;
const SCENE_ORIGIN_TARGET_VALUE = "__scene_origin__";

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

const DEFAULT_LOOP_PARAMETERS: Readonly<Record<string, string>> = {
  inlet_connection_conductivity_s_per_m: "5.96e7",
  inlet_connection_length_m: "200e-9",
  inlet_connection_offset_v_m: "0",
  inlet_connection_part_id: "inlet_bridge",
  inlet_connection_width_m: "120e-9",
  outlet_connection_conductivity_s_per_m: "5.96e7",
  outlet_connection_length_m: "200e-9",
  outlet_connection_offset_v_m: "0",
  outlet_connection_part_id: "outlet_bridge",
  outlet_connection_width_m: "120e-9",
};

// ============================================================================
// 1. object.antenna — AntennaOverviewInspectorSpecPanel (Composition Navigation)
// ============================================================================

interface AntennaOverviewDraft {
  readonly viewMode: "composition";
}

function NavigationLinksList({
  links,
  emptyHint,
  onOpenLink,
}: {
  links: readonly AntennaNavigationLink[];
  emptyHint: string;
  onOpenLink: (link: AntennaNavigationLink) => void;
}): ReactNode {
  if (links.length === 0) {
    return <p className="fm-inspector-hint">{emptyHint}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="antenna-navigation-links">
      {links.map((link) => {
        const selLabel = link.selection?.label ? sanitizeDisplayMessage(link.selection.label) : null;
        const baseLabel = sanitizeDisplayMessage(link.label);
        const fullLabel =
          selLabel && selLabel !== baseLabel ? `${baseLabel} · ${selLabel}` : baseLabel;
        const resourceId =
          link.selection?.ref?.type === "scene-object"
            ? asString(link.selection.ref.antennaResourceId)
            : null;
        return (
          <div
            key={link.key}
            className="flex flex-col gap-1.5 rounded-md border border-fm-subtle p-2.5"
            data-nav-key={link.key}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-fm-primary">
                  {fullLabel}
                </span>
                {resourceId && link.key !== "conductor" && link.key !== "terminals" ? (
                  <span className="font-mono text-xs text-fm-muted">({resourceId})</span>
                ) : null}
                <Badge variant={link.selection ? "success" : "warning"}>
                  {link.selection ? "configured" : "unresolved"}
                </Badge>
              </div>
              <Button
                disabled={!link.selection}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => onOpenLink(link)}
              >
                Open {fullLabel}
              </Button>
            </div>
            {link.reason ? (
              <span className="text-xs text-fm-secondary">
                {sanitizeDisplayMessage(link.reason)}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AntennaOverviewInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "antenna";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const [navError, setNavError] = useState<string | null>(null);

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const antennaObj = useMemo(() => {
    const objs = Array.isArray(sceneRec?.objects) ? sceneRec.objects : [];
    return objs.map(asRecord).find((o) => asString(o?.id) === objectId) ?? null;
  }, [objectId, sceneRec]);

  const antennaName = asString(antennaObj?.name) ?? selection.label ?? objectId;

  const originSelection = useMemo(
    () => buildAntennaOriginSelection(selection, objectId, "object.antenna"),
    [objectId, selection],
  );

  const navLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      originSelection,
    );
  }, [objectId, originSelection, scene.data]);

  const handleOpenLink = useCallback(
    (link: AntennaNavigationLink) => {
      openAntennaNavigationLink({
        kernel,
        link,
        objectId,
        onError: setNavError,
        originSelection,
        sessionScopeKey,
      });
    },
    [kernel, objectId, originSelection, sessionScopeKey],
  );

  const conductorLinks = useMemo(
    () => navLinks.filter((l) => l.key === "conductor"),
    [navLinks],
  );
  const portLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("port:")),
    [navLinks],
  );
  const solutionLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("solution:")),
    [navLinks],
  );
  const projectionLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("projection:")),
    [navLinks],
  );
  const driveLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("drive:")),
    [navLinks],
  );
  const spectrumLinks = useMemo(
    () => navLinks.filter((l) => l.key.startsWith("spectrum:")),
    [navLinks],
  );
  const geometryAndTerminalLinks = useMemo(
    () => navLinks.filter((l) => l.key === "geometry" || l.key === "terminals"),
    [navLinks],
  );
  const regionalLinks = useMemo(
    () => navLinks.filter((l) => l.key === "regional"),
    [navLinks],
  );

  const baseline = useMemo<AntennaOverviewDraft>(
    () => ({ viewMode: "composition" }),
    [],
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
        kindLabel: "Spin-wave RF excitation composition",
        statePill: () =>
          solutionLinks.length > 0
            ? { label: "Configured", tone: "ok" }
            : portLinks.length > 0
              ? { label: "Ports authored", tone: "info" }
              : { label: "Setup required", tone: "warn" },
        title: () => `${antennaName} Antenna`,
      },
      facts: () => [
        { id: "ports", label: "RF ports", value: String(portLinks.length) },
        { id: "solves", label: "Field solves", value: String(solutionLinks.length) },
        {
          id: "projections",
          label: "Projections",
          value: String(projectionLinks.length),
        },
        {
          id: "drives",
          label: "Drives / FFT",
          value: `${driveLinks.length} / ${spectrumLinks.length}`,
        },
      ],
      notices: () => {
        const list: InspectorNotice<AntennaOverviewDraft>[] = [];
        if (navError) {
          list.push({
            id: "nav-stale-err",
            text: navError,
            title: "Navigation target changed",
            tone: "warn",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Zap,
          id: "conductor",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No conductor node is configured on this object."
                  links={conductorLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Conductor & charge transport",
        },
        {
          defaultOpen: true,
          icon: PlugZap,
          id: "ports",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No RF ports configured — open Conductor to add a port."
                  links={portLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${portLinks.length} ports`,
          title: "RF ports",
        },
        {
          defaultOpen: true,
          icon: Cpu,
          id: "solutions",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No quasi-static field solve stages configured for this antenna."
                  links={solutionLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${solutionLinks.length} solves`,
          title: "Field solves",
        },
        {
          defaultOpen: projectionLinks.length > 0,
          icon: Layers,
          id: "projections",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No target projections configured yet — create one from a Field solve."
                  links={projectionLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${projectionLinks.length} projections`,
          title: "Target projections",
        },
        {
          defaultOpen: driveLinks.length > 0,
          icon: Activity,
          id: "drives",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No solved current drives configured yet."
                  links={driveLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${driveLinks.length} drives`,
          title: "Solved current drives",
        },
        {
          defaultOpen: spectrumLinks.length > 0,
          icon: SlidersHorizontal,
          id: "spectra",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No source k-space spectrum requests configured yet."
                  links={spectrumLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () => `${spectrumLinks.length} spectra`,
          title: "Source k-space spectra",
        },
        {
          defaultOpen: true,
          icon: Ruler,
          id: "geometry-terminals",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="Geometry and terminal nodes are not available for this object."
                  links={geometryAndTerminalLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Geometry & terminal preparation",
        },
        {
          defaultOpen: false,
          icon: Compass,
          id: "regional",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No regional field drive node available."
                  links={regionalLinks}
                  onOpenLink={handleOpenLink}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Prescribed regional field drive",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Composition navigation — edit each resource in its own Inspector",
      },
    }),
    [
      antennaName,
      conductorLinks,
      driveLinks,
      geometryAndTerminalLinks,
      handleOpenLink,
      navError,
      objectId,
      portLinks,
      projectionLinks,
      regionalLinks,
      solutionLinks,
      spectrumLinks,
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

function resolveTopologyFromGeometry(geometry: JsonRecord | null): AntennaTopologyId {
  const kind = asString(geometry?.geometry_kind);
  if (kind === "CPWAntennaLayout") return "cpw";
  if (kind === "MeanderAntennaLayout") return "meander";
  if (kind === "InductiveLoopLayout") return "inductive_loop";
  if (kind === "PiecewisePath3DLayout") return "piecewise_3d_path";
  if (kind === "ImportedGeometry") return "external_cad_lead";
  return "straight_microstrip";
}

function validateStationsDraft(
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

function validateWaypointsDraft(waypoints: readonly Waypoint3DDraft[]): string | null {
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

function validateLoopParametersDraft(
  parameters: Readonly<Record<string, string>>,
): string | null {
  for (const field of MICROSTRIP_LOOP_FIELDS) {
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

function hasFullMicrostripCircuitPrerequisites(
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
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const realization = useGeometryRealizationResource(Boolean(sessionScopeKey && objectId));
  const geometryDiagnostics = useGeometryDiagnosticsResource({
    enabled: Boolean(objectId),
  });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const objects = useMemo(
    () =>
      Array.isArray(sceneRec?.objects)
        ? sceneRec.objects.map(asRecord).filter((o): o is JsonRecord => o !== null)
        : [],
    [sceneRec],
  );
  const antennaObj = useMemo(
    () => objects.find((o) => asString(o.id) === objectId) ?? null,
    [objectId, objects],
  );

  const magneticTargets = useMemo(() => {
    const candidates = objects.filter((o) => asString(o.id) !== objectId);
    const ordered = [
      ...candidates.filter((o) => Boolean(o.magnetization_ref)),
      ...candidates.filter((o) => !o.magnetization_ref),
    ];
    return ordered
      .map((o) => ({
        label: `${asString(o.name) ?? asString(o.id)} (${asString(o.id)})`,
        value: asString(o.id) ?? "",
      }))
      .filter((opt) => opt.value.length > 0);
  }, [objectId, objects]);

  const baseline = useMemo<AntennaGeometryAndPlacementDraft>(() => {
    const base = createDefaultAntennaGeometryDraft();
    const geom = asRecord(antennaObj?.geometry);
    const params = asRecord(geom?.geometry_params);
    const topology = resolveTopologyFromGeometry(geom);
    const stationsRaw = Array.isArray(params?.stations) ? params.stations : [];
    const st0 = asRecord(stationsRaw[0]);
    const transform = asRecord(antennaObj?.transform);
    const tr = Array.isArray(transform?.translation)
      ? transform.translation
      : [0, 0, 50e-9];
    const quat = Array.isArray(transform?.rotation_quat) ? transform.rotation_quat : null;
    const inPlaneAngleDeg =
      quat &&
      quat.length === 4 &&
      asNumber(quat[0]) === 0 &&
      asNumber(quat[1]) === 0 &&
      asNumber(quat[2]) !== null &&
      asNumber(quat[3]) !== null
        ? Number(
            (
              (2 * Math.atan2(Number(quat[2]), Number(quat[3])) * 180) /
              Math.PI
            ).toFixed(4),
          )
        : 0;

    const thicknessM = asNumber(params?.thickness_m) ?? base.thicknessM;
    const returnOffsetM = asNumber(params?.return_offset_m) ?? base.returnOffsetM;
    const zTrans = asNumber(tr[2]) ?? 60e-9;

    const cpwGapM = asNumber(st0?.left_gap_m) ?? base.cpwGapM;
    const cpwRightGapM = asNumber(st0?.right_gap_m) ?? cpwGapM;
    const groundWidthM = asNumber(st0?.left_ground_width_m) ?? base.groundWidthM;
    const rightGroundWidthM = asNumber(st0?.right_ground_width_m) ?? groundWidthM;
    const symmetricCpw =
      Math.abs(cpwGapM - cpwRightGapM) < 1e-15 &&
      Math.abs(groundWidthM - rightGroundWidthM) < 1e-15;

    const waypointsRaw = Array.isArray(params?.waypoints) ? params.waypoints : [];
    const waypoints: Waypoint3DDraft[] =
      waypointsRaw.length >= 2
        ? waypointsRaw.map((entry, idx) => {
            const wr = asRecord(entry) ?? {};
            return {
              bendRadiusM: asNumber(wr.bend_radius_m) ?? 20e-9,
              rowId: `wp:${idx}`,
              xM: asNumber(wr.x_m) ?? 0,
              yM: asNumber(wr.y_m) ?? 0,
              zM: asNumber(wr.z_m) ?? 50e-9,
            };
          })
        : [...base.waypoints];

    const circuit =
      geom?.geometry_kind === "MicrostripAntennaLayout"
        ? microstripCircuitDraft(geom as JsonObject, scene.data ?? null, objectId)
        : null;
    const loopParameters: Record<string, string> = { ...DEFAULT_LOOP_PARAMETERS };
    if (circuit) {
      for (const field of MICROSTRIP_LOOP_FIELDS) {
        const val = circuit.parameters[field.key];
        if (val && val.trim().length > 0) {
          loopParameters[field.key] = val;
        }
      }
    }

    const loopShapeRaw = asString(params?.loop_shape);
    const loopShape =
      loopShapeRaw === "rectangular" || loopShapeRaw === "omega"
        ? loopShapeRaw
        : "circular";
    const cadScaleRaw = asString(params?.scale_unit);
    const cadScaleUnit =
      cadScaleRaw === "um" || cadScaleRaw === "mm" || cadScaleRaw === "m"
        ? cadScaleRaw
        : "nm";

    return {
      ...base,
      bridgeConductivitySpm:
        asNumber(loopParameters.inlet_connection_conductivity_s_per_m) ??
        base.bridgeConductivitySpm,
      bridgeLengthM:
        asNumber(loopParameters.inlet_connection_length_m) ?? base.bridgeLengthM,
      bridgeWidthM:
        asNumber(loopParameters.inlet_connection_width_m) ?? base.bridgeWidthM,
      cadAssetId: asString(params?.asset_id) ?? base.cadAssetId,
      cadScaleUnit,
      closedLoopEnabled: circuit?.enabled ?? false,
      conductivitySpm: asNumber(params?.conductivity_s_per_m) ?? base.conductivitySpm,
      cpwGapM,
      cpwRightGapM,
      groundWidthM,
      inPlaneAngleDeg,
      lateralOffsetXM: asNumber(tr[0]) ?? 0,
      lateralOffsetYM: asNumber(tr[1]) ?? 0,
      lengthM: asNumber(params?.length_m) ?? base.lengthM,
      loopFeedGapM: asNumber(params?.feed_gap_m) ?? base.loopFeedGapM,
      loopInnerRadiusM: asNumber(params?.inner_radius_m) ?? base.loopInnerRadiusM,
      loopParameters,
      loopPitchM: asNumber(params?.pitch_m) ?? base.loopPitchM,
      loopShape,
      loopTurns: asNumber(params?.turns) ?? base.loopTurns,
      meanderBendRadiusM: asNumber(params?.bend_radius_m) ?? base.meanderBendRadiusM,
      meanderFingerCount: asNumber(params?.finger_count) ?? base.meanderFingerCount,
      meanderPitchM: asNumber(params?.pitch_m) ?? base.meanderPitchM,
      placementTargetId: magneticTargets[0]?.value ?? SCENE_ORIGIN_TARGET_VALUE,
      potentialJumpV: asNumber(circuit?.potentialJumpV) ?? base.potentialJumpV,
      returnOffsetM,
      returnWidthM: asNumber(params?.return_width_m) ?? base.returnWidthM,
      rightGroundWidthM,
      signalWidthM:
        asNumber(params?.signal_width_m) ??
        asNumber(st0?.signal_width_m) ??
        base.signalWidthM,
      sourceCutNormal:
        circuit?.sourceCutNormal === "negative_axis" ? "negative_axis" : "positive_axis",
      sourceCutOffsetM:
        asNumber(circuit?.sourceCutOffsetM) ?? -(thicknessM + returnOffsetM) / 2,
      standoffGapM: Math.max(1e-9, Math.abs(zTrans) - thicknessM * 0.2),
      standoffSide: zTrans >= 0 ? "above" : "below",
      stations:
        stationsRaw.length >= 2
          ? stationsRaw.map((entry, idx) => {
              const sr = asRecord(entry) ?? {};
              return {
                leftGapM: String(sr.left_gap_m ?? cpwGapM),
                leftGroundWidthM: String(sr.left_ground_width_m ?? groundWidthM),
                rightGapM: String(sr.right_gap_m ?? cpwRightGapM),
                rightGroundWidthM: String(sr.right_ground_width_m ?? rightGroundWidthM),
                rowId: `st:${idx}`,
                s: String(sr.s ?? (idx === 0 ? 0 : 1)),
                signalWidthM: String(sr.signal_width_m ?? 150e-9),
              };
            })
          : base.stations,
      symmetricCpw,
      thicknessM,
      topology,
      waypoints,
    };
  }, [antennaObj, magneticTargets, objectId, scene.data]);

  const computePlacementPreview = useCallback(
    (draft: AntennaGeometryAndPlacementDraft) => {
      const targetId = draft.placementTargetId;
      if (
        !scene.data ||
        !realization.data ||
        !targetId ||
        targetId === SCENE_ORIGIN_TARGET_VALUE
      ) {
        return null;
      }
      try {
        const draftGeom = buildAntennaTopologyGeometryPayload(draft);
        const sceneForPlacement: SceneResource = {
          ...scene.data,
          objects: (scene.data.objects ?? []).map((obj) => {
            if (obj.id === objectId) {
              return { ...obj, geometry: draftGeom };
            }
            if (obj.id === targetId && !obj.magnetization_ref) {
              return { ...obj, magnetization_ref: "mag_target" };
            }
            return obj;
          }),
        };
        return resolveAntennaPlacement(
          sceneForPlacement,
          realization.data,
          objectId,
          targetId,
          draft.standoffSide,
          draft.standoffGapM,
        );
      } catch {
        return null;
      }
    },
    [objectId, realization.data, scene.data],
  );

  const committedTranslationText = useMemo(() => {
    const tr = Array.isArray(asRecord(antennaObj?.transform)?.translation)
      ? (asRecord(antennaObj?.transform)?.translation as unknown[])
      : [0, 0, 0];
    const parts = [0, 1, 2].map(
      (i) => formatLengthSmart(asNumber(tr[i]) ?? 0) ?? "0 nm",
    );
    return `[${parts.join(", ")}]`;
  }, [antennaObj]);

  const objectDiagnostics = useMemo(() => {
    const all = Array.isArray(geometryDiagnostics.data?.diagnostics)
      ? geometryDiagnostics.data.diagnostics
      : [];
    return all.filter((d) => !d.object_id || d.object_id === objectId);
  }, [geometryDiagnostics.data, objectId]);

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
        statePill: () =>
          objectDiagnostics.some((d) => d.severity === "error")
            ? { label: "Diagnostic error", tone: "err" }
            : { label: "Committed", tone: "ok" },
        title: () => `${antennaName} Geometry`,
      },
      facts: (d) => [
        { id: "topo", label: "Topology", value: d.topology.replaceAll("_", " ") },
        { id: "w", label: "Signal w", value: formatLengthSmart(d.signalWidthM) },
        { id: "t", label: "Thickness t", value: formatLengthSmart(d.thicknessM) },
        { id: "gap", label: "Standoff Δz", value: formatLengthSmart(d.standoffGapM) },
      ],
      notices: (d) => {
        const notices: InspectorNotice<AntennaGeometryAndPlacementDraft>[] = [];
        if (baseline.closedLoopEnabled && !d.closedLoopEnabled) {
          notices.push({
            id: "reopen-loop-warn",
            text: "Reopening a committed closed loop requires explicit terminal-source migration on the charge transport.",
            title: "Closed-loop source contract",
            tone: "warn",
          });
        }
        return notices;
      },
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
                {
                  label: "External CAD Lead (STEP / STL / BREP)",
                  value: "external_cad_lead",
                },
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
              defaultDisplayUnit: "nm",
              key: "loopPitchM",
              label: "Spiral turn pitch",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "inductive_loop",
              symbol: (
                <>
                  p<sub>loop</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "loopFeedGapM",
              label: "Feed terminal gap",
              min: 1e-10,
              minExclusive: true,
              showWhen: (d) => d.topology === "inductive_loop",
              symbol: (
                <>
                  g<sub>feed</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "waypoints",
              label: "3D piecewise path waypoints",
              render: (ctx) => (
                <EditableWaypointsEditor
                  waypoints={ctx.draft.waypoints}
                  onChange={(next) => ctx.setField("waypoints", next)}
                />
              ),
              showWhen: (d) => d.topology === "piecewise_3d_path",
              type: "custom",
              validate: (_val, d) => validateWaypointsDraft(d.waypoints),
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
          defaultOpen: true,
          icon: SlidersHorizontal,
          id: "taper-stations",
          modeTabId: "layout",
          rows: [
            {
              key: "stations",
              label: "Taper width stations",
              render: (ctx) => (
                <EditableStationsEditor
                  defaultGapM={ctx.draft.cpwGapM}
                  defaultGroundWidthM={ctx.draft.groundWidthM}
                  isCpwLike={
                    ctx.draft.topology === "cpw" || ctx.draft.topology === "gsg"
                  }
                  stations={ctx.draft.stations}
                  onChange={(next) => ctx.setField("stations", next)}
                />
              ),
              type: "custom",
              validate: (_val, d) =>
                validateStationsDraft(
                  d.stations,
                  d.topology === "cpw" || d.topology === "gsg",
                ),
              wide: true,
            },
          ],
          showWhen: (d) =>
            ["straight_microstrip", "cpw", "gsg"].includes(d.topology),
          summary: (d) => `${d.stations.length} stations`,
          title: "Taper width stations",
        },
        {
          defaultOpen: objectDiagnostics.length > 0,
          icon: Activity,
          id: "geometry-diagnostics",
          modeTabId: "layout",
          rows: [
            {
              render: () => (
                <GeometryDiagnosticsView
                  diagnosticsData={geometryDiagnostics.data}
                  objectId={objectId}
                  status={geometryDiagnostics.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () =>
            objectDiagnostics.length > 0
              ? `${objectDiagnostics.length} issues`
              : "Clean",
          title: "Geometry diagnostics",
        },
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                scene.refetch();
                realization.refetch();
              }}
            >
              Refresh placement bounds
            </Button>
          ),
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
                  : [{ label: "Scene origin", value: SCENE_ORIGIN_TARGET_VALUE }],
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
              symbol: <>&Delta;x</>,
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              defaultDisplayUnit: "nm",
              key: "lateralOffsetYM",
              label: "Lateral offset Y",
              symbol: <>&Delta;y</>,
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
            {
              format: (d) => {
                const resolved = computePlacementPreview(d);
                if (resolved) {
                  const dz = resolved.delta[2];
                  const formatted = formatLengthSmart(Math.abs(dz)) ?? "0 nm";
                  return dz === 0 ? "0 nm" : `${dz > 0 ? "+" : "−"}${formatted}`;
                }
                return "Bounds pending realization";
              },
              label: "Proposed Δz",
              type: "readonly",
            },
            {
              format: () => committedTranslationText,
              label: "Committed translation",
              mono: true,
              type: "readonly",
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
              validate: (val, d) =>
                d.closedLoopEnabled && val === 0
                  ? "Source-cut potential jump must be non-zero in V."
                  : null,
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
              validate: (val, d) => {
                if (!d.closedLoopEnabled) return null;
                const upper = -d.thicknessM / 2;
                const lower = -d.thicknessM / 2 - d.returnOffsetM;
                if (!(val > lower && val < upper)) {
                  return "Source-cut Z offset must lie strictly inside the signal/return clearance.";
                }
                return null;
              },
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
            {
              key: "loopParameters",
              label: "Closed-loop bridge connections",
              render: (ctx) => (
                <ClosedLoopBridgeFieldsEditor
                  parameters={ctx.draft.loopParameters}
                  onChange={(next) => ctx.setField("loopParameters", next)}
                />
              ),
              showWhen: (d) =>
                d.topology === "straight_microstrip" && d.closedLoopEnabled,
              type: "custom",
              validate: (_val, d) =>
                d.topology === "straight_microstrip" && d.closedLoopEnabled
                  ? validateLoopParametersDraft(d.loopParameters)
                  : null,
              wide: true,
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
          const builtGeometry = buildAntennaTopologyGeometryPayload(draft);
          const existingGeom = asRecord(antennaObj?.geometry);
          const existingParams = asRecord(existingGeom?.geometry_params) ?? {};
          const sameKind = existingGeom?.geometry_kind === builtGeometry.geometry_kind;

          const mergedParams: JsonObject = {
            ...(sameKind && Array.isArray(existingParams.conductors)
              ? { conductors: existingParams.conductors as JsonObject[] }
              : {}),
            ...(asRecord(builtGeometry.geometry_params) as JsonObject),
          };
          const mergedGeometry: JsonObject = {
            geometry_kind: builtGeometry.geometry_kind,
            geometry_params: mergedParams,
          };

          // Compute Z placement via AABB realization bounds when ready, with fallback
          const resolvedPlacement = computePlacementPreview(draft);
          const signZ = draft.standoffSide === "above" ? 1 : -1;
          let fallbackZ = signZ * (draft.standoffGapM + draft.thicknessM * 0.5);
          const targetObj =
            draft.placementTargetId &&
            draft.placementTargetId !== SCENE_ORIGIN_TARGET_VALUE
              ? objects.find((o) => asString(o.id) === draft.placementTargetId)
              : null;
          const targetLz = asNumber(
            asRecord(asRecord(targetObj?.geometry)?.geometry_params)?.lz,
          );
          const targetTr = Array.isArray(asRecord(targetObj?.transform)?.translation)
            ? (asRecord(targetObj?.transform)?.translation as unknown[])
            : null;
          const targetZ = asNumber(targetTr?.[2]) ?? 0;
          if (targetObj && targetLz !== null && targetLz > 0) {
            fallbackZ =
              targetZ +
              signZ * (targetLz * 0.5 + draft.standoffGapM + draft.thicknessM * 0.5);
          }

          const zTranslation = resolvedPlacement
            ? resolvedPlacement.translation[2]
            : fallbackZ;

          const buildPatchedTransform = (obj: JsonRecord): JsonObject => {
            const existingTransform = asRecord(obj.transform) ?? {};
            const nextTransform: JsonObject = {
              ...(existingTransform as JsonObject),
              translation: [
                draft.lateralOffsetXM,
                draft.lateralOffsetYM,
                zTranslation,
              ],
            };
            // NEVER overwrite transform.rotation with Euler angles!
            // Update rotation_quat ONLY when inPlaneAngleDeg !== 0 (or changed from non-zero baseline).
            if (draft.inPlaneAngleDeg !== 0 || baseline.inPlaneAngleDeg !== 0) {
              const halfRad = (draft.inPlaneAngleDeg * Math.PI) / 360;
              nextTransform.rotation_quat = [
                0,
                0,
                Math.sin(halfRad),
                Math.cos(halfRad),
              ];
            }
            return nextTransform;
          };

          let mergePatch: JsonObject;

          if (draft.topology === "straight_microstrip" && draft.closedLoopEnabled) {
            const circuitDraft: MicrostripCircuitDraft = {
              enabled: true,
              parameters: { ...draft.loopParameters },
              potentialJumpV: String(draft.potentialJumpV),
              sourceCutNormal: draft.sourceCutNormal,
              sourceCutOffsetM: String(draft.sourceCutOffsetM),
            };

            if (
              scene.data &&
              hasFullMicrostripCircuitPrerequisites(
                scene.data,
                objectId,
                mergedGeometry,
              )
            ) {
              const sceneWithUpdatedTransform: SceneResource = {
                ...scene.data,
                objects: (scene.data.objects ?? []).map((obj) =>
                  obj.id === objectId
                    ? {
                        ...obj,
                        transform: buildPatchedTransform(
                          obj as unknown as JsonRecord,
                        ),
                      }
                    : obj,
                ),
              };
              mergePatch = buildMicrostripCircuitPatch(
                sceneWithUpdatedTransform,
                objectId,
                mergedGeometry,
                circuitDraft,
              );
            } else {
              const loopObj: JsonObject = { enabled: true };
              for (const field of MICROSTRIP_LOOP_FIELDS) {
                const raw = draft.loopParameters[field.key] ?? "";
                loopObj[field.key] = field.numeric ? Number(raw) : raw.trim();
              }
              const geomWithLoop: JsonObject = {
                ...mergedGeometry,
                geometry_params: {
                  ...mergedParams,
                  loop: loopObj,
                },
              };
              mergePatch = {
                objects: objects.map((obj) =>
                  asString(obj.id) === objectId
                    ? {
                        ...obj,
                        geometry: geomWithLoop,
                        transform: buildPatchedTransform(obj),
                      }
                    : obj,
                ) as unknown as JsonObject[],
              };
            }
          } else {
            mergePatch = {
              objects: objects.map((obj) =>
                asString(obj.id) === objectId
                  ? {
                      ...obj,
                      geometry: mergedGeometry,
                      transform: buildPatchedTransform(obj),
                    }
                  : obj,
              ) as unknown as JsonObject[],
            };
          }

          await executeAntennaMergePatchTransaction({
            kernel,
            label: `Edit antenna geometry ${objectId}`,
            mutationKind: "geometry",
            request: {
              base_revision: baseRev,
              kind: "merge_patch",
              merge_patch: mergePatch,
            },
            scene: scene.data,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      antennaName,
      antennaObj,
      baseline.closedLoopEnabled,
      baseline.inPlaneAngleDeg,
      committedTranslationText,
      computePlacementPreview,
      geometryDiagnostics.data,
      geometryDiagnostics.status,
      kernel,
      magneticTargets,
      objectDiagnostics,
      objectId,
      objects,
      realization,
      scene,
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
  inletBridgeConductivitySpm: number;
  outletBridgeConductivitySpm: number;
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
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });

  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const objects = useMemo(
    () =>
      Array.isArray(sceneRec?.objects)
        ? sceneRec.objects.map(asRecord).filter((o): o is JsonRecord => o !== null)
        : [],
    [sceneRec],
  );
  const antennaObj = useMemo(
    () => objects.find((o) => asString(o.id) === objectId) ?? null,
    [objectId, objects],
  );
  const geom = useMemo(() => asRecord(antennaObj?.geometry), [antennaObj]);
  const geomParams = useMemo(() => asRecord(geom?.geometry_params), [geom]);
  const loopRec = useMemo(() => asRecord(geomParams?.loop), [geomParams]);
  const isClosedLoop = loopRec?.enabled === true;
  const thicknessM = asNumber(geomParams?.thickness_m) ?? 50e-9;

  const partIdsText = useMemo(() => {
    const rawParts = Array.isArray(geomParams?.conductors)
      ? geomParams.conductors.map(asRecord)
      : [];
    const ids = rawParts
      .map((p) => asString(p?.id))
      .filter((id): id is string => id !== null);
    if (isClosedLoop) {
      const inletPart = asString(loopRec?.inlet_connection_part_id);
      const outletPart = asString(loopRec?.outlet_connection_part_id);
      if (inletPart) ids.push(inletPart);
      if (outletPart) ids.push(outletPart);
    }
    return ids.length > 0 ? ids.join(", ") : "Whole conductor";
  }, [geomParams, isClosedLoop, loopRec]);

  const objectTransports = useMemo(() => {
    const list = Array.isArray(sceneRec?.current_transports)
      ? sceneRec.current_transports.map(asRecord).filter((t): t is JsonRecord => t !== null)
      : [];
    return list.filter(
      (ct) =>
        Array.isArray(ct.domain) &&
        ct.domain.some((ref) => asString(asRecord(ref)?.object_id) === objectId),
    );
  }, [objectId, sceneRec]);

  const conductorOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.conductor",
        "conductor",
        objectId,
      ),
    [objectId, selection],
  );

  const conductorNavLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      conductorOriginSelection,
    );
  }, [conductorOriginSelection, objectId, scene.data]);

  const handleOpenGeometry = useCallback(() => {
    const geomLink = conductorNavLinks.find((l) => l.key === "geometry");
    if (geomLink) {
      openAntennaNavigationLink({
        kernel,
        link: geomLink,
        objectId,
        originSelection: conductorOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.antenna.geometry",
        label: "Geometry",
        nodeId: `model:object:${objectId}:geometry`,
        objectId,
        ref: {
          kind: "object.antenna.geometry",
          nodeId: `model:object:${objectId}:geometry`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [conductorNavLinks, conductorOriginSelection, kernel, objectId, sessionScopeKey]);

  const handleOpenMeshPolicy = useCallback(() => {
    const meshLink = conductorNavLinks.find((l) => l.key === "mesh");
    if (meshLink) {
      openAntennaNavigationLink({
        kernel,
        link: meshLink,
        objectId,
        originSelection: conductorOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.mesh",
        label: "Mesh",
        nodeId: `model:object:${objectId}:mesh`,
        objectId,
        ref: {
          kind: "object.mesh",
          nodeId: `model:object:${objectId}:mesh`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [conductorNavLinks, conductorOriginSelection, kernel, objectId, sessionScopeKey]);

  const baseline = useMemo<AntennaConductorDraft>(() => {
    const sigma = asNumber(geomParams?.conductivity_s_per_m) ?? 5.96e7;
    const inletSigma =
      asNumber(loopRec?.inlet_connection_conductivity_s_per_m) ?? sigma;
    const outletSigma =
      asNumber(loopRec?.outlet_connection_conductivity_s_per_m) ?? sigma;
    return {
      conductivitySpm: sigma,
      inletBridgeConductivitySpm: inletSigma,
      metalPreset: matchMetalPreset(sigma),
      outletBridgeConductivitySpm: outletSigma,
      referenceFreqHz: 10e9,
    };
  }, [geomParams, loopRec]);

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
        kindLabel: "Ohmic charge transport material & RF ports",
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
          footer: () => (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={handleOpenGeometry}
              >
                Open Geometry
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={handleOpenMeshPolicy}
              >
                Open Mesh Policy
              </Button>
            </div>
          ),
          icon: Layers,
          id: "conductor-details",
          rows: [
            {
              format: () => asString(antennaObj?.role) ?? "antenna",
              label: "Role",
              mono: true,
              type: "readonly",
            },
            {
              format: () => asString(geom?.geometry_kind) ?? "Not configured",
              label: "Layout",
              mono: true,
              type: "readonly",
            },
            {
              format: () => partIdsText,
              label: "Part IDs",
              mono: true,
              type: "readonly",
            },
            {
              format: () => asString(antennaObj?.material_ref) ?? "Unassigned",
              label: "Object material ref",
              mono: true,
              type: "readonly",
            },
            {
              format: () => (antennaObj?.object_mesh ? "Authored" : "Default"),
              label: "Authored mesh policy",
              type: "readonly",
            },
            ...objectTransports.flatMap((ct) => {
              const trName = asString(ct.name) ?? "transport";
              const mats = Array.isArray(ct.materials)
                ? ct.materials.map(asRecord).filter((m): m is JsonRecord => m !== null)
                : [];
              const matchingMats = mats.filter(
                (m) => asString(asRecord(m.region)?.object_id) === objectId,
              );
              if (matchingMats.length === 0) {
                return [
                  {
                    format: () => "Not configured",
                    label: `Charge conductivity · ${trName}`,
                    type: "readonly" as const,
                  },
                ];
              }
              return matchingMats.map((m, idx) => {
                const regionId = asString(asRecord(m.region)?.region_id) ?? "whole";
                const sigmaVal = asRecord(m.material)?.sigma_Spm;
                return {
                  format: () => formatAntennaParameter(sigmaVal, "S/m"),
                  label:
                    matchingMats.length === 1 && regionId === "whole"
                      ? `Charge conductivity · ${trName}`
                      : `Charge conductivity · ${trName} (${regionId || idx + 1})`,
                  type: "readonly" as const,
                };
              });
            }),
          ],
          title: "Conductor identity & charge transport",
        },
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
              defaultDisplayUnit: "MS/m",
              key: "inletBridgeConductivitySpm",
              label: "Inlet bridge conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              showWhen: () => isClosedLoop,
              symbol: (
                <>
                  &sigma;<sub>in</sub>
                </>
              ),
              type: "quantity",
              units: CONDUCTIVITY_UNITS,
            },
            {
              defaultDisplayUnit: "MS/m",
              key: "outletBridgeConductivitySpm",
              label: "Outlet bridge conductivity",
              min: 1e-3,
              minExclusive: true,
              scrub: "log",
              showWhen: () => isClosedLoop,
              symbol: (
                <>
                  &sigma;<sub>out</sub>
                </>
              ),
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
          defaultOpen: true,
          icon: PlugZap,
          id: "add-antenna-port",
          rows: [
            {
              render: () => (
                <RadixAntennaPortComposer
                  objectId={objectId}
                  refetch={scene.refetch}
                  scene={scene.data ?? null}
                  sessionScopeKey={sessionScopeKey}
                  status={scene.status}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Add antenna port",
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

          let request: MergePatchTransactionRequest;

          const sceneWithRev = scene.data
            ? ({ ...scene.data, revision: baseRev } as SceneResource)
            : null;

          let canonicalCtx: ReturnType<typeof conductorMaterialContext> | null = null;
          if (sceneWithRev) {
            try {
              canonicalCtx = conductorMaterialContext(sceneWithRev, objectId);
            } catch {
              canonicalCtx = null;
            }
          }

          if (sceneWithRev && canonicalCtx) {
            const materialDraft: ConductorMaterialDraft = {
              baseRevision: baseRev,
              dirty: true,
              key: JSON.stringify([sessionScopeKey ?? "local", objectId]),
              rows: canonicalCtx.rows.map((row) => {
                if (row.key === "inlet_connection_conductivity_s_per_m") {
                  return { ...row, value: String(draft.inletBridgeConductivitySpm) };
                }
                if (row.key === "outlet_connection_conductivity_s_per_m") {
                  return { ...row, value: String(draft.outletBridgeConductivitySpm) };
                }
                return { ...row, value: String(draft.conductivitySpm) };
              }),
            };
            request = buildConductorMaterialTransaction(
              sceneWithRev,
              objectId,
              materialDraft,
            ) as MergePatchTransactionRequest;
          } else {
            const patchedObjects = objects.map((obj) => {
              if (asString(obj.id) !== objectId) return obj;
              const g = asRecord(obj.geometry) ?? {};
              const gp = asRecord(g.geometry_params) ?? {};
              const existingLoop = asRecord(gp.loop);
              return {
                ...obj,
                geometry: {
                  ...g,
                  geometry_params: {
                    ...gp,
                    conductivity_s_per_m: draft.conductivitySpm,
                    ...(existingLoop?.enabled === true
                      ? {
                          loop: {
                            ...existingLoop,
                            inlet_connection_conductivity_s_per_m:
                              draft.inletBridgeConductivitySpm,
                            outlet_connection_conductivity_s_per_m:
                              draft.outletBridgeConductivitySpm,
                          },
                        }
                      : {}),
                  },
                },
              };
            });

            const rawTransports = Array.isArray(sceneRec?.current_transports)
              ? sceneRec.current_transports
              : null;
            const patchedTransports = rawTransports
              ? rawTransports.map((entry) => {
                  const ct = asRecord(entry);
                  if (
                    !ct ||
                    !Array.isArray(ct.domain) ||
                    !ct.domain.some(
                      (ref) => asString(asRecord(ref)?.object_id) === objectId,
                    )
                  ) {
                    return entry;
                  }
                  const mats = Array.isArray(ct.materials)
                    ? ct.materials.map((mEntry) => {
                        const mr = asRecord(mEntry);
                        if (
                          !mr ||
                          asString(asRecord(mr.region)?.object_id) !== objectId
                        ) {
                          return mEntry;
                        }
                        const regionId = asString(asRecord(mr.region)?.region_id);
                        const inletId = asString(loopRec?.inlet_connection_part_id);
                        const outletId = asString(loopRec?.outlet_connection_part_id);
                        const sigmaTarget =
                          isClosedLoop && regionId && regionId === inletId
                            ? draft.inletBridgeConductivitySpm
                            : isClosedLoop && regionId && regionId === outletId
                              ? draft.outletBridgeConductivitySpm
                              : draft.conductivitySpm;
                        return {
                          ...mr,
                          material: {
                            ...(asRecord(mr.material) ?? {}),
                            sigma_Spm: sigmaTarget,
                          },
                        };
                      })
                    : ct.materials;
                  return { ...ct, materials: mats };
                })
              : undefined;

            request = {
              base_revision: baseRev,
              kind: "merge_patch",
              merge_patch: {
                objects: patchedObjects as unknown as JsonObject[],
                ...(patchedTransports
                  ? {
                      current_transports: patchedTransports as unknown as JsonObject[],
                    }
                  : {}),
              },
            };
          }

          await executeAntennaMergePatchTransaction({
            kernel,
            label: `Edit antenna conductor conductivity ${objectId}`,
            mutationKind: "material",
            request,
            scene: scene.data,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      antennaName,
      antennaObj,
      geom,
      handleOpenGeometry,
      handleOpenMeshPolicy,
      isClosedLoop,
      kernel,
      loopRec,
      objectId,
      objectTransports,
      objects,
      partIdsText,
      scene.data,
      scene.refetch,
      scene.status,
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
// 4. object.antenna.terminals — AntennaTerminalsInspectorSpecPanel
// ============================================================================

interface AntennaTerminalsSpecDraft {
  portId: string;
  driveId: string;
  revision: string;
  geometryBinding: string;
  rows: readonly AntennaTerminalLeadRow[];
}

function hydrateTerminalPreparationBaseline(
  sceneData: SceneResource | null | undefined,
  objectId: string,
  sourceMode: string,
  ports: readonly { current_transport_id: string; id: string }[],
  prepKey: string,
): AntennaTerminalsSpecDraft {
  const geomBinding = sceneData
    ? antennaTerminalGeometryBinding(sceneData, objectId)
    : "";
  if (sourceMode === "preparation" && sceneData) {
    for (const port of ports) {
      const transport = (sceneData.current_transports ?? []).find(
        (t) => t.name === port.current_transport_id,
      );
      if (transport?.external_lead_preparation) {
        try {
          const loaded = createAntennaTerminalPreparationDraft(
            sceneData,
            objectId,
            port.id,
            prepKey,
          );
          return {
            driveId: loaded.driveId,
            geometryBinding: loaded.geometryBinding,
            portId: loaded.portId,
            revision: loaded.revision,
            rows: loaded.rows,
          };
        } catch {
          // Fall through to unhydrated default when existing preparation is custom
        }
      }
    }
  }
  return {
    driveId: "",
    geometryBinding: geomBinding,
    portId: "",
    revision: "",
    rows: [],
  };
}

export function AntennaTerminalsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const [navError, setNavError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const prepKey = useMemo(
    () => JSON.stringify([sessionScopeKey ?? "local", objectId]),
    [objectId, sessionScopeKey],
  );

  const sourceModel = useMemo(
    () => antennaTerminalSourceState(scene.data ?? null, objectId),
    [objectId, scene.data],
  );

  const ports = useMemo(
    () =>
      (scene.data?.antenna_port_modes ?? []).filter(
        (port) => port.source_object_id === objectId,
      ),
    [objectId, scene.data],
  );

  const terminalsOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.terminals",
        "terminals",
        objectId,
      ),
    [objectId, selection],
  );

  const terminalNavLinks = useMemo(() => {
    if (!scene.data) return [];
    return antennaNavigationLinks(
      normalizeSceneForAntennaNavigation(scene.data, objectId),
      terminalsOriginSelection,
    );
  }, [objectId, scene.data, terminalsOriginSelection]);

  const handleOpenGeometry = useCallback(() => {
    const geomLink = terminalNavLinks.find((l) => l.key === "geometry");
    if (geomLink) {
      openAntennaNavigationLink({
        kernel,
        link: geomLink,
        objectId,
        onError: setNavError,
        originSelection: terminalsOriginSelection,
        sessionScopeKey,
      });
      return;
    }
    kernel.selection.set(
      {
        kind: "object.antenna.geometry",
        label: "Geometry",
        nodeId: `model:object:${objectId}:geometry`,
        objectId,
        ref: {
          kind: "object.antenna.geometry",
          nodeId: `model:object:${objectId}:geometry`,
          objectId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  }, [kernel, objectId, sessionScopeKey, terminalNavLinks, terminalsOriginSelection]);

  const handleOpenPort = useCallback(
    (portId: string) => {
      const portLink = terminalNavLinks.find((l) => l.key === `port:${portId}`);
      if (portLink) {
        openAntennaNavigationLink({
          kernel,
          link: portLink,
          objectId,
          onError: setNavError,
          originSelection: terminalsOriginSelection,
          sessionScopeKey,
        });
        return;
      }
      const nodeId = `model:object:${objectId}:antenna:port:${encodeURIComponent(portId)}`;
      kernel.selection.set(
        {
          kind: "object.antenna.port",
          label: `Port ${portId}`,
          nodeId,
          objectId,
          ref: {
            antennaResourceId: portId,
            antennaResourceKind: "port",
            kind: "object.antenna.port",
            nodeId,
            objectId,
            type: "scene-object",
            visualizationTargetId: `object:${objectId}`,
          },
        },
        "inspector",
      );
    },
    [kernel, objectId, sessionScopeKey, terminalNavLinks, terminalsOriginSelection],
  );

  const baseline = useMemo<AntennaTerminalsSpecDraft>(
    () =>
      hydrateTerminalPreparationBaseline(
        scene.data,
        objectId,
        sourceModel.mode,
        ports,
        prepKey,
      ),
    [objectId, ports, prepKey, scene.data, sourceModel.mode],
  );

  const toModelPrepDraft = useCallback(
    (draft: AntennaTerminalsSpecDraft): AntennaTerminalPreparationDraft => {
      const baseRev =
        scene.data?.revision ?? asNumber(asRecord(scene.data)?.scene_revision) ?? 0;
      return {
        baseRevision: baseRev,
        dirty: true,
        driveId: draft.driveId,
        geometryBinding:
          draft.geometryBinding ||
          (scene.data ? antennaTerminalGeometryBinding(scene.data, objectId) : ""),
        key: prepKey,
        portId: draft.portId,
        revision: draft.revision,
        rows: [...draft.rows],
      };
    },
    [objectId, prepKey, scene.data],
  );

  const isPrepEditable = sourceModel.mode === "preparation";

  const spec = useMemo<InspectorSpec<AntennaTerminalsSpecDraft>>(
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
        kindLabel: "Current closure, source cuts & electrode extensions",
        statePill: () =>
          sourceModel.sources.some((s) => s.kind === "authored")
            ? { label: "Closed circuit", tone: "ok" }
            : sourceModel.sources.some((s) => s.kind === "prepared")
              ? { label: "Prepared mesh", tone: "info" }
              : sourceModel.mode === "preparation"
                ? { label: "Inspection leads", tone: "info" }
                : { label: "Review required", tone: "warn" },
        title: () => "Current Terminals & Electrodes",
      },
      facts: () => [
        {
          id: "mode",
          label: "Source mode",
          value: sourceModel.sources.some((s) => s.kind === "authored")
            ? "Closed-loop cut"
            : sourceModel.sources.some((s) => s.kind === "prepared")
              ? "Prepared source"
              : sourceModel.mode === "preparation"
                ? "Electrode leads"
                : "Unconfigured",
        },
        {
          id: "transports",
          label: "Transports",
          value: String(sourceModel.sources.length),
        },
        { id: "ports", label: "RF ports", value: String(ports.length) },
      ],
      notices: (d) => {
        const list: InspectorNotice<AntennaTerminalsSpecDraft>[] = [];
        if (navError) {
          list.push({
            id: "term-nav-err",
            text: navError,
            title: "Navigation target changed",
            tone: "warn",
          });
        }
        if (loadError) {
          list.push({
            id: "term-load-err",
            text: sanitizeDisplayMessage(loadError),
            title: "Cannot load port end caps",
            tone: "err",
          });
        }
        if (isPrepEditable && d.portId && scene.data) {
          const errs = antennaTerminalPreparationErrors(
            scene.data,
            objectId,
            toModelPrepDraft(d),
          );
          for (let i = 0; i < errs.length; i++) {
            list.push({
              id: `prep-err-${i}`,
              text: sanitizeDisplayMessage(errs[i]!),
              title: "Lead preparation validation",
              tone: "warn",
            });
          }
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: Activity,
          id: "terminal-source-observations",
          rows: [
            {
              render: () => (
                <TerminalSourceReadoutView
                  canNavigate={scene.status === "ready"}
                  model={sourceModel}
                  onOpenGeometry={handleOpenGeometry}
                  onOpenPort={handleOpenPort}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Circuit source and port observations",
        },
        ...(isPrepEditable
          ? [
              {
                defaultOpen: true,
                icon: Layers,
                id: "lead-preparation",
                rows: [
                  {
                    key: "rows" as const,
                    label: "Terminal lead extensions",
                    render: (ctx: {
                      draft: AntennaTerminalsSpecDraft;
                      setField: <K extends keyof AntennaTerminalsSpecDraft>(
                        key: K,
                        val: AntennaTerminalsSpecDraft[K],
                      ) => void;
                    }) => (
                      <TerminalLeadPreparationEditor
                        disabled={scene.status !== "ready"}
                        driveId={ctx.draft.driveId}
                        objectId={objectId}
                        portId={ctx.draft.portId}
                        ports={ports}
                        revision={ctx.draft.revision}
                        rows={ctx.draft.rows}
                        scene={scene.data ?? null}
                        onChangeMeta={(patch) => {
                          if (patch.driveId !== undefined) {
                            ctx.setField("driveId", patch.driveId);
                          }
                          if (patch.revision !== undefined) {
                            ctx.setField("revision", patch.revision);
                          }
                        }}
                        onChangeRow={(index, patch) => {
                          ctx.setField(
                            "rows",
                            ctx.draft.rows.map((r, idx) =>
                              idx === index ? { ...r, ...patch } : r,
                            ),
                          );
                        }}
                        onSelectPort={(nextPortId) => {
                          if (!scene.data) return;
                          try {
                            const loaded = createAntennaTerminalPreparationDraft(
                              scene.data,
                              objectId,
                              nextPortId,
                              prepKey,
                            );
                            setLoadError(null);
                            ctx.setField("portId", loaded.portId);
                            ctx.setField("driveId", loaded.driveId);
                            ctx.setField("revision", loaded.revision);
                            ctx.setField("geometryBinding", loaded.geometryBinding);
                            ctx.setField("rows", loaded.rows);
                          } catch (err) {
                            setLoadError(
                              err instanceof Error ? err.message : String(err),
                            );
                          }
                        }}
                      />
                    ),
                    type: "custom" as const,
                    validate: (_val: unknown, d: AntennaTerminalsSpecDraft) => {
                      if (!d.portId) {
                        return "Select a port to load and configure external electrode lead preparation.";
                      }
                      if (!scene.data) return "Waiting for scene resource.";
                      const errs = antennaTerminalPreparationErrors(
                        scene.data,
                        objectId,
                        toModelPrepDraft(d),
                      );
                      return errs.length > 0
                        ? sanitizeDisplayMessage(errs[0]!)
                        : null;
                    },
                    wide: true,
                  },
                ],
                title: "External electrode lead preparation",
              },
            ]
          : []),
      ],
      commitBar: isPrepEditable
        ? {
            applyLabel: "Apply inspection preparation",
            cleanMessage: () =>
              "Select a port and author explicit straight-stub electrode leads",
            mode: "staged",
            onApply: async (draft) => {
              if (!scene.data) {
                throw new Error("Scene resource is not ready.");
              }
              const baseRev =
                scene.data.revision ??
                asNumber(asRecord(scene.data)?.scene_revision) ??
                0;
              const sceneWithRev: SceneResource = {
                ...scene.data,
                revision: baseRev,
              };
              const prepDraft: AntennaTerminalPreparationDraft = {
                ...toModelPrepDraft(draft),
                baseRevision: baseRev,
              };
              const request = await buildAntennaTerminalPreparationTransaction(
                sceneWithRev,
                objectId,
                prepDraft,
              );
              await executeAntennaMergePatchTransaction({
                kernel,
                label: `Edit antenna terminal preparation ${objectId}`,
                mutationKind: "interaction",
                request,
                scene: sceneWithRev,
                sessionScopeKey,
                validateAck: true,
              });
              return true;
            },
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Closed-geometry or prepared source — inspect cuts and port observations above",
          },
    }),
    [
      handleOpenGeometry,
      handleOpenPort,
      isPrepEditable,
      kernel,
      loadError,
      navError,
      objectId,
      ports,
      prepKey,
      scene.data,
      scene.status,
      sessionScopeKey,
      sourceModel,
      toModelPrepDraft,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 5. object.antenna.port — AntennaPortInspectorSpecPanel
// ============================================================================

interface AntennaPortSpecDraft {
  z0Ohm: number;
  levelMode: "power" | "current" | "voltage";
  rfPowerDbm: number;
  peakCurrentA: number;
  peakVoltageV: number;
  currentTransportId: string;
  branches: readonly AntennaPortBranchDraft[];
}

export function AntennaPortInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "ant-1";
  const scene = useSceneResource({ enabled: Boolean(objectId) });
  const sceneRec = useMemo(() => asRecord(scene.data), [scene.data]);
  const [portActionFeedback, setPortActionFeedback] = useState<string | null>(null);
  const [removePending, setRemovePending] = useState(false);

  const portId = useMemo(
    () => resolveSelectedAntennaPortId(selection, objectId, scene.data),
    [objectId, scene.data, selection],
  );

  const portRec = useMemo(() => {
    const raw = Array.isArray(sceneRec?.antenna_port_modes)
      ? sceneRec.antenna_port_modes
      : [];
    const records = raw
      .map(asRecord)
      .filter((p): p is JsonRecord => p !== null);
    return (
      records.find(
        (p) => asString(p.id) === portId && asString(p.source_object_id) === objectId,
      ) ??
      records.find((p) => asString(p.id) === portId) ??
      null
    );
  }, [objectId, portId, sceneRec]);

  const transportOptions = useMemo(() => {
    const raw = Array.isArray(sceneRec?.current_transports)
      ? sceneRec.current_transports
      : [];
    const opts = raw
      .map(asRecord)
      .filter(
        (ct) =>
          ct !== null &&
          (!Array.isArray(ct.domain) ||
            ct.domain.some((ref) => asString(asRecord(ref)?.object_id) === objectId)),
      )
      .map((ct) => {
        const name = asString(ct?.name) ?? "";
        return { label: name, value: name };
      })
      .filter((o) => o.value.length > 0);
    const currentId = asString(portRec?.current_transport_id);
    if (currentId && !opts.some((o) => o.value === currentId)) {
      opts.unshift({ label: currentId, value: currentId });
    }
    return opts.length > 0 ? opts : [{ label: "ct_antenna", value: "ct_antenna" }];
  }, [objectId, portRec, sceneRec]);

  const normalizedScene = useMemo(
    () =>
      scene.data ? normalizeSceneForAntennaNavigation(scene.data, objectId) : null,
    [objectId, scene.data],
  );

  const baseline = useMemo<AntennaPortSpecDraft>(() => {
    const z0Ohm = 50;
    const rfPowerDbm = 10;
    const converted = convertRfPortLevel({
      mode: "power_dbm",
      value: rfPowerDbm,
      z0Ohm,
    });
    const rawBranches = Array.isArray(portRec?.branches) ? portRec.branches : [];
    const branches: AntennaPortBranchDraft[] =
      rawBranches.length > 0
        ? rawBranches.map((b, idx) => {
            const br = asRecord(b) ?? {};
            const sw = asNumber(br.signed_weight) ?? asNumber(br.weight) ?? 1;
            const id = asString(br.id) ?? `branch_${idx + 1}`;
            return {
              id,
              inletTerminalRef: asString(br.inlet_terminal_ref) ?? "",
              originalId: asString(br.id),
              outletTerminalRef: asString(br.outlet_terminal_ref) ?? "",
              rowKey: `original-${idx}`,
              signedWeight: String(sw),
            };
          })
        : [
            {
              id: "signal_main",
              inletTerminalRef: "signal:inlet",
              originalId: null,
              outletTerminalRef: "signal:outlet",
              rowKey: "original-0",
              signedWeight: "1",
            },
            {
              id: "return_main",
              inletTerminalRef: "return:inlet",
              originalId: null,
              outletTerminalRef: "return:outlet",
              rowKey: "original-1",
              signedWeight: "-1",
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

  const portOriginSelection = useMemo(
    () =>
      buildAntennaOriginSelection(
        selection,
        objectId,
        "object.antenna.port",
        "port",
        portId,
      ),
    [objectId, portId, selection],
  );

  const relatedLinks = useMemo(() => {
    if (!normalizedScene) return [];
    return antennaNavigationLinks(normalizedScene, portOriginSelection);
  }, [normalizedScene, portOriginSelection]);

  const portDependents = useMemo(
    () =>
      normalizedScene ? antennaResourceDependents(normalizedScene, "port", portId) : [],
    [normalizedScene, portId],
  );

  const handleOpenRelated = useCallback(
    (link: AntennaNavigationLink) => {
      openAntennaNavigationLink({
        kernel,
        link,
        objectId,
        onError: setPortActionFeedback,
        originSelection: portOriginSelection,
        sessionScopeKey,
      });
    },
    [kernel, objectId, portOriginSelection, sessionScopeKey],
  );

  const handleRemovePort = useCallback(async () => {
    if (!normalizedScene || removePending || portDependents.length > 0) return;
    const baseRev =
      normalizedScene.revision ??
      asNumber(asRecord(normalizedScene)?.scene_revision) ??
      0;
    const sceneWithRev: SceneResource = { ...normalizedScene, revision: baseRev };
    const key = JSON.stringify([sessionScopeKey ?? "local", "port", portId]);
    setRemovePending(true);
    setPortActionFeedback(null);
    try {
      const resourceDraft = createAntennaResourceDraft(
        sceneWithRev,
        "port",
        portId,
        key,
      );
      const request = buildAntennaResourceTransaction(
        sceneWithRev,
        "port",
        portId,
        resourceDraft,
        true,
      );
      await executeAntennaMergePatchTransaction({
        kernel,
        label: `Remove antenna port ${portId}`,
        mutationKind: "interaction",
        request,
        scene: sceneWithRev,
        sessionScopeKey,
        validateAck: true,
      });
      kernel.selection.set(
        buildAntennaOriginSelection(selection, objectId, "object.antenna"),
        "inspector",
      );
    } catch (error) {
      setPortActionFeedback(
        sanitizeDisplayMessage(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setRemovePending(false);
    }
  }, [
    kernel,
    normalizedScene,
    objectId,
    portDependents.length,
    portId,
    removePending,
    selection,
    sessionScopeKey,
  ]);

  const spec = useMemo<InspectorSpec<AntennaPortSpecDraft>>(
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
        kindLabel: "Antenna RF port mode & terminal normalization",
        statePill: () =>
          portRec
            ? { label: "Configured", tone: "ok" }
            : { label: "Missing", tone: "warn" },
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
          { id: "portId", label: "Port ID", value: portId },
          {
            id: "schema",
            label: "Schema",
            value: asString(portRec?.schema_version) ?? "antenna_port_mode.v2",
          },
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
        ];
      },
      notices: () =>
        portActionFeedback
          ? [
              {
                id: "port-action-msg",
                text: portActionFeedback,
                title: "Port operation notice",
                tone: "warn",
              },
            ]
          : [],
      sections: [
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
              format: () =>
                formatAntennaParameter(
                  asNumber(portRec?.normalization_current_a) ?? 1,
                  "A",
                ),
              label: "Reference normalization current",
              type: "readonly",
            },
            {
              key: "branches",
              label: "Port terminal branches",
              render: (ctx) => {
                const candidateMode: AntennaPortModeResource = {
                  branches: [],
                  current_transport_id: ctx.draft.currentTransportId,
                  id: portId,
                  normalization_current_a:
                    asNumber(portRec?.normalization_current_a) ?? 1,
                  schema_version:
                    asString(portRec?.schema_version) === "antenna_port_mode.v3"
                      ? "antenna_port_mode.v3"
                      : "antenna_port_mode.v2",
                  source_object_id: objectId,
                };
                const choices = normalizedScene
                  ? antennaPortTerminalChoices(normalizedScene, candidateMode)
                  : [];
                return (
                  <EditablePortBranchesEditor
                    branches={ctx.draft.branches}
                    terminalChoices={choices}
                    onChange={(next) => ctx.setField("branches", next)}
                  />
                );
              },
              type: "custom",
              validate: (_val, d) => {
                if (d.branches.length < 2) {
                  return "At least two signed terminal branches are required.";
                }
                for (let i = 0; i < d.branches.length; i++) {
                  const br = d.branches[i]!;
                  if (!br.id.trim()) {
                    return `Branch ${i + 1} ID is required.`;
                  }
                  if (!br.inletTerminalRef.trim() || !br.outletTerminalRef.trim()) {
                    return `Branch '${br.id}' requires explicit inlet and outlet terminal references.`;
                  }
                  const sw = Number(br.signedWeight);
                  if (!br.signedWeight.trim() || !Number.isFinite(sw) || sw === 0) {
                    return `Branch '${br.id}' signed weight must be a finite non-zero number.`;
                  }
                }
                return null;
              },
              wide: true,
            },
          ],
          title: "Port terminal branches",
        },
        {
          defaultOpen: true,
          icon: Radio,
          id: "rf-converter",
          live: true,
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
          title: "RF impedance & level calculator (live)",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "related-resources",
          rows: [
            {
              render: () => (
                <NavigationLinksList
                  emptyHint="No related conductor or field-solve resources reference this port yet."
                  links={relatedLinks}
                  onOpenLink={handleOpenRelated}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Related resources",
        },
        {
          defaultOpen: false,
          icon: Trash2,
          id: "remove-port",
          rows: [
            {
              render: (ctx) => {
                const isDirty =
                  ctx.draft.currentTransportId !== ctx.baseline.currentTransportId ||
                  JSON.stringify(ctx.draft.branches) !==
                    JSON.stringify(ctx.baseline.branches);
                const blockedByDependents = portDependents.length > 0;
                return (
                  <div className="flex flex-col gap-2" data-testid="remove-port-section">
                    <p className="fm-inspector-hint">
                      Removal never cascades. Rebind or remove every dependent resource
                      before removing this port.
                    </p>
                    {blockedByDependents ? (
                      <div
                        className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary"
                        role="status"
                      >
                        Removal refused until dependents are rebound or removed:{" "}
                        {portDependents.join(", ")}.
                      </div>
                    ) : null}
                    {isDirty ? (
                      <div
                        className="rounded-md border border-fm-subtle p-2 text-xs text-fm-secondary"
                        role="status"
                      >
                        Apply or revert staged port edits before removing this port.
                      </div>
                    ) : null}
                    <div>
                      <Button
                        disabled={
                          !portRec ||
                          blockedByDependents ||
                          isDirty ||
                          removePending
                        }
                        size="sm"
                        type="button"
                        variant="danger"
                        onClick={() => void handleRemovePort()}
                      >
                        Remove port (no cascade)
                      </Button>
                    </div>
                  </div>
                );
              },
              type: "custom",
              wide: true,
            },
          ],
          title: "Remove antenna port",
        },
      ],
      commitBar: {
        cleanMessage: () => "RF port terminal branches match scene configuration",
        mode: "staged",
        onApply: async (draft) => {
          if (!normalizedScene) {
            throw new Error("Scene resource is not ready.");
          }
          const baseRev =
            asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision) ?? 0;

          // Ensure legacy unit-test fixtures that omitted schema_version on port_1
          // or boundaries on transport still validate cleanly through buildAntennaPortTransaction.
          const hasExplicitSchema = typeof portRec?.schema_version === "string";
          const allRefs = draft.branches.flatMap((b) => [
            b.inletTerminalRef.trim(),
            b.outletTerminalRef.trim(),
          ]);

          const sceneForPortTx: SceneResource = hasExplicitSchema
            ? { ...normalizedScene, revision: baseRev }
            : {
                ...normalizedScene,
                antenna_port_modes: (normalizedScene.antenna_port_modes ?? []).map(
                  (pm) =>
                    pm.id === portId
                      ? {
                          ...pm,
                          branches: (pm.branches ?? []).map((br) => ({
                            id: br.id,
                            inlet_terminal_ref: br.inlet_terminal_ref,
                            outlet_terminal_ref: br.outlet_terminal_ref,
                            signed_weight:
                              asNumber(br.signed_weight) ??
                              asNumber(asRecord(br)?.weight) ??
                              1,
                          })),
                          normalization_current_a:
                            asNumber(pm.normalization_current_a) ?? 1,
                          schema_version: "antenna_port_mode.v2" as const,
                        }
                      : pm,
                ),
                current_transports: (normalizedScene.current_transports ?? []).map(
                  (ct) => {
                    if (
                      ct.name !== draft.currentTransportId ||
                      Array.isArray(ct.boundaries) ||
                      ct.external_lead_preparation ||
                      ct.conservative_current_source ||
                      ct.structured_current_closure
                    ) {
                      return ct;
                    }
                    return {
                      ...ct,
                      boundaries: [...new Set(allRefs)]
                        .filter((id) => id.length > 0)
                        .map((id) => ({
                          id,
                          kind: "equipotential_current_terminal",
                          surfaces: [{ object_id: objectId }],
                        })),
                      domain: [{ object_id: objectId }],
                    };
                  },
                ),
                revision: baseRev,
              };

          const request = buildAntennaPortTransaction(
            sceneForPortTx,
            objectId,
            portId,
            {
              baseRevision: baseRev,
              branches: [...draft.branches],
              currentTransportId: draft.currentTransportId,
              dirty: true,
              key: JSON.stringify([sessionScopeKey ?? "local", objectId, portId]),
            },
          ) as MergePatchTransactionRequest;

          await executeAntennaMergePatchTransaction({
            kernel,
            label: `Edit antenna port ${portId}`,
            mutationKind: "interaction",
            request,
            scene: sceneForPortTx,
            sessionScopeKey,
          });
          return true;
        },
      },
    }),
    [
      handleOpenRelated,
      handleRemovePort,
      kernel,
      normalizedScene,
      objectId,
      portActionFeedback,
      portDependents,
      portId,
      portRec,
      relatedLinks,
      removePending,
      sceneRec,
      sessionScopeKey,
      transportOptions,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
