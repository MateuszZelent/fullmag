"use client";

import { Activity, Compass, Sliders, Waves } from "lucide-react";

import type { SceneResource } from "@/kernel/api/apiTypes";

import {
  type InspectorSectionSpec,
} from "../../../template";
import {
  ANGLE_UNITS,
  FIELD_TESLA_UNITS,
  FREQUENCY_UNITS,
  LENGTH_UNITS,
  TIME_UNITS,
} from "../../../panels/model-roots/SpecInspectorHost";

import {
  estimateFieldDriveMaxFrequencyHz,
  resolveDraftNyquistHz,
  UNSELECTED_OBJECT,
  UNSELECTED_REGION,
  type FieldDriveSpecDraft,
} from "./fieldDriveShared";
import {
  AddRunStageButton,
  ControlledPiecewiseWaypointsEditor,
  FieldDrivePreviewWidget,
} from "./FieldDriveWidgets";

export interface BuildFieldDriveSectionsParams {
  existingIdsExcludingCurrent: ReadonlySet<string>;
  objectSelectOptions: readonly { value: string; label: string }[];
  regionSelectOptions: readonly { value: string; label: string }[];
  scene: SceneResource | null;
  setWaypointParseError: (error: string | null) => void;
  stageOptions: readonly { value: string; label: string }[];
}

