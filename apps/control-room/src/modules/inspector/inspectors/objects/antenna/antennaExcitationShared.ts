import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { AuthoringTransactionRequest, BinaryResourceResult, JsonObject, MaskTermResource, SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { AntennaOwnedResourceKind } from "@/shared/domain/physics/antennaResourceOwner";
import type { UnitOption } from "../../../template";
import type { SolvedDrive, SolvedDriveDraft, WaveformKind } from "../../../panels/antenna/SolvedAntennaDriveEditorModel";

export const LENGTH_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "µm", toSiFactor: 1e-6 },
  { unit: "nm", toSiFactor: 1e-9 },
  { unit: "mm", toSiFactor: 1e-3 },
  { unit: "m", toSiFactor: 1 },
];

export const CURRENT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mA", toSiFactor: 1e-3 },
  { unit: "µA", toSiFactor: 1e-6 },
  { unit: "A", toSiFactor: 1 },
];

export const FREQUENCY_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "GHz", toSiFactor: 1e9 },
  { unit: "MHz", toSiFactor: 1e6 },
  { unit: "Hz", toSiFactor: 1 },
];

export const TIME_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "ps", toSiFactor: 1e-12 },
  { unit: "ns", toSiFactor: 1e-9 },
  { unit: "s", toSiFactor: 1 },
];

export const FIELD_MT_UNITS: readonly [UnitOption, ...UnitOption[]] = [
  { unit: "mT", toSiFactor: 1e-3 },
  { unit: "µT", toSiFactor: 1e-6 },
  { unit: "T", toSiFactor: 1 },
];

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function formatLengthSmart(meters: number | null | undefined): string {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "—";
  const abs = Math.abs(meters);
  if (abs === 0) return "0 m";
  if (abs < 1e-6) return `${(meters * 1e9).toFixed(1)} nm`;
  if (abs < 1e-3) return `${(meters * 1e6).toFixed(2)} µm`;
  if (abs < 1) return `${(meters * 1e3).toFixed(2)} mm`;
  return `${meters.toFixed(3)} m`;
}

export function resolveSelectedObjectId(
  selection: Selection,
  fallback = "ant-1",
): string {
  if (selection.ref?.type === "scene-object") {
    return selection.ref.objectId;
  }
  const refRec = asRecord(selection.ref);
  return (
    selection.objectId ??
    asString(refRec?.objectId) ??
    asString(refRec?.sourceObjectId) ??
    fallback
  );
}

export function resolveSelectedAntennaResourceId(
  selection: Selection,
  legacyRefKey: string,
  nodeSegment: string,
): string | null {
  const refRec = asRecord(selection.ref);
  return (
    (selection.ref?.type === "scene-object"
      ? asString(selection.ref.antennaResourceId)
      : null) ??
    asString(refRec?.antennaResourceId) ??
    asString(refRec?.[legacyRefKey]) ??
    asString(selection.nodeId?.split(nodeSegment)[1]) ??
    null
  );
}

export function canonicalResourceSelection(
  selection: Selection,
  objectId: string,
  resourceKind: AntennaOwnedResourceKind,
  resourceId: string,
): Selection {
  if (
    selection.ref?.type === "scene-object" &&
    selection.ref.antennaResourceId === resourceId
  ) {
    return selection;
  }
  const kind = `object.antenna.${resourceKind}` as const;
  const nodeId =
    selection.nodeId ??
    `model:object:${objectId}:antenna:${resourceKind}:${resourceId}`;
  return {
    ...selection,
    kind,
    nodeId,
    objectId,
    ref: {
      antennaResourceId: resourceId,
      antennaResourceKind: resourceKind,
      kind,
      nodeId,
      objectId,
      type: "scene-object",
      visualizationTargetId: `object:${objectId}`,
    },
  };
}

