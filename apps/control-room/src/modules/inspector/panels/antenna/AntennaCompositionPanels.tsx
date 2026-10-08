import type { ReactNode } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { antennaPortValidationMessages } from "@/shared/domain/physics/antennaPortValidation";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import {
  useAntennaFieldSolutionResource,
  useAntennaStageOutputCatalogResource,
  useAntennaSourceSpectrumResource,
} from "@/kernel/resources/antennaResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { AntennaSourceSpectrumPayloadView } from "./AntennaSourceSpectrumPayloadView";
import { AntennaFieldBasisPreview } from "./AntennaFieldBasisPreview";
import { AntennaExternalLeadInspectionPanel } from "./AntennaExternalLeadInspectionPanel";
import { AntennaProjectionDriveComposer } from "./AntennaProjectionDriveComposer";
import { AntennaSolveTargetsEditor } from "./AntennaSolveTargetsEditor";
import { AntennaSpectrumComposer } from "./AntennaSpectrumComposer";
import { MicrostripGeometryEditor } from "./MicrostripGeometryEditor";
import { AntennaPlacementEditor } from "./AntennaPlacementEditor";
import { SolvedAntennaDriveEditor } from "./SolvedAntennaDriveEditor";
import { antennaWaveformBandwidthValue } from "./AntennaCompositionModel";
import {
  antennaFieldSolutionIdentityStatus,
  antennaSpectrumIdentityStatus,
  resolveAntennaRuntimeIds,
  type AntennaCompositionKind,
  type AntennaRuntimeIds,
} from "./AntennaCompositionRuntime";

type AntennaTarget = NonNullable<
  SceneResource["antenna_target_projections"]
>[number]["target"];
type AntennaPortMode = NonNullable<SceneResource["antenna_port_modes"]>[number];
type AntennaSolveStage = NonNullable<
  SceneResource["antenna_field_solve_stages"]
>[number];
type AntennaProjection = NonNullable<
  SceneResource["antenna_target_projections"]
>[number];
type AntennaFieldSolutionReference = AntennaProjection["solution"];
type AntennaDrive = NonNullable<SceneResource["solved_antenna_drives"]>[number];
type AntennaSpectrumRequest = NonNullable<
  SceneResource["antenna_spectrum_requests"]
>[number];

interface DetailRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
  unit?: string;
}

interface DetailModel {
  badge: string;
  rows: DetailRow[];
  title: string;
}

type AntennaFieldSolutionResult = ReturnType<
  typeof useAntennaFieldSolutionResource
>;
type AntennaSourceSpectrumResult = ReturnType<
  typeof useAntennaSourceSpectrumResource
>;
type AntennaStageOutputCatalogResult = ReturnType<
  typeof useAntennaStageOutputCatalogResource
>;

function selectedObjectId(selection: InspectorPanelProps["selection"]): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function selectedResourceId(
  selection: InspectorPanelProps["selection"],
): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.antennaResourceId ?? null
    : null;
}