export function buildFieldDriveSections({
  existingIdsExcludingCurrent,
  objectSelectOptions,
  regionSelectOptions,
  scene,
  setWaypointParseError,
  stageOptions,
}: BuildFieldDriveSectionsParams): InspectorSectionSpec<FieldDriveSpecDraft>[] {
  return [
    {
      id: "drive-scope",
      title: "Identity, target & stage activation",
      icon: Sliders,
      defaultOpen: true,
      rows: [
        {
          key: "driveId",
          type: "text",
          mono: true,
          label: "ID",
          showWhen: (d) => !d.exists,
          validate: (v, d) => {
            const trimmed = v.trim();
            if (trimmed.length === 0) return "Enter a drive ID.";
            if (!d.exists && existingIdsExcludingCurrent.has(trimmed)) {
              return `Field drive "${trimmed}" already exists.`;
            }
            return null;
          },
        },
        {
          type: "readonly",
          mono: true,
          label: "ID",
          showWhen: (d) => d.exists,
          format: (d) => d.driveId,
        },
        {
          key: "name",
          type: "text",
          label: "Name",
          validate: (v) => (v.trim().length === 0 ? "Enter a drive name." : null),
        },
        {
          key: "enabled",
          type: "switch",
          label: "Enabled",
        },
        {
          key: "targetKind",
          type: "select",
          label: "Target",
          structural: true,
          options: [
            { value: "global", label: "Global" },
            { value: "object", label: "Object" },
            { value: "region", label: "Region" },
          ],
        },
        {
          key: "targetObjectId",
          type: "select",
          label: "Object",
          structural: true,
          showWhen: (d) => d.targetKind !== "global",
          options: objectSelectOptions,
          validate: (v, d) =>
            d.targetKind !== "global" && (v === UNSELECTED_OBJECT || v.trim().length === 0)
              ? "Select an object."
              : null,
        },
        {
          key: "targetRegionId",
          type: "select",
          label: "Stable region",
          showWhen: (d) => d.targetKind === "region",
          options: regionSelectOptions,
          validate: (v, d) =>
            d.targetKind === "region" && (v === UNSELECTED_REGION || v.trim().length === 0)
              ? "Select a region."
              : null,
        },
        {
          key: "stageScopeKind",
          type: "segmented",
          label: "Stage activation",
          structural: true,
          options: [
            { value: "all_dynamic", label: "All time stages" },
            { value: "stage_ids", label: "Selected stages" },
          ],
        },
        {
          key: "selectedStageIds",
          type: "toggles",
          label: "Participating stages",
          showWhen: (d) => d.stageScopeKind === "stage_ids" && stageOptions.length > 0,
          options: stageOptions,
          validate: (v, d) =>
            d.stageScopeKind === "stage_ids" && v.length === 0
              ? "Select at least one run stage."
              : null,
        },
        {
          type: "custom",
          wide: true,
          showWhen: (d) => d.stageScopeKind === "stage_ids" && stageOptions.length === 0,
          render: () => (
            <div
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] p-2 text-xs text-[var(--fm-text-muted)]"
              data-slot="empty-run-stages-cta"
            >
              <span>
                No run stage with a stable ID is available. Add a run stage before assigning
                this drive.
              </span>
              <AddRunStageButton scene={scene} />
            </div>
          ),
        },
      ],
    },
    {
      id: "drive-spatial",
      title: "Spatial modulation profile",
      icon: Compass,
      defaultOpen: true,
      rows: [
        {
          key: "spatialKind",
          type: "select",
          label: "Spatial profile",
          structural: true,
          options: [
            { value: "uniform", label: "Uniform" },
            { value: "sinc", label: "Spatial sinc" },
            { value: "geometry_mask", label: "Geometry mask" },
            { value: "gaussian_plane_wave", label: "Gaussian plane wave" },
          ],
        },
        {
          key: "maskObjectId",
          type: "select",
          label: "Mask geometry",
          structural: true,
          showWhen: (d) => d.spatialKind === "geometry_mask",
          options: objectSelectOptions,
        },
        {
          key: "maskEnvelopeKind",
          type: "segmented",
          label: "Envelope",
          structural: true,
          showWhen: (d) => d.spatialKind === "geometry_mask",
          options: [
            { value: "uniform", label: "Uniform" },
            { value: "sinc", label: "Spatial sinc" },
          ],
        },
        {
          key: "spatialAxis",
          type: "vector3",
          label: "Wavevector axis",
          symbol: (
            <>
              ê<sub>k</sub>
            </>
          ),
          axisPresets: true,
          normalizeAction: true,
          showWhen: (d) =>
            d.spatialKind === "sinc" ||
            (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
        },
        {
          key: "spatialPeriodM",
          type: "quantity",
          label: "Spatial period",
          symbol: <>λ</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) =>
            d.spatialKind === "sinc" ||
            (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
        },
        {
          key: "spatialCenterM",
          type: "quantity",
          label: "Spatial center",
          symbol: (
            <>
              x<sub>0</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) =>
            d.spatialKind === "sinc" ||
            (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
        },
        {
          key: "spatialWidthEnabled",
          type: "switch",
          label: "Limit spatial width",
          showWhen: (d) =>
            d.spatialKind === "sinc" ||
            (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
        },
        {
          key: "spatialWidthM",
          type: "quantity",
          label: "Spatial width",
          symbol: <>W</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) =>
            (d.spatialKind === "sinc" ||
              (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc")) &&
            d.spatialWidthEnabled,
        },
        {
          key: "spatialWindow",
          type: "segmented",
          label: "Window",
          showWhen: (d) =>
            d.spatialKind === "sinc" ||
            (d.spatialKind === "geometry_mask" && d.maskEnvelopeKind === "sinc"),
          options: [
            { value: "none", label: "None" },
            { value: "hann", label: "Hann" },
          ],
        },
        /* Gaussian plane wave spatial parameters */
        {
          key: "gpwWavelengthM",
          type: "quantity",
          label: "Carrier wavelength",
          symbol: <>λ</>,
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwSigmaXM",
          type: "quantity",
          label: "Beam waist X",
          symbol: (
            <>
              σ<sub>x</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwSigmaYM",
          type: "quantity",
          label: "Beam waist Y",
          symbol: (
            <>
              σ<sub>y</sub>
            </>
          ),
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwCenterXM",
          type: "quantity",
          label: "Beam center X",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwCenterYM",
          type: "quantity",
          label: "Beam center Y",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwCarrierOriginXM",
          type: "quantity",
          label: "Carrier origin X",
          units: LENGTH_UNITS,
          defaultDisplayUnit: "nm",
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
        {
          key: "gpwCarrierPhaseRad",
          type: "quantity",
          label: "Carrier phase",
          units: ANGLE_UNITS,
          defaultDisplayUnit: "deg",
          showWhen: (d) => d.spatialKind === "gaussian_plane_wave",
        },
      ],
    },
    {
      id: "drive-waveform",
      title: "Field vector, time origin & waveform",
      icon: Waves,
      defaultOpen: true,
      rows: [
        {
          type: "custom",
          wide: true,
          render: (ctx) => (
            <FieldDrivePreviewWidget
              draft={ctx.draft}
              scene={scene}
              onDomainChange={(next) => ctx.setField("previewDomain", next)}
            />
          ),
        },
        {
          key: "amplitudeBT",
          type: "quantity",
          label: "Amplitude",
          symbol: (
            <>
              B<sub>0</sub>
            </>
          ),
          units: FIELD_TESLA_UNITS,
          defaultDisplayUnit: "mT",
          min: 0,
        },
        {
          key: "direction",
          type: "vector3",
          label: "Direction",
          symbol: (
            <>
              ê<sub>B</sub>
            </>
          ),
          axisPresets: true,
          normalizeAction: true,
        },
        {
          key: "timeOrigin",
          type: "segmented",
          label: "Time origin",
          options: [
            { value: "stage_local", label: "Stage local" },
            { value: "absolute", label: "Absolute" },
          ],
        },
        {
          key: "waveformKind",
          type: "select",
          label: "Waveform",
          structural: true,
          options: [
            { value: "sinc_pulse", label: "Sinc pulse" },
            { value: "sinusoidal", label: "Sinusoidal" },
            { value: "pulse", label: "Pulse (step t_on → t_off)" },
            { value: "piecewise_linear", label: "Piecewise linear" },
            { value: "constant", label: "Constant" },
            { value: "gaussian_pulse", label: "Gaussian pulse (synthesized)" },
            { value: "chirp", label: "Linear chirp (synthesized)" },
          ],
        },
        /* Sinc pulse */
        {
          key: "cutoffFreqHz",
          type: "quantity",
          label: "Cutoff frequency",
          symbol: (
            <>
              f<sub>c</sub>
            </>
          ),
          units: FREQUENCY_UNITS,
          defaultDisplayUnit: "GHz",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.waveformKind === "sinc_pulse",
        },
        {
          key: "timeCenterS",
          type: "quantity",
          label: "Center time",
          symbol: (
            <>
              t<sub>0</sub>
            </>
          ),
          units: TIME_UNITS,
          defaultDisplayUnit: "ns",
          showWhen: (d) =>
            d.waveformKind === "sinc_pulse" || d.waveformKind === "gaussian_pulse",
        },
        {
          key: "sincAmplitude",
          type: "number",
          label: "Waveform amplitude",
          symbol: <>a</>,
          showWhen: (d) => d.waveformKind === "sinc_pulse",
        },
        /* Sinusoidal */
        {
          key: "carrierFreqHz",
          type: "quantity",
          label: "Frequency",
          symbol: <>f</>,
          units: FREQUENCY_UNITS,
          defaultDisplayUnit: "GHz",
          min: 0,
          minExclusive: true,
          showWhen: (d) =>
            d.waveformKind === "sinusoidal" ||
            d.waveformKind === "gaussian_pulse" ||
            d.waveformKind === "chirp",
        },
        {
          key: "phaseRad",
          type: "quantity",
          label: "Phase",
          symbol: <>φ</>,
          units: ANGLE_UNITS,
          defaultDisplayUnit: "deg",
          showWhen: (d) =>
            d.waveformKind === "sinusoidal" ||
            d.waveformKind === "gaussian_pulse" ||
            d.waveformKind === "chirp",
        },
        {
          key: "sinusoidalOffset",
          type: "number",
          label: "Offset",
          showWhen: (d) => d.waveformKind === "sinusoidal",
        },
        /* Canonical step pulse (t_on, t_off) */
        {
          key: "pulseOnS",
          type: "quantity",
          label: "On time",
          symbol: (
            <>
              t<sub>on</sub>
            </>
          ),
          units: TIME_UNITS,
          defaultDisplayUnit: "ns",
          showWhen: (d) => d.waveformKind === "pulse",
        },
        {
          key: "pulseOffS",
          type: "quantity",
          label: "Off time",
          symbol: (
            <>
              t<sub>off</sub>
            </>
          ),
          units: TIME_UNITS,
          defaultDisplayUnit: "ns",
          showWhen: (d) => d.waveformKind === "pulse",
          validate: (v, d) =>
            v <= d.pulseOnS ? "Pulse off time must be greater than on time." : null,
        },
        /* Gaussian / Chirp synthesis controls */
        {
          key: "chirpStopFreqHz",
          type: "quantity",
          label: "Chirp stop frequency",
          symbol: (
            <>
              f<sub>1</sub>
            </>
          ),
          units: FREQUENCY_UNITS,
          defaultDisplayUnit: "GHz",
          min: 0,
          minExclusive: true,
          showWhen: (d) => d.waveformKind === "chirp",
        },
        {
          key: "pulseSigmaS",
          type: "quantity",
          label: "Pulse width σ",
          symbol: (
            <>
              σ<sub>t</sub>
            </>
          ),
          units: TIME_UNITS,
          defaultDisplayUnit: "ns",
          min: 1e-15,
          showWhen: (d) =>
            d.waveformKind === "gaussian_pulse" || d.waveformKind === "chirp",
        },
        /* Controlled Piecewise-linear waypoints */
        {
          type: "custom",
          wide: true,
          showWhen: (d) => d.waveformKind === "piecewise_linear",
          render: (ctx) => (
            <ControlledPiecewiseWaypointsEditor
              points={ctx.draft.piecewisePoints}
              onChange={(next) => ctx.setField("piecewisePoints", next)}
              onParseErrorChange={setWaypointParseError}
            />
          ),
        },
      ],
    },
    {
      id: "drive-diagnostics",
      title: "Spectral & sampling diagnostics",
      icon: Activity,
      defaultOpen: false,
      rows: [
        {
          type: "readonly",
          label: "Estimated max frequency",
          mono: true,
          format: (d) =>
            `${(estimateFieldDriveMaxFrequencyHz(d) * 1e-9).toFixed(3)} GHz`,
        },
        {
          type: "readonly",
          label: "Output Nyquist frequency",
          mono: true,
          format: (d) => {
            const nyquistHz = resolveDraftNyquistHz(scene, d);
            return nyquistHz !== null
              ? `${(nyquistHz * 1e-9).toFixed(3)} GHz`
              : "No table cadence configured";
          },
        },
      ],
    },
  ];
}