export async function executeAntennaMergePatchTransaction(params: {
  kernel: ReturnType<typeof useKernel>;
  scene: SceneResource | null;
  sessionScopeKey: string | undefined;
  baseRevision: number;
  label: string;
  mergePatch: JsonObject;
}): Promise<void> {
  const { kernel, scene, sessionScopeKey, baseRevision, label, mergePatch } =
    params;
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  const isCurrentSessionScope = () => {
    const scopeMatches =
      !sessionScopeKey || !kernel.commands.getSessionScopeKey
        ? true
        : kernel.commands.getSessionScopeKey() === sessionScopeKey;
    const generationMatches =
      historyGeneration === undefined ||
      kernel.authoringHistory?.getGeneration?.() === historyGeneration;
    return scopeMatches && generationMatches;
  };
  const request: AuthoringTransactionRequest = {
    base_revision: baseRevision,
    kind: "merge_patch",
    merge_patch: mergePatch,
  };
  const response = await runAuthoringMutationWithHistory(
    {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      isCurrentSessionScope,
      resourceData: scene ? { [MODEL_SCENE_PATH]: scene } : undefined,
      selection: kernel.selection,
      sessionScopeKey,
    },
    label,
    () =>
      kernel.api.model.commitTransaction(
        request,
        sessionScopeKey ? { sessionScopeKey } : undefined,
      ),
    (res) => res?.committed_scene ?? scene,
  );
  const committedRev =
    typeof response?.scene_revision === "number"
      ? response.scene_revision
      : baseRevision + 1;
  if (response?.committed_scene) {
    publishCommittedSceneResource(
      kernel.resources,
      response.committed_scene,
      committedRev,
      undefined,
      false,
      sessionScopeKey ?? null,
      kernel.api.resourceCacheScope,
    );
  }
  invalidateAuthoringMutationDependents(
    kernel.resources,
    "interaction",
    committedRev,
  );
}

export interface AntennaDriveSpecDraft {
  name: string;
  bindingKey: string;
  peakCurrentA: number;
  waveformKind: WaveformKind;
  frequencyHz: number;
  phaseRad: number;
  offset: number;
  cutoffHz: number;
  sincT0: number;
  sincAmplitude: number;
  pulseOn: number;
  pulseOff: number;
  piecewisePoints: string;
  bandwidthHz: string;
  timeOrigin: "stage_local" | "absolute";
  activationKind: "all_time_evolution" | "stage_ids";
  stageIdsList: readonly string[];
  previewDomain: "time" | "frequency";
}

export function coerceCanonicalSolvedDrive(
  raw: JsonRecord | null,
  fallbackId: string,
  objectId: string,
): SolvedDrive {
  const wf = asRecord(raw?.waveform);
  const rawWfKind = asString(wf?.kind) ?? asString(raw?.waveform_kind);
  let waveform: SolvedDrive["waveform"];
  if (rawWfKind === "constant") {
    waveform = { kind: "constant" };
  } else if (rawWfKind === "sinc_pulse") {
    waveform = {
      amplitude: asNumber(wf?.amplitude) ?? 1,
      cutoff_hz:
        asNumber(wf?.cutoff_hz) ?? asNumber(raw?.frequency_hz) ?? 20e9,
      kind: "sinc_pulse",
      t0: asNumber(wf?.t0) ?? 5e-11,
    };
  } else if (rawWfKind === "pulse") {
    waveform = {
      kind: "pulse",
      t_off: asNumber(wf?.t_off) ?? 1e-9,
      t_on: asNumber(wf?.t_on) ?? 0,
    };
  } else if (rawWfKind === "piecewise_linear" && Array.isArray(wf?.points)) {
    waveform = {
      kind: "piecewise_linear",
      points: wf.points as number[][],
    };
  } else {
    waveform = {
      frequency_hz:
        asNumber(wf?.frequency_hz) ?? asNumber(raw?.frequency_hz) ?? 8e9,
      kind: "sinusoidal",
      offset: asNumber(wf?.offset) ?? 0,
      phase_rad: asNumber(wf?.phase_rad) ?? 0,
    };
  }

  const rawAct = asRecord(raw?.activation);
  const activation: SolvedDrive["activation"] =
    asString(rawAct?.kind) === "stage_ids" && Array.isArray(rawAct?.stage_ids)
      ? {
          kind: "stage_ids",
          stage_ids: (rawAct.stage_ids as unknown[])
            .map(asString)
            .filter((s): s is string => Boolean(s)),
        }
      : { kind: "all_time_evolution" };

  const rawBw = asRecord(raw?.bandwidth_declaration);
  const bwHz = asNumber(rawBw?.f_max_hz);

  return {
    activation,
    bandwidth_declaration: bwHz !== null ? { f_max_hz: bwHz } : null,
    id: asString(raw?.id) ?? fallbackId,
    name: asString(raw?.name) ?? asString(raw?.id) ?? fallbackId,
    peak_current_a: asNumber(raw?.peak_current_a) ?? 0.02,
    port_mode_id: asString(raw?.port_mode_id) ?? `${objectId}:port:common`,
    projection_ref: asString(raw?.projection_ref) ?? "proj-1",
    time_origin:
      asString(raw?.time_origin) === "absolute" ? "absolute" : "stage_local",
    waveform,
  };
}