function selectedResourceKind(
  selection: InspectorPanelProps["selection"],
): AntennaCompositionKind | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.antennaResourceKind ?? null
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown, fallback = "unavailable"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, unit = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toExponential(4)}${unit ? ` ${unit}` : ""}`
    : `unavailable${unit ? ` ${unit}` : ""}`;
}

function executionValue(value: unknown): string {
  const execution = recordValue(value);
  if (!execution) return "unavailable";
  const fields = [
    ["backend", execution.discretization ?? execution.backend],
    ["device", execution.device],
    ["precision", execution.precision],
    ["mode", execution.execution_mode],
  ];
  return fields
    .filter((field): field is [string, string] =>
      typeof field[1] === "string" && field[1].length > 0)
    .map(([label, field]) => `${label}=${field}`)
    .join(" · ") || "unavailable";
}

function targetValue(target: AntennaTarget): string {
  if (target.kind === "global") return "global";
  if (target.kind === "object") return `object:${target.object_id}`;
  return `region:${target.object_id}/${target.region_id}`;
}

function waveformValue(waveform: AntennaDrive["waveform"]): string {
  switch (waveform.kind) {
    case "constant":
      return "constant";
    case "sinusoidal":
      return `sinusoidal, f=${numberValue(waveform.frequency_hz, "Hz")}, phase=${numberValue(waveform.phase_rad ?? 0, "rad")}, offset=${numberValue(waveform.offset ?? 0)}`;
    case "sinc_pulse":
      return `sinc pulse, fc=${numberValue(waveform.cutoff_hz, "Hz")}, t0=${numberValue(waveform.t0 ?? 0, "s")}, amplitude=${numberValue(waveform.amplitude ?? 1)}`;
    case "pulse":
      return `pulse, ${numberValue(waveform.t_on, "s")} → ${numberValue(waveform.t_off, "s")}`;
    case "piecewise_linear":
      return `piecewise linear (${waveform.points.length} points)`;
    default:
      return "unknown";
  }
}

function activationValue(activation: AntennaDrive["activation"]): string {
  return activation.kind === "all_time_evolution"
    ? "all time-evolution stages"
    : activation.stage_ids.length > 0
      ? activation.stage_ids.join(", ")
      : "no stages selected";
}

function conductorDetails(
  objectId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  const geometry = recordValue(object?.geometry);
  const isCpw = geometry?.geometry_kind === "CPWAntennaLayout";
  const params = isCpw || geometry?.geometry_kind === "MicrostripAntennaLayout"
    ? recordValue(geometry.geometry_params)
    : null;
  const stations = Array.isArray(params?.stations) ? params.stations : [];
  return {
    title: "Antenna conductor",
    badge: "3D geometry",
    rows: [
      { label: "Object", value: objectId ?? "none", mono: true },
      { label: "Name", value: textValue(object?.name, objectId ?? "unavailable") },
      { label: "Role", value: textValue(object?.role) },
      { label: "Geometry", value: textValue(geometry?.geometry_kind ?? geometry?.kind) },
      ...(params ? [
        { label: "Length", value: numberValue(params.length_m, "m") },
        { label: "Thickness", value: numberValue(params.thickness_m, "m") },
        { label: "Conductivity", value: numberValue(params.conductivity_s_per_m, "S/m") },
        ...(!isCpw ? [
          { label: "Return width", value: numberValue(params.return_width_m, "m") },
          { label: "Return offset", value: numberValue(params.return_offset_m, "m") },
        ] : []),
        ...stations.flatMap((entry, index) => {
          const station = recordValue(entry);
          if (isCpw) return [
            { label: `Station ${index + 1}`, value: `s=${numberValue(station?.s)}` },
            ...[
              ["Signal width", "signal_width_m"],
              ["Left gap", "left_gap_m"],
              ["Right gap", "right_gap_m"],
              ["Left ground", "left_ground_width_m"],
              ["Right ground", "right_ground_width_m"],
            ].map(([label, key]) => ({
              label: `${index + 1} · ${label}`,
              value: numberValue(station?.[key], "m"),
            })),
          ];
          return [{
            label: `Station ${index + 1}`,
            value: `s=${numberValue(station?.s)}, signal width=${numberValue(station?.signal_width_m, "m")}`,
          }];
        }),
      ] : []),
      { label: "Material", value: textValue(object?.material_ref, "unassigned") },
      { label: "Mesh policy", value: object?.object_mesh ? "authored" : "default" },
    ],
  };
}

export function AntennaConductorDetails({ objectId, scene }: {
  objectId: string | null;
  scene: SceneResource | null;
}) {
  const model = conductorDetails(objectId, scene);
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  const isCpw = recordValue(object?.geometry)?.geometry_kind === "CPWAntennaLayout";
  return <InspectorGroup title={model.title} badge={model.badge} className={isCpw ? "fm-antenna-inspection" : undefined}>
    {model.rows.map((row) => <FieldRow key={row.label} {...row} />)}
  </InspectorGroup>;
}

function portDetails(
  objectId: string | null,
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const mode = scene?.antenna_port_modes?.find(
    (candidate) => candidate.source_object_id === objectId && candidate.id === resourceId,
  ) as AntennaPortMode | undefined;
  if (!mode) {
    return { title: "Antenna port", badge: "missing", rows: [{ label: "Status", value: "Port mode is not present in SceneResource." }] };
  }
  const validationMessages = antennaPortValidationMessages(mode);
  return {
    title: `Antenna port ${mode.id}`,
    badge: `${mode.branches.length} branches${validationMessages.length > 0 ? " · invalid" : ""}`,
    rows: [
      { label: "Validation", value: validationMessages.join("; ") || "ready" },
      { label: "ID", value: mode.id, mono: true },
      { label: "Schema", value: mode.schema_version, mono: true },
      { label: "Source object", value: mode.source_object_id, mono: true },
      { label: "Current transport", value: mode.current_transport_id, mono: true },
      { label: "Normalization", value: numberValue(mode.normalization_current_a, "A") },
      ...mode.branches.map((branch) => ({
        label: `Branch ${branch.id}`,
        value: `${branch.inlet_terminal_ref} → ${branch.outlet_terminal_ref}`,
        unit: numberValue(branch.signed_weight, "signed weight"),
      })),
    ],
  };
}

function solutionDetails(
  objectId: string | null,
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const stage = scene?.antenna_field_solve_stages?.find(
    (candidate) => candidate.source_object_id === objectId && candidate.id === resourceId,
  ) as AntennaSolveStage | undefined;
  if (!stage) {
    return { title: "Antenna field solve", badge: "missing", rows: [{ label: "Status", value: "Solve stage is not present in SceneResource." }] };
  }
  const validationMessages = antennaStageValidationMessages(stage, scene);
  return {
    title: `Antenna field solve ${stage.id}`,
    badge: validationMessages.length > 0 ? "invalid · result pending" : "configured · result pending",
    rows: [
      { label: "Validation", value: validationMessages.join("; ") || "ready" },
      { label: "ID", value: stage.id, mono: true },
      { label: "Current transport", value: stage.current_transport_id, mono: true },
      { label: "Port modes", value: stage.port_mode_ids.join(", ") || "none" },
      { label: "Model", value: stage.model },
      { label: "Oersted realization", value: stage.oersted_realization },
      { label: "Conductor mesh", value: stage.conductor_mesh_policy },
      { label: "Sampling domain", value: targetValue(stage.field_sampling_domain) },
      { label: "Targets", value: stage.target_refs.map(targetValue).join(", ") || "none" },
      { label: "Solver policy", value: stage.solver_policy },
      { label: "Outputs", value: stage.outputs.map((output) => `${output.id} (${output.quantity})`).join(", ") || "none" },
      { label: "Publication", value: "No runtime solution resource is attached yet." },
    ],
  };
}

function antennaSolutionReferenceValidationMessages(
  solution: AntennaFieldSolutionReference,
  scene: SceneResource | null,
): string[] {
  const messages: string[] = [];
  const stages = scene?.antenna_field_solve_stages;
  if (stages) {
    const stage = stages.find(
      (candidate) => candidate.id === solution.stage_id,
    );
    if (!stage) {
      messages.push(`missing solve stage '${solution.stage_id}'`);
    } else {
      const output = stage.outputs.find(
        (candidate) => candidate.id === solution.output_id,
      );
      if (!output) {
        messages.push(`missing solve output '${solution.output_id}'`);
      } else if (output.quantity !== "H_ant_basis") {
        messages.push(
          `solve output '${solution.output_id}' must publish H_ant_basis`,
        );
      }
    }
  }
  if ("kind" in solution && solution.kind === "stage_output") {
    return messages;
  }
  if (typeof solution.asset_id !== "string" || !solution.asset_id.trim()) {
    messages.push("missing solution asset");
  }
  if (
    typeof solution.content_digest !== "string" ||
    !solution.content_digest.trim()
  ) {
    messages.push("missing solution content digest");
  }
  return messages;
}

function antennaTargetValidationMessages(
  target: AntennaTarget,
  scene: SceneResource | null,
): string[] {
  if (target.kind === "global") return [];
  const messages: string[] = [];
  const objects = scene?.objects;
  if (!objects) return messages;
  const object = objects.find(
    (candidate) => candidate.id === target.object_id,
  );
  if (!object) {
    messages.push(`missing target object '${target.object_id}'`);
    return messages;
  }
  if (target.kind !== "region" || !object.regions) return messages;
  const hasRegion = object.regions.some(
    (candidate) =>
      candidate.region_id === target.region_id ||
      candidate.name === target.region_id,
  );
  if (!hasRegion) {
    messages.push(
      `missing target region '${target.object_id}/${target.region_id}'`,
    );
  }
  return messages;
}

function antennaProjectionValidationMessages(
  projection: AntennaProjection,
  scene: SceneResource | null,
): string[] {
  return [
    ...antennaSolutionReferenceValidationMessages(projection.solution, scene),
    ...antennaTargetValidationMessages(projection.target, scene),
  ];
}

function projectionDetails(
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const projection = scene?.antenna_target_projections?.find(
    (candidate) => candidate.id === resourceId,
  ) as AntennaProjection | undefined;
  if (!projection) {
    return { title: "Antenna target projection", badge: "missing", rows: [{ label: "Status", value: "Projection is not present in SceneResource." }] };
  }
  const validationMessages = antennaProjectionValidationMessages(projection, scene);
  return {
    title: `Antenna projection ${projection.id}`,
    badge: validationMessages.length > 0 ? "invalid · result pending" : "configured · result pending",
    rows: [
      { label: "Validation", value: validationMessages.join("; ") || "ready" },
      { label: "ID", value: projection.id, mono: true },
      { label: "Output", value: projection.output_id, mono: true },
      { label: "Solve stage", value: projection.solution.stage_id, mono: true },
      { label: "Reference", value: "kind" in projection.solution && projection.solution.kind === "stage_output" ? "Stage output (awaiting publication)" : "Published asset" },
      { label: "Asset", value: "asset_id" in projection.solution ? projection.solution.asset_id : "pending", mono: true },
      { label: "Content digest", value: "content_digest" in projection.solution ? projection.solution.content_digest : "pending", mono: true },
      { label: "Target", value: targetValue(projection.target) },
      { label: "Publication", value: "Projection awaits a verified field-solution asset." },
    ],
  };
}

function antennaDriveValidationMessages(
  drive: AntennaDrive,
  scene: SceneResource | null,
): string[] {
  const messages: string[] = [];
  if (!Number.isFinite(drive.peak_current_a)) {
    messages.push("peak current must be finite");
  }
  const waveform = drive.waveform;
  switch (waveform.kind) {
    case "sinusoidal":
      if (!Number.isFinite(waveform.frequency_hz) || waveform.frequency_hz <= 0) {
        messages.push("sinusoidal frequency must be finite and > 0 Hz");
      }
      if (!Number.isFinite(waveform.phase_rad ?? 0) || !Number.isFinite(waveform.offset ?? 0)) {
        messages.push("sinusoidal phase and offset must be finite");
      }
      break;
    case "sinc_pulse":
      if (!Number.isFinite(waveform.cutoff_hz) || waveform.cutoff_hz <= 0) {
        messages.push("sinc cutoff must be finite and > 0 Hz");
      }
      if (!Number.isFinite(waveform.t0 ?? 0) || (waveform.t0 ?? 0) < 0 || !Number.isFinite(waveform.amplitude ?? 1)) {
        messages.push("sinc t0 must be finite and >= 0 s; amplitude must be finite");
      }
      break;
    case "pulse":
      if (!Number.isFinite(waveform.t_on) || !Number.isFinite(waveform.t_off) || waveform.t_off <= waveform.t_on) {
        messages.push("pulse requires finite t_off > t_on");
      }
      break;
    case "piecewise_linear":
      if (
        waveform.points.length < 2 ||
        waveform.points.some((point) => point.length !== 2 || point.some((value) => !Number.isFinite(value))) ||
        waveform.points.some((point, index) => index > 0 && point[0] <= waveform.points[index - 1][0])
      ) {
        messages.push("piecewise-linear points must be finite pairs with strictly increasing times");
      }
      break;
  }
  if (drive.activation.kind === "stage_ids") {
    const stageIds = drive.activation.stage_ids;
    if (stageIds.length === 0 || stageIds.some((id) => !id.trim()) || new Set(stageIds).size !== stageIds.length) {
      messages.push("activation stage ids must be non-empty and unique");
    }
  }
  if (scene?.antenna_port_modes) {
    const hasPort = scene.antenna_port_modes.some(
      (candidate) => candidate.id === drive.port_mode_id,
    );
    if (!hasPort) {
      messages.push(`missing port mode '${drive.port_mode_id}'`);
    }
  }
  if (scene?.antenna_target_projections) {
    const projection = scene.antenna_target_projections.find(
      (candidate) => candidate.id === drive.projection_ref,
    );
    if (!projection) {
      messages.push(`missing projection '${drive.projection_ref}'`);
    } else {
      for (const message of antennaProjectionValidationMessages(projection, scene)) {
        messages.push(`projection '${projection.id}': ${message}`);
      }
    }
  }
  return messages;
}

function antennaSpectrumValidationMessages(
  request: AntennaSpectrumRequest,
  scene: SceneResource | null,
): string[] {
  const messages = [
    ...antennaSolutionReferenceValidationMessages(request.solution_ref, scene),
    ...antennaTargetValidationMessages(request.target, scene),
  ];
  const stage = scene?.antenna_field_solve_stages?.find(
    (candidate) => candidate.id === request.solution_ref.stage_id,
  );
  if (scene?.antenna_port_modes) {
    if (request.port_mode_id) {
      const hasPort = scene.antenna_port_modes.some(
        (candidate) => candidate.id === request.port_mode_id,
      );
      if (!hasPort) {
        messages.push(`missing port mode '${request.port_mode_id}'`);
      } else if (stage && !stage.port_mode_ids.includes(request.port_mode_id)) {
        messages.push(
          `port mode '${request.port_mode_id}' is not attached to solve stage '${stage.id}'`,
        );
      }
    } else if (!stage || stage.port_mode_ids.length !== 1) {
      messages.push("spectrum requires exactly one port mode when port_mode_id is omitted");
    }
  }

  const plane = request.sampling_plane;
  const planeValues = [
    ...plane.origin_m,
    ...plane.axis_u,
    ...plane.axis_v,
    plane.extent_u_m,
    plane.extent_v_m,
  ];
  const dot = plane.axis_u.reduce(
    (sum, value, index) => sum + value * (plane.axis_v[index] ?? 0),
    0,
  );
  const normU = plane.axis_u.reduce((sum, value) => sum + value * value, 0);
  const normV = plane.axis_v.reduce((sum, value) => sum + value * value, 0);
  const validFrame =
    plane.origin_m.length === 3 &&
    plane.axis_u.length === 3 &&
    plane.axis_v.length === 3 &&
    planeValues.every(Number.isFinite) &&
    Math.abs(normU - 1) <= 1e-12 &&
    Math.abs(normV - 1) <= 1e-12 &&
    Math.abs(dot) <= 1e-12 &&
    plane.extent_u_m > 0 &&
    plane.extent_v_m > 0 &&
    Number.isInteger(plane.sample_count_u) &&
    Number.isInteger(plane.sample_count_v) &&
    plane.sample_count_u >= 2 &&
    plane.sample_count_v >= 2 &&
    (request.window === "rectangular" ||
      (plane.sample_count_u >= 3 && plane.sample_count_v >= 3)) &&
    (plane.interpolation === "fem_element" ||
      plane.interpolation === "fdm_trilinear");
  if (!validFrame) messages.push("invalid sampling frame");

  if (request.transform === "spatial_fft") {
    if (request.nonuniform_k_grid) {
      messages.push("spatial_fft must not define nonuniform_k_grid");
    }
  } else {
    const grid = request.nonuniform_k_grid;
    const validGrid =
      grid !== null &&
      grid !== undefined &&
      grid.k_u_rad_per_m.length > 0 &&
      grid.k_v_rad_per_m.length > 0 &&
      [...grid.k_u_rad_per_m, ...grid.k_v_rad_per_m].every(Number.isFinite);
    if (!validGrid) {
      messages.push("nonuniform_spatial_fft requires a finite nonuniform k-grid");
    }
  }
  if (![
    "x",
    "y",
    "z",
    "u",
    "v",
    "normal",
    "vector_power",
    "transverse",
  ].includes(request.component)) {
    messages.push(`unsupported spectrum component '${request.component}'`);
  }
  if (request.component === "transverse") {
    if (!request.equilibrium_ref?.trim()) {
      messages.push("transverse spectrum requires equilibrium_ref");
    } else {
      messages.push("transverse spectrum is unsupported until equilibrium projection is implemented");
    }
  }
  if (request.mode_basis_ref !== null && request.mode_basis_ref !== undefined) {
    messages.push(request.mode_basis_ref.trim()
      ? "mode_basis_ref is unsupported until verified modal analysis is implemented"
      : "mode_basis_ref must be non-empty when specified");
  }
  if (!request.output_id.trim()) messages.push("missing spectrum output id");
  return messages;
}

function driveDetails(
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const drive = scene?.solved_antenna_drives?.find(
    (candidate) => candidate.id === resourceId,
  ) as AntennaDrive | undefined;
  if (!drive) {
    return { title: "Solved antenna drive", badge: "missing", rows: [{ label: "Status", value: "Solved drive is not present in SceneResource." }] };
  }
  const validationMessages = antennaDriveValidationMessages(drive, scene);
  return {
    title: drive.name,
    badge: validationMessages.length > 0 ? "invalid · result pending" : "configured · result pending",
    rows: [
      { label: "Validation", value: validationMessages.join("; ") || "ready" },
      { label: "ID", value: drive.id, mono: true },
      { label: "Port mode", value: drive.port_mode_id, mono: true },
      { label: "Projection", value: drive.projection_ref, mono: true },
      { label: "Peak current", value: numberValue(drive.peak_current_a, "A") },
      { label: "Waveform", value: waveformValue(drive.waveform) },
      { label: "Declared bandwidth", value: antennaWaveformBandwidthValue(drive.bandwidth_declaration) },
      { label: "Time origin", value: drive.time_origin },
      { label: "Activation", value: activationValue(drive.activation) },
      { label: "Publication", value: "Drive is configured but no qualified target projection is published." },
    ],
  };
}

function spectrumDetails(
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  const request = scene?.antenna_spectrum_requests?.find(
    (candidate) => candidate.id === resourceId,
  ) as AntennaSpectrumRequest | undefined;
  if (!request) {
    return { title: "Antenna spectrum", badge: "missing", rows: [{ label: "Status", value: "Spectrum request is not present in SceneResource." }] };
  }
  const validationMessages = antennaSpectrumValidationMessages(request, scene);
  const plane = request.sampling_plane;
  return {
    title: `Antenna spectrum ${request.id}`,
    badge: validationMessages.length > 0 ? "invalid · result pending" : "configured · result pending",
    rows: [
      { label: "Validation", value: validationMessages.join("; ") || "ready" },
      { label: "ID", value: request.id, mono: true },
      { label: "Output", value: request.output_id, mono: true },
      { label: "Solve stage", value: request.solution_ref.stage_id, mono: true },
      { label: "Transform", value: request.transform },
      { label: "Component", value: request.component },
      { label: "Equilibrium", value: request.equilibrium_ref || "none", mono: true },
      { label: "Modal basis", value: request.mode_basis_ref || "none", mono: true },
      { label: "Target", value: targetValue(request.target) },
      { label: "Plane", value: `${plane.sample_count_u} × ${plane.sample_count_v}, ${plane.interpolation}` },
      { label: "Outside policy", value: plane.outside_policy },
      { label: "Window", value: request.window },
      { label: "Normalization", value: request.normalization },
      { label: "k-grid", value: request.nonuniform_k_grid ? "nonuniform authored" : "FFT grid" },
      { label: "Publication", value: "Spectrum request is configured; binary FFT payload is published after a qualified solve." },
    ],
  };
}

function detailModel(
  kind: AntennaCompositionKind,
  objectId: string | null,
  resourceId: string | null,
  scene: SceneResource | null,
): DetailModel {
  switch (kind) {
    case "conductor":
      return conductorDetails(objectId, scene);
    case "port":
      return portDetails(objectId, resourceId, scene);
    case "solution":
      return solutionDetails(objectId, resourceId, scene);
    case "projection":
      return projectionDetails(resourceId, scene);
    case "drive":
      return driveDetails(resourceId, scene);
    case "spectrum":
      return spectrumDetails(resourceId, scene);
  }
}

function runtimeStatus<T>(
  resourceId: string | null,
  result: { data: T | null; error: Error | null; status: string },
): string {
  if (!resourceId) return "not attached";
  if (result.status === "error") return "error";
  if (result.status === "loading") return "loading";
  if (result.status === "stale") return result.data ? "stale" : "loading";
  if (result.status === "ready") return result.data ? "ready" : "missing";
  return "pending";
}

function runtimeBadge(
  baseBadge: string,
  status: string,
): string {
  switch (status) {
    case "ready":
      return "ready";
    case "missing":
      return "missing result";
    case "loading":
      return "loading result";
    case "stale":
      return "stale result";
    case "error":
      return "result error";
    case "identity mismatch":
      return "stale result";
    default:
      return baseBadge;
  }
}

function fieldSolutionRuntimeRows(
  result: AntennaFieldSolutionResult,
  verifiedStatus: string,
): DetailRow[] {
  const data = result.data;
  const rows: DetailRow[] = [{ label: "Runtime result", value: verifiedStatus }];
  if (result.error) {
    rows.push({ label: "Runtime error", value: result.error.message });
  }
  if (!data || verifiedStatus !== "ready") return rows;
  rows.push(
    { label: "Published solution", value: data.solution_id, mono: true },
    { label: "Asset", value: data.asset_id, mono: true },
    { label: "Content digest", value: data.content_digest, mono: true },
    { label: "Quantity", value: `${data.quantity} / ${data.component}` },
    { label: "Requested execution", value: executionValue(data.requested_execution) },
    { label: "Resolved execution", value: executionValue(data.resolved_execution) },
    { label: "Gauge policy", value: data.gauge_policy },
    {
      label: "Field signature",
      value: data.signatures.field_solution_signature,
      mono: true,
    },
    { label: "Port bases", value: String(data.bases.length) },
    {
      label: "Sampling carrier",
      value: data.sample_topology ? "tet4 P1 connectivity" : "point samples only",
    },
    {
      label: "Sample payload",
      value: `${data.sample_positions.value_count} values · ${data.sample_positions.path}`,
    },
    ...data.bases.flatMap((basis) => [
      { label: `Port ${basis.port_mode_id} measured current`, value: numberValue(basis.measured_positive_terminal_current_a, "A") },
      { label: `Port ${basis.port_mode_id} normalization`, value: numberValue(basis.normalization_current_a, "A") },
      { label: `Port ${basis.port_mode_id} scale`, value: numberValue(basis.normalization_scale) },
      { label: `Port ${basis.port_mode_id} current certificate`, value: basis.current_balance_certificate_digest, mono: true },
      { label: `Port ${basis.port_mode_id} magnetic basis`, value: `${basis.magnetic_field_per_ampere.unit} · ${basis.magnetic_field_per_ampere.value_count} values` },
    ]),
  );
  return rows;
}

function sourceSpectrumRuntimeRows(
  result: AntennaSourceSpectrumResult,
  verifiedStatus: string,
): DetailRow[] {
  const data = result.data;
  const rows: DetailRow[] = [{ label: "Runtime result", value: verifiedStatus }];
  if (result.error) {
    rows.push({ label: "Runtime error", value: result.error.message });
  }
  if (!data || verifiedStatus !== "ready") return rows;
  rows.push(
    { label: "Published output", value: data.output_id, mono: true },
    { label: "Content digest", value: data.content_digest, mono: true },
    { label: "Quantity", value: `${data.quantity} / ${data.component}` },
    { label: "Field signature", value: data.field_signature, mono: true },
    { label: "k-grid", value: `${data.k_u_count} × ${data.k_v_count}` },
    {
      label: "Amplitude samples",
      value: `${data.amplitude_count} · ${data.amplitude_unit}`,
    },
    { label: "Power samples", value: String(data.power_count) },
    {
      label: "Sampling realization",
      value: `${data.sampling.realization}, outside=${data.sampling.outside_count}`,
    },
    { label: "Payload", value: `${data.payload.format} · ${data.payload.path}` },
    ...(data.payloads
      ? [{ label: "Binary payloads", value: "k_u · k_v · amplitudes · power" }]
      : []),
  );
  return rows;
}

function stageOutputCatalogRuntimeRows(
  stageId: string | null,
  result: AntennaStageOutputCatalogResult,
): DetailRow[] {
  const status = runtimeStatus(stageId, result);
  const data = result.data;
  const rows: DetailRow[] = [{ label: "Stage catalog result", value: status }];
  if (result.error) {
    rows.push({ label: "Stage catalog error", value: result.error.message });
  }
  if (!data) return rows;
  rows.push(
    { label: "Stage status", value: data.status },
    { label: "Stage revision", value: String(data.stage_revision) },
    {
      label: "Stage outputs",
      value: data.outputs.map((output) => output.output_id).join(", ") || "none",
    },
    {
      label: "Stage quantities",
      value:
        data.outputs
          .flatMap((output) => output.quantity_ids)
          .join(", ") || "none",
    },
    {
      label: "Stage assets",
      value:
        data.outputs.map((output) => output.solution_ref.asset_id).join(", ") ||
        "none",
      mono: true,
    },
    {
      label: "Stage reuse",
      value:
        data.outputs
          .map((output) =>
            `${output.output_id}: ${output.reused_existing ? "reused" : "published"}`,
          )
          .join(", ") || "none",
    },
    {
      label: "Stage manifests",
      value: data.outputs.map((output) => output.manifest_ref).join(", ") || "none",
      mono: true,
    },
    { label: "Catalog digest", value: data.content_digest, mono: true },
  );
  if (data.diagnostic) {
    rows.push({ label: "Stage diagnostic", value: data.diagnostic });
  }
  return rows;
}

function enrichRuntimeModel(
  model: DetailModel,
  kind: AntennaCompositionKind,
  ids: AntennaRuntimeIds,
  fieldSolution: AntennaFieldSolutionResult,
  stageOutputCatalog: AntennaStageOutputCatalogResult,
  sourceSpectrum: AntennaSourceSpectrumResult,
): DetailModel {
  const fieldStatus = antennaFieldSolutionIdentityStatus(ids, fieldSolution, stageOutputCatalog);
  const rows = [...model.rows];

  if (ids.stageId) {
    rows.push(...stageOutputCatalogRuntimeRows(ids.stageId, stageOutputCatalog));
  }

  if (kind === "solution") {
    const currentStatus = model.badge.startsWith("invalid") ? "authoring invalid" : fieldStatus;
    rows.push(...fieldSolutionRuntimeRows(fieldSolution, currentStatus));
    return {
      ...model,
      badge: currentStatus === "authoring invalid" ? model.badge : runtimeBadge(model.badge, fieldStatus),
      rows,
    };
  }
  if (kind === "spectrum") {
    const spectrumStatus = antennaSpectrumIdentityStatus(ids, sourceSpectrum, stageOutputCatalog);
    rows.push(...sourceSpectrumRuntimeRows(sourceSpectrum, spectrumStatus));
    return {
      ...model,
      badge: runtimeBadge(model.badge, spectrumStatus),
      rows,
    };
  }
  if (kind === "projection" || kind === "drive") {
    rows.push({ label: "Field solution result", value: fieldStatus });
    if (fieldSolution.data && fieldStatus === "ready") {
      rows.push({
        label: "Published field digest",
        value: fieldSolution.data.content_digest,
        mono: true,
      });
    }
  }
  return {
    ...model,
    badge: fieldStatus === "identity mismatch" ? "stale result" : model.badge,
    rows,
  };
}

export function AntennaCompositionPanel({
  kind,
  selection,
}: InspectorPanelProps & { kind: AntennaCompositionKind }) {
  const scene = useSceneResource();
  const objectId = selectedObjectId(selection);
  const resourceId = selectedResourceId(selection);
  const selectedKind = selectedResourceKind(selection) ?? kind;
  const ids = resolveAntennaRuntimeIds(selectedKind, resourceId, scene.data);
  const fieldSolution = useAntennaFieldSolutionResource(ids.solutionId, {
    enabled:
      kind === "solution" ||
      kind === "projection" ||
      kind === "drive",
  });
  const sourceSpectrum = useAntennaSourceSpectrumResource(ids.spectrumOutputId, {
    enabled: kind === "spectrum",
  });
  const stageOutputCatalog = useAntennaStageOutputCatalogResource(ids.stageId, {
    enabled:
      kind === "solution" ||
      kind === "projection" ||
      kind === "drive" ||
      kind === "spectrum",
  });
  const model = enrichRuntimeModel(
    detailModel(kind, objectId, resourceId, scene.data),
    kind,
    ids,
    fieldSolution,
    stageOutputCatalog,
    sourceSpectrum,
  );

  return (
    <div className="fm-inspector-panel">
      {kind === "conductor" ? <AntennaConductorDetails objectId={objectId} scene={scene.data} /> : <InspectorGroup title={model.title} badge={model.badge}>
        {model.rows.map((row) => (
          <FieldRow
            key={row.label}
            label={row.label}
            mono={row.mono}
            unit={row.unit}
            value={row.value}
          />
        ))}
        {model.badge.includes("pending") ? (
          <FeedbackBanner
            kind="warning"
            message={model.badge.startsWith("invalid")
              ? "Complete the antenna stage validation requirements before field solve; an older published result is not current."
              : "To publish H_ant or FFT results, run the configured field-solve/projection stage first."}
          />
        ) : null}
      </InspectorGroup>}
      {kind === "conductor" && objectId ? <MicrostripGeometryEditor objectId={objectId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "conductor" && objectId ? <AntennaPlacementEditor objectId={objectId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "solution" && objectId && resourceId ? <AntennaSolveTargetsEditor key={`targets:${objectId}:${resourceId}`} objectId={objectId} stageId={resourceId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "solution" && ids.stageId ? <AntennaExternalLeadInspectionPanel authoredStageId={ids.stageId} /> : null}
      {kind === "solution" && fieldSolution.data &&
      model.badge === "ready" &&
      antennaFieldSolutionIdentityStatus(ids, fieldSolution, stageOutputCatalog) === "ready" ? (
        <AntennaFieldBasisPreview
          key={fieldSolution.data.asset_id}
          solution={fieldSolution.data}
        />
      ) : null}
      {kind === "solution" && resourceId ? <AntennaProjectionDriveComposer key={`projection:${resourceId}`} stageId={resourceId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "solution" && resourceId ? <AntennaSpectrumComposer key={`spectrum:${resourceId}`} stageId={resourceId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "drive" && resourceId ? <SolvedAntennaDriveEditor driveId={resourceId} scene={scene.data} status={scene.status} refetch={scene.refetch} /> : null}
      {kind === "spectrum" &&
      ids.spectrumOutputId &&
      sourceSpectrum.data?.payloads ? (
        <AntennaSourceSpectrumPayloadView
          outputId={ids.spectrumOutputId}
          spectrum={sourceSpectrum.data}
        />
      ) : null}
    </div>
  );
}

export function AntennaConductorPanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="conductor" />;
}

export function AntennaPortPanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="port" />;
}

export function AntennaSolutionPanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="solution" />;
}

export function AntennaProjectionPanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="projection" />;
}

export function SolvedAntennaDrivePanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="drive" />;
}

export function AntennaSpectrumPanel(props: InspectorPanelProps) {
  return <AntennaCompositionPanel {...props} kind="spectrum" />;
}
