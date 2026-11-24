"use client";

import {
  Layers,
  PlugZap,
  Ruler,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import type { InspectorSectionSpec } from "../../../template";
import {
  ClosedLoopBridgeFieldsEditor,
  EditableStationsEditor,
  EditableWaypointsEditor,
} from "../../../panels/antenna/AntennaCoreHelpers";
import {
  type AntennaGeometryAndPlacementDraft,
  LENGTH_UNITS,
  validateLoopParametersDraft,
  validateStationsDraft,
  validateWaypointsDraft,
  VOLTAGE_UNITS,
} from "./antennaCoreShared";

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

export const ANTENNA_GEOMETRY_LAYOUT_SECTIONS: readonly InspectorSectionSpec<AntennaGeometryAndPlacementDraft>[] = [
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
];

function circuitGeometryKind({ topology }: AntennaGeometryAndPlacementDraft): string {
  return topology === "straight_microstrip" ? "MicrostripAntennaLayout" : "CPWAntennaLayout";
}

export const ANTENNA_GEOMETRY_CLOSED_LOOP_SECTION: InspectorSectionSpec<AntennaGeometryAndPlacementDraft> =
        {
          defaultOpen: true,
          icon: PlugZap,
          id: "closed-loop",
          modeTabId: "loop",
          rows: [
            {
              disabledReason: (d) =>
                ["straight_microstrip", "cpw", "gsg"].includes(d.topology)
                  ? null
                  : "Closed-loop closure applies to straight microstrip and coplanar layouts.",
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
              label: "Object-local source-cut offset",
              hint: "Use local Z in the microstrip signal/return clearance or local X in the coplanar inlet neck.",
              showWhen: (d) => d.closedLoopEnabled,
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) => {
                if (!d.closedLoopEnabled) return null;
                if (circuitGeometryKind(d) === "CPWAntennaLayout") {
                  const length = Number(d.loopParameters.inlet_connection_length_m);
                  const crossbar = Number(d.loopParameters.inlet_crossbar_length_m);
                  return val > -length + crossbar && val < 0
                    ? null
                    : "Source-cut X offset must lie strictly inside the inlet neck.";
                }
                const upper = -d.thicknessM / 2;
                const lower = upper - d.returnOffsetM;
                return val > lower && val < upper
                  ? null
                  : "Source-cut Z offset must lie strictly inside the signal/return clearance.";
              },
            },
            {
              key: "sourceCutNormal",
              label: "Source-cut normal",
              options: [
                { label: "Positive local axis", value: "positive_axis" },
                { label: "Negative local axis", value: "negative_axis" },
              ],
              showWhen: (d) => d.closedLoopEnabled,
              type: "segmented",
            },
            {
              key: "loopParameters",
              label: "Closed-loop bridge connections",
              render: (ctx) => (
                <ClosedLoopBridgeFieldsEditor
                  geometryKind={circuitGeometryKind(ctx.draft)}
                  parameters={ctx.draft.loopParameters}
                  onChange={(next) => ctx.setField("loopParameters", next)}
                />
              ),
              showWhen: (d) => d.closedLoopEnabled,
              type: "custom",
              validate: (_val, d) =>
                d.closedLoopEnabled
                  ? validateLoopParametersDraft(d.loopParameters, circuitGeometryKind(d))
                  : null,
              wide: true,
            },
          ],
          title: "Closed-loop return & voltage cut",
        };