export function toModelSolvedDriveDraft(
  d: AntennaDriveSpecDraft,
  fallbackProjectionRef: string,
  fallbackPortModeId: string,
): SolvedDriveDraft {
  let projectionRef = fallbackProjectionRef;
  let portModeId = fallbackPortModeId;
  try {
    const parsed = JSON.parse(d.bindingKey) as unknown;
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      projectionRef = parsed[0];
      portModeId = parsed[1];
    }
  } catch {
    // Keep fallback binding refs when custom string
  }
  return {
    activationKind: d.activationKind,
    bandwidthHz: d.bandwidthHz,
    cutoffHz: String(d.cutoffHz),
    frequencyHz: String(d.frequencyHz),
    name: d.name,
    offset: String(d.offset),
    peakCurrentA: String(d.peakCurrentA),
    phaseRad: String(d.phaseRad),
    piecewisePoints: d.piecewisePoints,
    portModeId,
    projectionRef,
    pulseOff: String(d.pulseOff),
    pulseOn: String(d.pulseOn),
    sincAmplitude: String(d.sincAmplitude),
    sincT0: String(d.sincT0),
    stageIds: d.stageIdsList.join(", "),
    timeOrigin: d.timeOrigin,
    waveformKind: d.waveformKind,
  };
}

export type SpectrumComponentKind =
  | "x"
  | "y"
  | "z"
  | "u"
  | "v"
  | "normal"
  | "vector_power"
  | "transverse";

export interface AntennaSpectrumSpecDraft {
  scaleMode: "linear" | "db";
  targetKey: string;
  rebindStageId: string;
  originM: string;
  axisU: string;
  axisV: string;
  component: SpectrumComponentKind;
  windowKind: "rectangular" | "hann" | "hamming" | "blackman";
  normalization: "integral_si" | "unitary_discrete";
  outsidePolicy: "error" | "zero";
  sampleCountU: number;
  sampleCountV: number;
  extentUM: number;
  extentVM: number;
}

export function decodeFloat64LEArray(
  result: BinaryResourceResult<ArrayBuffer> | null | undefined,
): number[] | null {
  if (!result || result.status !== "ready") return null;
  const buf = result.data;
  if (!buf || buf.byteLength % 8 !== 0) return null;
  const view = new DataView(buf);
  const out = new Array<number>(buf.byteLength / 8);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getFloat64(i * 8, true);
  }
  return out;
}

export interface AntennaRegionalMaskDraft {
  enabled: boolean;
  spatialProfileKind:
    | "uniform_mask"
    | "spatial_sinc_grating"
    | "gaussian_k_source";
  waveformKind: "constant" | "sinc_pulse" | "sinusoidal";
  peakFieldT: number;
  frequencyHz: number;
  sinusoidalPhaseRad: number;
  sinusoidalOffset: number;
  sincAmplitude: number;
  sincCutoffHz: number;
  sincT0: number;
  polarization: readonly [number, number, number];
  centerWavevectorRadPerUm: number;
  wavevectorSpreadRadPerUm: number;
}

