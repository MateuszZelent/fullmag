import type { ReactNode } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
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
import { antennaWaveformBandwidthValue } from "./AntennaCompositionModel";
import {
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
  return {
    title: "Antenna conductor",
    badge: "3D geometry",
    rows: [
      { label: "Object", value: objectId ?? "none", mono: true },
      { label: "Name", value: textValue(object?.name, objectId ?? "unavailable") },
      { label: "Role", value: textValue(object?.role) },
      { label: "Geometry", value: textValue(geometry?.geometry_kind ?? geometry?.kind) },
      { label: "Material", value: textValue(object?.material_ref, "unassigned") },
      { label: "Mesh policy", value: object?.object_mesh ? "authored" : "default" },
    ],
  };
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
  return {
    title: `Antenna port ${mode.id}`,
    badge: `${mode.branches.length} branches`,
    rows: [
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
  return {
    title: `Antenna field solve ${stage.id}`,
    badge: "configured · result pending",
    rows: [
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
  return {
    title: `Antenna projection ${projection.id}`,
    badge: "configured · result pending",
    rows: [
      { label: "ID", value: projection.id, mono: true },
      { label: "Output", value: projection.output_id, mono: true },
      { label: "Solve stage", value: projection.solution.stage_id, mono: true },
      { label: "Asset", value: projection.solution.asset_id, mono: true },
      { label: "Content digest", value: projection.solution.content_digest, mono: true },
      { label: "Target", value: targetValue(projection.target) },
      { label: "Publication", value: "Projection awaits a verified field-solution asset." },
    ],
  };
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
  return {
    title: drive.name,
    badge: "configured · result pending",
    rows: [
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
  const plane = request.sampling_plane;
  return {
    title: `Antenna spectrum ${request.id}`,
    badge: "configured · result pending",
    rows: [
      { label: "ID", value: request.id, mono: true },
      { label: "Output", value: request.output_id, mono: true },
      { label: "Solve stage", value: request.solution_ref.stage_id, mono: true },
      { label: "Transform", value: request.transform },
      { label: "Component", value: request.component },
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
  resourceId: string | null,
  result: { data: unknown; error: Error | null; status: string },
): string {
  switch (runtimeStatus(resourceId, result)) {
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
    default:
      return baseBadge;
  }
}

function fieldSolutionRuntimeRows(
  resourceId: string | null,
  result: AntennaFieldSolutionResult,
): DetailRow[] {
  const status = runtimeStatus(resourceId, result);
  const data = result.data;
  const rows: DetailRow[] = [{ label: "Runtime result", value: status }];
  if (result.error) {
    rows.push({ label: "Runtime error", value: result.error.message });
  }
  if (!data) return rows;
  rows.push(
    { label: "Published solution", value: data.solution_id, mono: true },
    { label: "Asset", value: data.asset_id, mono: true },
    { label: "Content digest", value: data.content_digest, mono: true },
    { label: "Quantity", value: `${data.quantity} / ${data.component}` },
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
  );
  return rows;
}

function sourceSpectrumRuntimeRows(
  resourceId: string | null,
  result: AntennaSourceSpectrumResult,
): DetailRow[] {
  const status = runtimeStatus(resourceId, result);
  const data = result.data;
  const rows: DetailRow[] = [{ label: "Runtime result", value: status }];
  if (result.error) {
    rows.push({ label: "Runtime error", value: result.error.message });
  }
  if (!data) return rows;
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
  const fieldStatus = runtimeStatus(ids.solutionId, fieldSolution);
  const rows = [...model.rows];

  if (
    kind === "solution" ||
    kind === "projection" ||
    kind === "drive" ||
    kind === "spectrum"
  ) {
    rows.push(...stageOutputCatalogRuntimeRows(ids.stageId, stageOutputCatalog));
  }

  if (kind === "solution") {
    rows.push(...fieldSolutionRuntimeRows(ids.solutionId, fieldSolution));
    return {
      ...model,
      badge: runtimeBadge(model.badge, ids.solutionId, fieldSolution),
      rows,
    };
  }
  if (kind === "spectrum") {
    rows.push(...sourceSpectrumRuntimeRows(ids.spectrumOutputId, sourceSpectrum));
    return {
      ...model,
      badge: runtimeBadge(model.badge, ids.spectrumOutputId, sourceSpectrum),
      rows,
    };
  }
  if (kind === "projection" || kind === "drive") {
    rows.push({ label: "Field solution result", value: fieldStatus });
    if (fieldSolution.data) {
      rows.push({
        label: "Published field digest",
        value: fieldSolution.data.content_digest,
        mono: true,
      });
    }
  }
  return { ...model, rows };
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
      kind === "drive" ||
      kind === "spectrum",
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
      <InspectorGroup title={model.title} badge={model.badge}>
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
            message="To publish H_ant or FFT results, run the configured field-solve/projection stage first."
          />
        ) : null}
      </InspectorGroup>
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