export function extractMaskDrivesFromScene(sceneRec: JsonRecord | null): JsonRecord[] {
  const fromFieldDrives = asRecord(sceneRec?.field_drives)?.mask_drives;
  const fromMaskFieldDrives = sceneRec?.mask_field_drives;
  const rawList = Array.isArray(fromMaskFieldDrives)
    ? fromMaskFieldDrives
    : Array.isArray(asRecord(fromMaskFieldDrives)?.drives)
      ? (asRecord(fromMaskFieldDrives)?.drives as unknown[])
      : Array.isArray(fromFieldDrives)
        ? fromFieldDrives
        : [];
  return rawList
    .map(asRecord)
    .filter((item): item is JsonRecord => item !== null);
}

export function extractRegionalFieldDrivesFromScene(
  sceneRec: JsonRecord | null,
): JsonRecord[] {
  const rawFieldDrives = sceneRec?.field_drives;
  const rawList = Array.isArray(asRecord(rawFieldDrives)?.drives)
    ? (asRecord(rawFieldDrives)?.drives as unknown[])
    : Array.isArray(rawFieldDrives)
      ? rawFieldDrives
      : [];
  return rawList
    .map(asRecord)
    .filter((item): item is JsonRecord => item !== null);
}

export function extractMaskTermParameter(
  maskDrive: JsonRecord | null,
  paramName: string,
): number | null {
  const terms = Array.isArray(maskDrive?.terms) ? maskDrive.terms : [];
  const firstTerm = asRecord(terms[0]);
  const fn = asRecord(asRecord(firstTerm?.mask)?.function);
  const params = Array.isArray(fn?.parameters) ? fn.parameters : [];
  const found = params
    .map(asRecord)
    .find((p) => asString(p?.name) === paramName);
  return asNumber(found?.value);
}

export function buildPolarizedGaussianMaskTerms(
  synthesizedTerms: readonly MaskTermResource[],
  draft: AntennaRegionalMaskDraft,
  wavelengthM: number,
  sigmaXM: number,
): MaskTermResource[] {
  const [px, py, pz] = draft.polarization;
  const isDefaultHalbach =
    px === 0 && py === 1 && pz === 0 && synthesizedTerms.length > 0;
  if (isDefaultHalbach && synthesizedTerms.length > 0) {
    // Still attach px, py, pz parameters if customized, or preserve standard Halbach
  }
  const baseTerm = synthesizedTerms[0];
  const baseMaskFn =
    baseTerm?.mask.kind === "function" ? baseTerm.mask.function : null;
  const baseParams = (baseMaskFn?.parameters ?? []).filter(
    (p) => !["px", "py", "pz"].includes(p.name),
  );
  const parameters = [
    ...(baseParams.length > 0
      ? baseParams
      : [
          { name: "amplitude", value: draft.peakFieldT },
          { name: "wavelength", value: wavelengthM },
          { name: "sigma_x", value: sigmaXM },
        ]),
    { name: "px", value: px },
    { name: "py", value: py },
    { name: "pz", value: pz },
  ];
  const locals = baseMaskFn?.locals ?? [
    { expression: "2 * pi / wavelength", name: "k" },
    { expression: "exp(-x ** 2 / (2 * sigma_x ** 2))", name: "g" },
  ];
  return [
    {
      mask: {
        function: {
          expression_version: "field_expr.v1",
          locals,
          name: baseMaskFn?.name ?? "gaussian_k_source_polarized",
          outputs: [
            "px * amplitude * g * sin(k * x)",
            "py * amplitude * g * sin(k * x)",
            "pz * amplitude * g * sin(k * x)",
          ],
          parameters,
        },
        kind: "function",
      },
      name: baseTerm?.name ?? "gaussian_k_term",
      origin: null,
      time: baseTerm?.time ?? {
        expression_version: "field_expr.v1",
        name: "cw_sine",
        outputs: ["sin(2 * pi * frequency * t)"],
        parameters: [{ name: "frequency", value: draft.frequencyHz }],
      },
    },
  ];
}
