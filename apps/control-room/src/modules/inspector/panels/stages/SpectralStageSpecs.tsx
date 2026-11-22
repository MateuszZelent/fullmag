"use client";

import {
  Activity,
  Compass,
  FileOutput,
  Gauge,
  Magnet,
  Play,
  Shield,
  Waves,
  Workflow,
} from "lucide-react";
import { useContext, useMemo, useState } from "react";

import type {
  FrequencyDomainManifestResource,
  JsonValue,
  MeshPeriodicPairsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { parseQuantityInput } from "@/kernel/authoring/object-edit/quantityInput";
import { KernelContext } from "@/kernel/KernelContext";
import {
  useFrequencyDomainManifestResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import type { ActiveLaneCapabilitySnapshot } from "@/kernel/resources/useActiveLaneCapabilities";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../template";
import {
  buildFrequencyDomainCalculationModeRows,
  periodicStatusView,
  type FrequencyDomainCalculationModeRow,
} from "../frequencyDomainInspectorModel";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import {
  createDefaultStudyStageDraft,
  readStageTextureAssignments,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../StudyStageAuthoringModel";
import {
  ANGLE_RAD_UNITS_SI,
  FIELD_APM_UNITS_SI,
  FIELD_TESLA_UNITS_SI,
  FREQUENCY_UNITS_SI,
  MU0_SI,
  PipelineStrip,
  WAVEVECTOR_UNITS_SI,
  type PipelineStripStep,
} from "../study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../study/useConnectedStudyAuthoring";
import {
  hasKernelResourceRuntime,
  serializeStageEnabled,
  StageInitialStateRadixControl,
  StageLiveTelemetryPanel,
  StageSpecHost,
  StageTextureOverridesRow,
  StudyStageTelemetryBridge,
} from "./StageSharedControls";

export const SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS = [
  "auto",
  "dense_reference",
  "cpu_sparse_direct",
  "full_coupled_field_split",
  "schur_reduced",
  "modal_reduced",
  "gpu_operator_host_krylov",
  "gpu_device_krylov",
] as const;

export type FrequencyResponseSolverMethod =
  (typeof SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS)[number];

export const DEFAULT_CANONICAL_K_PATH = "Gamma:0,0,0; X:2.5e7,0,0 | samples=31";

/**
 * Parses a comma- or semicolon-separated list of frequencies with optional SI
 * unit suffixes (e.g. `"2.5GHz, 5 GHz, 10GHz"`) into finite positive Hz numbers
 * via `parseQuantityInput(..., "frequency")` — never bare `Number(entry)`.
 */
export function parseExplicitFrequencySweepHz(raw: string): {
  frequenciesHz: number[];
  error: string | null;
} {
  const tokens = raw
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return {
      frequenciesHz: [],
      error: "Enter at least one positive frequency (for example 2.5GHz, 10GHz).",
    };
  }
  const values: number[] = [];
  for (const token of tokens) {
    const compactNormalized = token.replace(
      /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-zA-Z]+)$/,
      "$1 $2",
    );
    const parsed = parseQuantityInput(compactNormalized, "frequency", "Hz");
    if (
      parsed.parseStatus !== "valid" ||
      parsed.parsedSI === null ||
      !Number.isFinite(parsed.parsedSI) ||
      parsed.parsedSI <= 0
    ) {
      return {
        frequenciesHz: [],
        error: `Invalid frequency "${token}". Use Hz, MHz, GHz, or THz (for example 10GHz).`,
      };
    }
    values.push(parsed.parsedSI);
  }
  return { frequenciesHz: values, error: null };
}

function stageBreadcrumbs(stageTitle: string): readonly {
  id: string;
  label: string;
  selection?: Omit<Selection, "moduleSource">;
}[] {
  return [
    {
      id: "study",
      label: "Study",
      selection: {
        kind: "study.root",
        label: "Study",
        nodeId: "model:study",
        objectId: null,
        ref: { kind: "study.root", nodeId: "model:study", type: "study" },
      },
    },
    {
      id: "stages",
      label: "Stages",
      selection: {
        kind: "study.stages",
        label: "Stages",
        nodeId: "model:study:stages",
        objectId: null,
        ref: { kind: "study.stages", nodeId: "model:study:stages", type: "study" },
      },
    },
    { id: "current", label: stageTitle },
  ];
}

export interface SpectralStageTestSnapshot {
  resolvedDeviceLabel?: string;
  precision?: "double" | "single";
  hasPrecedingRelax?: boolean;
}

interface SpectralValidationContext {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  backend: string;
  demagEnabled: boolean;
  device: string;
  mode: string;
  precision: string;
}

interface EigenmodesStageSpecDraft {
  stageId: string;
  stageEnabled: boolean;
  calculationMode: "fmr_modal" | "free_modes" | "dispersion_modal";
  equilibriumSource: "relax" | "provided" | "artifact";
  equilibriumArtifact: string;
  enableBiasSweep: boolean;
  biasSampleFieldTesla: readonly [number, number, number];
  biasFieldSamplesApmText: string;
  biasEquilibriumPolicy: "relax_each" | "continuation";
  biasContinuationSeed: "initial_state" | "previous_accepted_equilibrium";
  operator: "linearized_llg" | "full_2x2";
  includeDemag: boolean;
  dampingPolicy: "ignore" | "include";
  lateralBc: "free" | "pinned" | "periodic_1d" | "periodic_2d" | "custom";
  customBcText: string;
  magnetostaticBc: "open" | "periodic_airbox_k0" | "floquet_airbox";
  kSamplingMode: "none" | "single_k" | "k_path" | "k_grid";
  kVectorRadPerM: readonly [number, number, number];
  kPathHighSymmetry: string;
  kSamplingJson: string;
  kSamplesPerSegment: number;
  modeCount: number;
  spectralTarget: "lowest" | "nearest" | "frequency_window";
  targetFrequencyHz: number;
  windowMinHz: number;
  windowMaxHz: number;
  maxKrylovIterations: number;
  normalization: "unit_l2" | "unit_max_amplitude";
  stageMagnetizationAssignments: JsonValue | undefined;
  resolvedDeviceLabel: string;
  precision: "double" | "single";
  hasPrecedingRelax: boolean;
}

function parseSpectralVec3(
  raw: string,
  fallback: readonly [number, number, number],
): readonly [number, number, number] {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const parts = trimmed
    .replace(/^\[|\]$/g, "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((item) => Number(item.trim()));
  if (parts.length === 3 && parts.every(Number.isFinite)) {
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  return fallback;
}

function parseFirstBiasSampleTesla(
  samplesApmText: string | undefined,
  fallbackTesla: readonly [number, number, number],
): readonly [number, number, number] {
  const firstLine = (samplesApmText ?? "")
    .split(/\n|;/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallbackTesla;
  const apmVec = parseSpectralVec3(firstLine, [Number.NaN, Number.NaN, Number.NaN]);
  if (apmVec.every(Number.isFinite)) {
    return [
      Number((apmVec[0] * MU0_SI).toPrecision(7)),
      Number((apmVec[1] * MU0_SI).toPrecision(7)),
      Number((apmVec[2] * MU0_SI).toPrecision(7)),
    ];
  }
  return fallbackTesla;
}

function formatBiasFieldApmLine(
  fieldTesla: readonly [number, number, number],
): string {
  return fieldTesla
    .map((b) => Number((b / MU0_SI).toPrecision(7)))
    .join(", ");
}

function syncFirstBiasLineApm(
  existingText: string,
  fieldTesla: readonly [number, number, number],
): string {
  const apmLine = formatBiasFieldApmLine(fieldTesla);
  const lines = existingText.split("\n");
  const firstNonEmptyIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx < 0) {
    return apmLine;
  }
  const existingFirst = lines[firstNonEmptyIdx]!.trim();
  const bracketed = existingFirst.startsWith("[") && existingFirst.endsWith("]");
  const updatedLines = [...lines];
  updatedLines[firstNonEmptyIdx] = bracketed ? `[${apmLine}]` : apmLine;
  return updatedLines.join("\n");
}

export function parseKPathSamplesPerSegment(kPath: string, fallback = 31): number {
  const match = kPath.match(/\|\s*samples\s*=\s*(\d+)/i);
  if (!match) return fallback;
  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : fallback;
}

export function formatKPathWithSamples(
  kPath: string,
  samplesPerSegment: number,
): string {
  const trimmed = kPath.trim();
  const safeSamples = Math.max(2, Math.min(512, Math.round(samplesPerSegment || 31)));
  if (!trimmed) {
    return `Gamma:0,0,0; X:2.5e7,0,0 | samples=${safeSamples}`;
  }
  if (/\|\s*samples\s*=/i.test(trimmed)) {
    return trimmed.replace(
      /\|\s*samples\s*=\s*(\d+)(?!\s*,)/i,
      `| samples=${safeSamples}`,
    );
  }
  return `${trimmed} | samples=${safeSamples}`;
}

function parseKGridMetadata(
  kSamplingJson: string | undefined,
): { countX: number; maxRadPerM: number } {
  if (!kSamplingJson?.trim()) {
    return { countX: 64, maxRadPerM: 25e6 };
  }
  try {
    const parsed: unknown = JSON.parse(kSamplingJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const rawCount = rec.nx ?? rec.points ?? rec.count_x ?? rec.count;
      const rawMax =
        rec.k_max_rad_per_m ??
        rec.kx_max_rad_per_m ??
        rec.max_k_rad_per_m ??
        rec.k_max;
      return {
        countX:
          typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 2
            ? rawCount
            : 64,
        maxRadPerM:
          typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0
            ? rawMax
            : 25e6,
      };
    }
  } catch {
    // Keep defaults when custom JSON has not finished editing
  }
  return { countX: 64, maxRadPerM: 25e6 };
}

function buildKGridSamplingJson(
  existingJson: string,
  countX: number,
  maxRadPerM: number,
): string {
  const nx = Math.max(2, Math.round(countX || 64));
  const kMax = Number.isFinite(maxRadPerM) && maxRadPerM > 0 ? maxRadPerM : 25e6;
  if (existingJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(existingJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          kind:
            typeof (parsed as Record<string, unknown>).kind === "string"
              ? (parsed as Record<string, unknown>).kind
              : "grid",
          nx,
          k_max_rad_per_m: kMax,
        });
      }
    } catch {
      return existingJson;
    }
  }
  return JSON.stringify({
    kind: "grid",
    nx,
    k_max_rad_per_m: kMax,
  });
}

function buildSweepFrequenciesCsv(
  mode: "range_lin" | "range_log",
  minHz: number,
  maxHz: number,
  count: number,
): string {
  const n = Math.max(2, Math.min(2000, Math.round(count)));
  const lo = Math.max(1, minHz);
  const hi = Math.max(lo * 1.001, maxHz);
  const values: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const val =
      mode === "range_log"
        ? lo * Math.pow(hi / lo, t)
        : lo + t * (hi - lo);
    values.push(Number(val.toPrecision(8)));
  }
  return values.join(", ");
}

function sanitizeCapabilityStatus(raw: string): string {
  return raw.replace(/\bunknown\b/gi, "pending session check");
}

function resolveInitialEigenmodesTab(
  selectionKind: string | null | undefined,
): string | undefined {
  const suffix = selectionKind?.split(".").at(-1);
  if (
    suffix === "operator" ||
    suffix === "boundary" ||
    suffix === "periodic_pairs" ||
    suffix === "k_path"
  ) {
    return "physics";
  }
  if (suffix === "solver" || suffix === "outputs" || suffix === "diagnostics") {
    return "solver";
  }
  return undefined;
}

function resolveInitialFrequencyResponseTab(
  selectionKind: string | null | undefined,
): string | undefined {
  const suffix = selectionKind?.split(".").at(-1);
  if (
    suffix === "excitation" ||
    suffix === "sweep" ||
    suffix === "boundary" ||
    suffix === "periodic_pairs" ||
    suffix === "k_grid"
  ) {
    return "excitation";
  }
  if (
    suffix === "operator" ||
    suffix === "solver" ||
    suffix === "outputs" ||
    suffix === "diagnostics"
  ) {
    return "solver";
  }
  return undefined;
}

function toEigenmodesStudyStageDraft(
  draft: EigenmodesStageSpecDraft,
  base?: StudyStageDraft,
): StudyStageDraft {
  const seed = base ?? createDefaultStudyStageDraft("eigenmodes", 0);
  const allowK =
    draft.calculationMode === "dispersion_modal" ||
    draft.calculationMode === "free_modes";
  const biasSamples = draft.enableBiasSweep
    ? draft.biasFieldSamplesApmText.trim() ||
      formatBiasFieldApmLine(draft.biasSampleFieldTesla)
    : "";
  const requiresExplicitGammaK0 =
    draft.enableBiasSweep || draft.magnetostaticBc === "periodic_airbox_k0";

  return {
    ...seed,
    kind: "eigenmodes",
    stageId: draft.stageId,
    stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
    calculationMode: draft.calculationMode,
    equilibriumSource: draft.equilibriumSource,
    equilibriumArtifact:
      draft.equilibriumSource === "artifact" ? draft.equilibriumArtifact : "",
    biasFieldSamplesApm: biasSamples,
    biasFieldEquilibriumPolicy: draft.biasEquilibriumPolicy,
    biasFieldContinuationSeed: draft.biasContinuationSeed,
    includeDemag: draft.includeDemag,
    dampingPolicy: draft.dampingPolicy,
    bc: draft.lateralBc === "custom" ? draft.customBcText : draft.lateralBc,
    magnetostaticBc: draft.magnetostaticBc,
    operator: draft.operator,
    kVector:
      allowK && draft.kSamplingMode === "single_k"
        ? draft.kVectorRadPerM.join(", ")
        : requiresExplicitGammaK0
          ? "0, 0, 0"
          : "",
    kPath:
      allowK && draft.kSamplingMode === "k_path"
        ? formatKPathWithSamples(draft.kPathHighSymmetry, draft.kSamplesPerSegment)
        : "",
    kSampling:
      allowK && draft.kSamplingMode === "k_grid"
        ? draft.kSamplingJson.trim()
        : "",
    count: String(draft.modeCount),
    maxSteps: String(draft.maxKrylovIterations),
    target: draft.spectralTarget,
    targetFrequency:
      draft.spectralTarget === "nearest" ? String(draft.targetFrequencyHz) : "",
    frequencyMin:
      draft.spectralTarget === "frequency_window"
        ? String(draft.windowMinHz)
        : "",
    frequencyMax:
      draft.spectralTarget === "frequency_window"
        ? String(draft.windowMaxHz)
        : "",
    normalization: draft.normalization,
    stageMagnetizationAssignments: draft.stageMagnetizationAssignments,
  };
}

function summarizePeriodicPairsResource(
  periodicPairs: MeshPeriodicPairsResource | null | undefined,
): string {
  if (!periodicPairs) {
    return "Shared-domain periodic_pairs.v1 not loaded in current session";
  }
  const view = periodicStatusView(periodicPairs.status);
  const statusLabel =
    view.label === "unavailable" ? "not materialized" : view.label;
  const pairCount = Array.isArray(periodicPairs.pairs)
    ? periodicPairs.pairs.length
    : 0;
  return `${statusLabel} (${pairCount} boundary pair${pairCount === 1 ? "" : "s"})`;
}

export function EigenmodesStageInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: SpectralStageTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedEigenmodesStageInspectorPanel selection={selection} />;
  }
  return (
    <EigenmodesStageInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedEigenmodesStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitSelectedStageDraft,
    commitStudyMetadata,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hasResources = hasKernelResourceRuntime(kernel);
  const canLoadManifest =
    hasResources &&
    Boolean(runtimeStatus?.domain && runtimeStatus?.resources) &&
    Boolean(kernel?.api?.analysis?.frequencyDomain?.manifestV1);
  const canLoadPeriodicPairs =
    hasResources && Boolean(kernel?.api?.meshing?.periodicPairs);

  const hydratedBaseline = useMemo<EigenmodesStageSpecDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "eigenmodes" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `eigen_${selectedStageIndex + 1}`);
    const precision: "double" | "single" =
      globalDraft.requestedPrecision === "single" ? "single" : "double";
    const hasPrecedingRelax = stageDrafts
      .slice(0, Math.max(0, selectedStageIndex))
      .some((s) => s.kind === "relax");
    const knownBc =
      d.bc === "free" ||
      d.bc === "pinned" ||
      d.bc === "periodic_1d" ||
      d.bc === "periodic_2d" ||
      !d.bc?.trim();
    const calculationMode: EigenmodesStageSpecDraft["calculationMode"] =
      d.calculationMode === "free_modes"
        ? "free_modes"
        : d.calculationMode === "dispersion_modal"
          ? "dispersion_modal"
          : "fmr_modal";
    const kPathRaw = d.kPath?.trim() ?? "";
    const kSamplingMode: EigenmodesStageSpecDraft["kSamplingMode"] = kPathRaw
      ? "k_path"
      : d.kSampling?.trim()
        ? "k_grid"
        : d.kVector?.trim()
          ? "single_k"
          : calculationMode === "dispersion_modal"
            ? "k_path"
            : "none";
    const resolvedKPath = kPathRaw || DEFAULT_CANONICAL_K_PATH;

    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      calculationMode,
      equilibriumSource:
        d.equilibriumSource === "provided"
          ? "provided"
          : d.equilibriumSource === "artifact"
            ? "artifact"
            : "relax",
      equilibriumArtifact: d.equilibriumArtifact ?? "",
      enableBiasSweep: Boolean(d.biasFieldSamplesApm?.trim()),
      biasSampleFieldTesla: parseFirstBiasSampleTesla(
        d.biasFieldSamplesApm,
        [0, 0, 0.05],
      ),
      biasFieldSamplesApmText: d.biasFieldSamplesApm ?? "",
      biasEquilibriumPolicy:
        d.biasFieldEquilibriumPolicy === "continuation"
          ? "continuation"
          : "relax_each",
      biasContinuationSeed:
        d.biasFieldContinuationSeed === "previous_accepted_equilibrium"
          ? "previous_accepted_equilibrium"
          : "initial_state",
      operator: d.operator === "full_2x2" ? "full_2x2" : "linearized_llg",
      includeDemag: d.includeDemag ?? true,
      dampingPolicy: d.dampingPolicy === "include" ? "include" : "ignore",
      lateralBc: knownBc
        ? ((d.bc as EigenmodesStageSpecDraft["lateralBc"] | undefined) || "free")
        : "custom",
      customBcText: knownBc ? "" : d.bc ?? "",
      magnetostaticBc:
        d.magnetostaticBc === "periodic_airbox_k0" ||
        d.magnetostaticBc === "floquet_airbox"
          ? d.magnetostaticBc
          : "open",
      kSamplingMode,
      kVectorRadPerM: parseSpectralVec3(d.kVector ?? "", [0, 0, 0]),
      kPathHighSymmetry: resolvedKPath,
      kSamplingJson: d.kSampling ?? "",
      kSamplesPerSegment: parseKPathSamplesPerSegment(resolvedKPath, 31),
      modeCount: Number(d.count) || 10,
      spectralTarget:
        d.target === "nearest" || d.target === "near_frequency"
          ? "nearest"
          : d.target === "frequency_window"
            ? "frequency_window"
            : "lowest",
      targetFrequencyHz: Number(d.targetFrequency) || 8e9,
      windowMinHz: Number(d.frequencyMin) || 2e9,
      windowMaxHz: Number(d.frequencyMax) || 20e9,
      maxKrylovIterations: Number(d.maxSteps) || 500,
      normalization:
        d.normalization === "unit_l2" ? "unit_l2" : "unit_max_amplitude",
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
      resolvedDeviceLabel: `Requested ${globalDraft.requestedDevice || "auto"}`,
      precision,
      hasPrecedingRelax,
    };
  }, [
    globalDraft.requestedDevice,
    globalDraft.requestedPrecision,
    selectedStageDraft,
    selectedStageIndex,
    selection.ref,
    stageDrafts,
  ]);

  const validationContext = useMemo<SpectralValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <SpectralCapabilitiesLoader
          canLoadManifest={canLoadManifest}
          canLoadPeriodicPairs={canLoadPeriodicPairs}
        >
          {({ manifest, periodicPairs }) => (
            <EigenmodesStageInspectorPanelView
              hydratedBaseline={hydratedBaseline}
              lastAuthoringError={lastAuthoringError}
              manifest={manifest}
              periodicPairs={periodicPairs}
              pipelineNodeId={selectedStageDraft?.pipelineNodeId}
              pipelineStripSteps={pipelineStripSteps}
              sceneData={sceneData}
              sceneRevision={sceneRevision}
              selection={selection}
              stageModel={selectedStageModel}
              validationContext={validationContext}
              onCommitStage={(draft) =>
                commitSelectedStageDraft(
                  (base) => toEigenmodesStudyStageDraft(draft, base),
                  "eigenmodes",
                )
              }
              onRunStage={(stageId, initialChoice) =>
                executeSelectedStage(stageId, initialChoice, "eigenmodes")
              }
              onSwitchPrecisionToDouble={() =>
                commitStudyMetadata({ requested_precision: "double" })
              }
            />
          )}
        </SpectralCapabilitiesLoader>
      )}
    </StudyStageTelemetryBridge>
  );
}

function SpectralCapabilitiesLoader({
  canLoadManifest,
  canLoadPeriodicPairs,
  children,
}: {
  canLoadManifest: boolean;
  canLoadPeriodicPairs: boolean;
  children: (resources: {
    manifest: FrequencyDomainManifestResource | null;
    periodicPairs: MeshPeriodicPairsResource | null;
  }) => React.ReactNode;
}) {
  if (canLoadManifest && canLoadPeriodicPairs) {
    return <SpectralBothResources>{children}</SpectralBothResources>;
  }
  if (canLoadManifest) {
    return <SpectralManifestOnly>{children}</SpectralManifestOnly>;
  }
  if (canLoadPeriodicPairs) {
    return <SpectralPeriodicOnly>{children}</SpectralPeriodicOnly>;
  }
  return <>{children({ manifest: null, periodicPairs: null })}</>;
}

function SpectralBothResources({
  children,
}: {
  children: (resources: {
    manifest: FrequencyDomainManifestResource | null;
    periodicPairs: MeshPeriodicPairsResource | null;
  }) => React.ReactNode;
}) {
  const manifest = useFrequencyDomainManifestResource();
  const periodic = useMeshPeriodicPairsResource();
  return (
    <>
      {children({
        manifest: manifest.data ?? null,
        periodicPairs: periodic.data ?? null,
      })}
    </>
  );
}

function SpectralManifestOnly({
  children,
}: {
  children: (resources: {
    manifest: FrequencyDomainManifestResource | null;
    periodicPairs: MeshPeriodicPairsResource | null;
  }) => React.ReactNode;
}) {
  const manifest = useFrequencyDomainManifestResource();
  return <>{children({ manifest: manifest.data ?? null, periodicPairs: null })}</>;
}

function SpectralPeriodicOnly({
  children,
}: {
  children: (resources: {
    manifest: FrequencyDomainManifestResource | null;
    periodicPairs: MeshPeriodicPairsResource | null;
  }) => React.ReactNode;
}) {
  const periodic = useMeshPeriodicPairsResource();
  return <>{children({ manifest: null, periodicPairs: periodic.data ?? null })}</>;
}

function EigenmodesStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  manifest = null,
  onCommitStage,
  onRunStage,
  onSwitchPrecisionToDouble,
  periodicPairs = null,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  testSnapshot,
  validationContext,
}: InspectorPanelProps & {
  hydratedBaseline?: EigenmodesStageSpecDraft;
  lastAuthoringError?: string | null;
  manifest?: FrequencyDomainManifestResource | null;
  onCommitStage?: (draft: EigenmodesStageSpecDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  onSwitchPrecisionToDouble?: () => Promise<boolean>;
  periodicPairs?: MeshPeriodicPairsResource | null;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  testSnapshot?: SpectralStageTestSnapshot;
  validationContext?: SpectralValidationContext;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const stageIndex =
    selection.ref?.type === "study-stage" && typeof selection.ref.stageIndex === "number"
      ? selection.ref.stageIndex
      : 1;
  const stageId =
    hydratedBaseline?.stageId ??
    (selection.ref?.type === "study-stage" && selection.ref.stageId
      ? selection.ref.stageId
      : `eigen_${stageIndex + 1}`);

  const fallbackBaseline = useMemo<EigenmodesStageSpecDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      calculationMode: "fmr_modal",
      equilibriumSource: "relax",
      equilibriumArtifact: "",
      enableBiasSweep: false,
      biasSampleFieldTesla: [0, 0, 0.05],
      biasFieldSamplesApmText: "",
      biasEquilibriumPolicy: "relax_each",
      biasContinuationSeed: "initial_state",
      operator: "linearized_llg",
      includeDemag: true,
      dampingPolicy: "ignore",
      lateralBc: "free",
      customBcText: "",
      magnetostaticBc: "open",
      kSamplingMode: "k_path",
      kVectorRadPerM: [0, 0, 0],
      kPathHighSymmetry: DEFAULT_CANONICAL_K_PATH,
      kSamplingJson: "",
      kSamplesPerSegment: 31,
      modeCount: 10,
      spectralTarget: "lowest",
      targetFrequencyHz: 8e9,
      windowMinHz: 2e9,
      windowMaxHz: 20e9,
      maxKrylovIterations: 500,
      normalization: "unit_max_amplitude",
      stageMagnetizationAssignments: undefined,
      resolvedDeviceLabel: testSnapshot?.resolvedDeviceLabel ?? "Auto → GPU (CUDA)",
      precision: testSnapshot?.precision ?? "double",
      hasPrecedingRelax: testSnapshot?.hasPrecedingRelax ?? true,
    }),
    [
      stageId,
      testSnapshot?.hasPrecedingRelax,
      testSnapshot?.precision,
      testSnapshot?.resolvedDeviceLabel,
    ],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const calculationModeRows = useMemo<FrequencyDomainCalculationModeRow[]>(
    () =>
      buildFrequencyDomainCalculationModeRows(
        manifest?.capabilities,
        manifest?.floquet_nonzero_k_response_supported,
      )
        .filter((row) =>
          ["fmr_modal", "free_modes", "dispersion_modal"].includes(row.mode),
        )
        .map((row) => ({
          ...row,
          capabilityStatus: sanitizeCapabilityStatus(row.capabilityStatus),
        })),
    [manifest?.capabilities, manifest?.floquet_nonzero_k_response_supported],
  );

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            {
              id: "relax_1",
              index: 0,
              kind: "study.stage.relax",
              label: "Relax",
              status: "completed",
            },
            {
              id: stageId,
              index: stageIndex,
              kind: "study.stage.eigenmodes",
              label: "Eigenmodes",
              status: "ready",
            },
          ],
    [pipelineStripSteps, stageId, stageIndex],
  );

  const titleLabel = `Eigenmodes ${stageIndex + 1}`;
  const initialModeTabId = resolveInitialEigenmodesTab(selection.kind);

  const spec = useMemo<InspectorSpec<EigenmodesStageSpecDraft>>(
    () => ({
      id: "study.stage.eigenmodes",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Eigenmodes solve queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Linearized modal stage",
        entityId: stageId,
        statePill: (d) =>
          d.precision !== "double"
            ? { tone: "err", label: "Requires FP64" }
            : !d.hasPrecedingRelax && d.equilibriumSource === "relax"
              ? { tone: "warn", label: "Equilibrium missing" }
              : { tone: "ok", label: "Ready" },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "mode",
          label: "Mode",
          value:
            d.calculationMode === "fmr_modal"
              ? "FMR k = 0"
              : d.calculationMode === "dispersion_modal"
                ? "Dispersion k-Path"
                : "Free modes",
        },
        { id: "modes", label: "Modes", value: `N = ${d.modeCount}` },
        {
          id: "target",
          label: "Target",
          value:
            d.spectralTarget === "nearest"
              ? `Shift ${(d.targetFrequencyHz / 1e9).toFixed(2)} GHz`
              : d.spectralTarget === "frequency_window"
                ? "Band window"
                : "Lowest",
        },
        { id: "device", label: "Device", value: d.resolvedDeviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup & Equilibrium" },
        { id: "physics", label: "Physics & Wavevector" },
        { id: "solver", label: "Solver & Outputs" },
      ],
      notices: (d): readonly InspectorNotice<EigenmodesStageSpecDraft>[] => {
        const list: InspectorNotice<EigenmodesStageSpecDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.precision !== "double") {
          list.push({
            id: "fp64-required",
            tone: "err",
            text: "Linearized modal eigensolvers require double precision (FP64).",
            quickFix: {
              label: "Switch Study Precision to FP64",
              onApply: async (ctx) => {
                ctx.setField("precision", "double");
                if (onSwitchPrecisionToDouble) {
                  await onSwitchPrecisionToDouble();
                }
              },
            },
          });
        }
        if (d.equilibriumSource === "relax" && !d.hasPrecedingRelax) {
          list.push({
            id: "missing-relax",
            tone: "warn",
            text: "Equilibrium source references a preceding Relax stage, which is not yet in the pipeline.",
            quickFix: {
              label: "Use current runtime state",
              onApply: (ctx) => ctx.setField("equilibriumSource", "provided"),
            },
          });
        }
        const stageDraft = toEigenmodesStudyStageDraft(d);
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          if (list.some((existing) => existing.text === issue.message)) continue;
          list.push({
            id: `stage-validation-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline-mode",
          title: "Pipeline & Calculation Mode",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={stageIndex}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
            {
              key: "calculationMode",
              label: "Calculation mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "fmr_modal", label: "FMR k = 0" },
                { value: "free_modes", label: "Free modes" },
                { value: "dispersion_modal", label: "Dispersion k-Path" },
              ],
            },
            {
              type: "table",
              label: "Calculation mode capabilities",
              wide: true,
              rowKey: (row) => (row as FrequencyDomainCalculationModeRow).mode,
              rows: () => calculationModeRows,
              columns: [
                {
                  id: "mode",
                  header: "Mode",
                  mono: true,
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).mode,
                },
                {
                  id: "boundary",
                  header: "Boundary",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).boundaryPreset,
                },
                {
                  id: "k",
                  header: "Wavevector",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).kRequirement,
                },
                {
                  id: "cap",
                  header: "Capability",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).capabilityStatus,
                },
              ],
            },
          ],
        },
        {
          id: "equilibrium",
          title: "Equilibrium & Bias Sweep",
          icon: Compass,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "equilibriumSource",
              label: "Equilibrium source",
              symbol: (
                <>
                  m<sub>eq</sub>
                </>
              ),
              type: "select",
              structural: true,
              options: [
                { value: "relax", label: "Preceding Relax stage" },
                { value: "provided", label: "Current runtime state" },
                { value: "artifact", label: "Named state artifact" },
              ],
            },
            {
              key: "equilibriumArtifact",
              label: "Equilibrium artifact",
              type: "text",
              mono: true,
              showWhen: (d) => d.equilibriumSource === "artifact",
              validate: (val) => (!val.trim() ? "Artifact name is required." : null),
            },
            {
              type: "custom",
              label: "Saved state seed",
              wide: true,
              render: ({ draft }) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    label: "Texture overrides",
                    wide: true,
                    render: ({
                      draft,
                      patchDraft,
                    }: {
                      draft: EigenmodesStageSpecDraft;
                      patchDraft: (p: Partial<EigenmodesStageSpecDraft>) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={draft.stageMagnetizationAssignments}
                        onChange={(stageMagnetizationAssignments) =>
                          patchDraft({ stageMagnetizationAssignments })
                        }
                      />
                    ),
                  },
                ]
              : []),
            {
              key: "enableBiasSweep",
              label: "Enable bias field sweep (Kittel)",
              type: "switch",
              structural: true,
            },
            {
              key: "biasSampleFieldTesla",
              label: "Primary bias sample",
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
              showWhen: (d) => d.enableBiasSweep,
            },
            {
              key: "biasFieldSamplesApmText",
              label: "Bias sweep samples (A/m, one [Hx, Hy, Hz] per line)",
              type: "expression",
              multiline: true,
              placeholder: "0, 0, 39788.7\n0, 0, 79577.5",
              showWhen: (d) => d.enableBiasSweep,
            },
            {
              key: "biasEquilibriumPolicy",
              label: "Equilibrium policy",
              type: "segmented",
              showWhen: (d) => d.enableBiasSweep,
              options: [
                { value: "relax_each", label: "Relax each field" },
                { value: "continuation", label: "Continuation" },
              ],
            },
            {
              key: "biasContinuationSeed",
              label: "Continuation seed",
              type: "select",
              showWhen: (d) => d.enableBiasSweep,
              options: [
                { value: "initial_state", label: "Initial state" },
                {
                  value: "previous_accepted_equilibrium",
                  label: "Previous accepted equilibrium",
                },
              ],
            },
          ],
        },
        {
          id: "operator-boundary",
          title: "Linearized Operator & Boundary",
          icon: Shield,
          modeTabId: "physics",
          defaultOpen: true,
          rows: [
            {
              key: "operator",
              label: "Linearized operator",
              symbol: "ℒ",
              type: "select",
              options: [
                { value: "linearized_llg", label: "Standard tangent-space LLG" },
                { value: "full_2x2", label: "Full 2×2 transverse complex" },
              ],
            },
            {
              key: "includeDemag",
              label: "Include demagnetization",
              type: "switch",
            },
            {
              key: "dampingPolicy",
              label: "Damping policy",
              symbol: "α",
              type: "segmented",
              options: [
                { value: "ignore", label: "Conservative (α = 0)" },
                { value: "include", label: "Complex damped (linewidth)" },
              ],
            },
            {
              key: "lateralBc",
              label: "Lateral boundary condition",
              type: "select",
              structural: true,
              options: [
                { value: "free", label: "Open / Free spins" },
                { value: "pinned", label: "Pinned boundary (∂Ω = 0)" },
                { value: "periodic_1d", label: "1D Periodic (waveguide)" },
                { value: "periodic_2d", label: "2D Bloch-Periodic film" },
                { value: "custom", label: "Custom / JSON BC" },
              ],
            },
            {
              key: "customBcText",
              label: "Custom boundary condition",
              type: "expression",
              showWhen: (d) => d.lateralBc === "custom",
            },
            {
              key: "magnetostaticBc",
              label: "Magnetostatic BC",
              type: "select",
              structural: true,
              options: [
                { value: "open", label: "Open space" },
                { value: "periodic_airbox_k0", label: "Periodic airbox (k = 0)" },
                { value: "floquet_airbox", label: "Bloch–Floquet (k ≠ 0) airbox" },
              ],
            },
            {
              label: "Periodic boundary pairs",
              type: "readonly",
              showWhen: (d) =>
                d.lateralBc === "periodic_1d" ||
                d.lateralBc === "periodic_2d" ||
                d.magnetostaticBc !== "open",
              format: () => summarizePeriodicPairsResource(periodicPairs),
            },
            {
              label: "Bloch phase convention",
              type: "readonly",
              mono: true,
              showWhen: (d) =>
                d.lateralBc === "periodic_1d" ||
                d.lateralBc === "periodic_2d" ||
                d.magnetostaticBc === "floquet_airbox",
              format: () => "exp(-i k · Δr)",
            },
          ],
        },
        {
          id: "wavevector-sampling",
          title: "Wavevector Sampling",
          icon: Activity,
          modeTabId: "physics",
          defaultOpen: true,
          showWhen: (d) =>
            d.calculationMode === "dispersion_modal" ||
            d.calculationMode === "free_modes",
          rows: [
            {
              key: "kSamplingMode",
              label: "Wavevector sampling mode",
              symbol: "k",
              type: "segmented",
              structural: true,
              options: [
                { value: "none", label: "Γ = 0" },
                { value: "single_k", label: "Single k" },
                { value: "k_path", label: "Γ–X–M Path" },
                { value: "k_grid", label: "2D k-Grid" },
              ],
            },
            {
              key: "kVectorRadPerM",
              label: "Wavevector k",
              symbol: "k",
              type: "vector3",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              showWhen: (d) => d.kSamplingMode === "single_k",
            },
            {
              key: "kPathHighSymmetry",
              label: "High-symmetry k-path",
              type: "expression",
              multiline: true,
              placeholder: DEFAULT_CANONICAL_K_PATH,
              showWhen: (d) => d.kSamplingMode === "k_path",
            },
            {
              key: "kSamplesPerSegment",
              label: "Samples per segment",
              type: "number",
              integer: true,
              min: 2,
              max: 512,
              showWhen: (d) => d.kSamplingMode === "k_path",
            },
            {
              key: "kSamplingJson",
              label: "k-sampling grid JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"kind":"grid","nx":32,"ny":32}',
              showWhen: (d) => d.kSamplingMode === "k_grid",
            },
          ],
        },
        {
          id: "eigensolver",
          title: "Eigensolver & Mode Outputs",
          icon: Gauge,
          modeTabId: "solver",
          defaultOpen: true,
          rows: [
            {
              key: "modeCount",
              label: "Number of modes",
              symbol: (
                <>
                  N<sub>m</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 500,
            },
            {
              key: "spectralTarget",
              label: "Spectral target",
              type: "segmented",
              structural: true,
              options: [
                { value: "lowest", label: "Lowest" },
                { value: "nearest", label: "Shift-invert" },
                { value: "frequency_window", label: "Window" },
              ],
            },
            {
              key: "targetFrequencyHz",
              label: "Target frequency",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spectralTarget === "nearest",
            },
            {
              key: "windowMinHz",
              label: "Window minimum",
              symbol: (
                <>
                  f<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spectralTarget === "frequency_window",
            },
            {
              key: "windowMaxHz",
              label: "Window maximum",
              symbol: (
                <>
                  f<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spectralTarget === "frequency_window",
              validate: (val, d) =>
                val <= d.windowMinHz ? "Window maximum must exceed window minimum." : null,
            },
            {
              key: "maxKrylovIterations",
              label: "Max Krylov iterations",
              type: "number",
              integer: true,
              min: 10,
              max: 100000,
            },
            {
              key: "normalization",
              label: "Mode normalization",
              type: "segmented",
              options: [
                { value: "unit_l2", label: "Unit L2" },
                { value: "unit_max_amplitude", label: "Unit max amplitude" },
              ],
            },
            {
              type: "custom",
              label: "Modal solve status",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this stage to compute modal frequencies, damping linewidths, and 3D mode shapes."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      calculationModeRows,
      initialChoice,
      kernel,
      lastAuthoringError,
      onCommitStage,
      onRunStage,
      onSwitchPrecisionToDouble,
      periodicPairs,
      pipelineNodeId,
      resolvedSteps,
      sceneData,
      sceneRevision,
      stageId,
      stageIndex,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      options={initialModeTabId ? { initialModeTabId } : undefined}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (key === "enableBiasSweep" && value === true) {
          if (!nextDraft.biasFieldSamplesApmText.trim()) {
            return {
              biasFieldSamplesApmText: formatBiasFieldApmLine(
                nextDraft.biasSampleFieldTesla,
              ),
            };
          }
          return null;
        }
        if (key === "biasSampleFieldTesla") {
          const vec = value as readonly [number, number, number];
          return {
            biasFieldSamplesApmText: syncFirstBiasLineApm(
              nextDraft.biasFieldSamplesApmText,
              vec,
            ),
          };
        }
        if (key === "biasFieldSamplesApmText") {
          return {
            biasSampleFieldTesla: parseFirstBiasSampleTesla(
              String(value ?? ""),
              nextDraft.biasSampleFieldTesla,
            ),
          };
        }
        if (key === "kSamplesPerSegment") {
          const samples = Number(value);
          if (Number.isFinite(samples) && samples >= 2) {
            return {
              kPathHighSymmetry: formatKPathWithSamples(
                nextDraft.kPathHighSymmetry,
                samples,
              ),
            };
          }
          return null;
        }
        if (key === "kPathHighSymmetry") {
          const parsedSamples = parseKPathSamplesPerSegment(
            String(value ?? ""),
            nextDraft.kSamplesPerSegment,
          );
          if (parsedSamples !== nextDraft.kSamplesPerSegment) {
            return { kSamplesPerSegment: parsedSamples };
          }
          return null;
        }
        if (
          key === "calculationMode" &&
          value === "dispersion_modal" &&
          nextDraft.kSamplingMode === "none"
        ) {
          return { kSamplingMode: "k_path" as const };
        }
        return null;
      }}
    />
  );
}

interface FrequencyResponseStageSpecDraft {
  stageId: string;
  stageEnabled: boolean;
  calculationMode: "fmr_response" | "response_map";
  equilibriumSource: "relax" | "provided" | "artifact";
  equilibriumArtifact: string;
  includeDemag: boolean;
  dampingPolicy: "ignore" | "include";
  lateralBc: "free" | "pinned" | "periodic_1d" | "periodic_2d" | "custom";
  customBcText: string;
  magnetostaticBc: "open" | "periodic_airbox_k0" | "floquet_airbox";
  excitationFieldApm: readonly [number, number, number];
  excitationPhaseRad: number;
  sweepMode: "range_lin" | "range_log" | "explicit_list";
  sweepMinHz: number;
  sweepMaxHz: number;
  sweepCount: number;
  explicitFrequenciesText: string;
  kVectorRadPerM: readonly [number, number, number];
  kGridCountX: number;
  kGridMaxRadPerM: number;
  kSamplingJson: string;
  solverMethod: FrequencyResponseSolverMethod;
  normalization: "unit_l2" | "unit_max_amplitude";
  observable:
    | "spatial_average_m"
    | "absorbed_power"
    | "susceptibility_tensor"
    | "port_impedance"
    | "custom";
  customObservableKey: string;
  stageMagnetizationAssignments: JsonValue | undefined;
  resolvedDeviceLabel: string;
  precision: "double" | "single";
  hasPrecedingRelax: boolean;
}

function toFrequencyResponseStudyStageDraft(
  draft: FrequencyResponseStageSpecDraft,
  base?: StudyStageDraft,
): StudyStageDraft {
  const seed = base ?? createDefaultStudyStageDraft("frequency_response", 0);
  const resolvedKSampling =
    draft.calculationMode === "response_map"
      ? buildKGridSamplingJson(
          draft.kSamplingJson,
          draft.kGridCountX,
          draft.kGridMaxRadPerM,
        )
      : "";
  const resolvedKVector =
    draft.calculationMode === "response_map"
      ? draft.kVectorRadPerM.join(", ")
      : "";
  const frequenciesHz =
    draft.sweepMode === "explicit_list"
      ? parseExplicitFrequencySweepHz(draft.explicitFrequenciesText).frequenciesHz.join(
          ", ",
        ) || draft.explicitFrequenciesText
      : buildSweepFrequenciesCsv(
          draft.sweepMode,
          draft.sweepMinHz,
          draft.sweepMaxHz,
          draft.sweepCount,
        );

  return {
    ...seed,
    kind: "frequency_response",
    stageId: draft.stageId,
    stageEnabled: serializeStageEnabled(draft.stageEnabled, base),
    calculationMode: draft.calculationMode,
    equilibriumSource: draft.equilibriumSource,
    equilibriumArtifact:
      draft.equilibriumSource === "artifact" ? draft.equilibriumArtifact : "",
    includeDemag: draft.includeDemag,
    dampingPolicy: draft.dampingPolicy,
    bc: draft.lateralBc === "custom" ? draft.customBcText : draft.lateralBc,
    magnetostaticBc: draft.magnetostaticBc,
    kVector: resolvedKVector,
    kSampling: resolvedKSampling,
    excitationField: draft.excitationFieldApm.join(", "),
    excitationPhaseRad: String(draft.excitationPhaseRad),
    frequenciesHz,
    solverMethod: draft.solverMethod,
    normalization: draft.normalization,
    observable:
      draft.observable === "custom"
        ? draft.customObservableKey || "spatial_average_m"
        : draft.observable,
    stageMagnetizationAssignments: draft.stageMagnetizationAssignments,
  };
}

export function FrequencyResponseStageInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: SpectralStageTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedFrequencyResponseStageInspectorPanel selection={selection} />;
  }
  return (
    <FrequencyResponseStageInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedFrequencyResponseStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitSelectedStageDraft,
    commitStudyMetadata,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hasResources = hasKernelResourceRuntime(kernel);
  const canLoadManifest =
    hasResources &&
    Boolean(runtimeStatus?.domain && runtimeStatus?.resources) &&
    Boolean(kernel?.api?.analysis?.frequencyDomain?.manifestV1);
  const canLoadPeriodicPairs =
    hasResources && Boolean(kernel?.api?.meshing?.periodicPairs);

  const hydratedBaseline = useMemo<FrequencyResponseStageSpecDraft>(() => {
    const d: Partial<StudyStageDraft> =
      selectedStageDraft?.kind === "frequency_response" ? selectedStageDraft : {};
    const stageId =
      d.stageId ||
      (selection.ref?.type === "study-stage" && selection.ref.stageId
        ? selection.ref.stageId
        : `freq_${selectedStageIndex + 1}`);
    const precision: "double" | "single" =
      globalDraft.requestedPrecision === "single" ? "single" : "double";
    const hasPrecedingRelax = stageDrafts
      .slice(0, Math.max(0, selectedStageIndex))
      .some((s) => s.kind === "relax");
    const hasAuthoredSweep = Boolean(d.frequenciesHz?.trim());
    const parsedExplicit = hasAuthoredSweep
      ? parseExplicitFrequencySweepHz(d.frequenciesHz ?? "")
      : { frequenciesHz: [], error: null };
    const freqs = parsedExplicit.frequenciesHz;
    const kGridMeta = parseKGridMetadata(d.kSampling);
    const solverMethod = (
      SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS as readonly string[]
    ).includes(d.solverMethod ?? "")
      ? (d.solverMethod as FrequencyResponseSolverMethod)
      : "auto";
    const knownBc =
      d.bc === "free" ||
      d.bc === "pinned" ||
      d.bc === "periodic_1d" ||
      d.bc === "periodic_2d" ||
      !d.bc?.trim();
    const knownObs =
      d.observable === "spatial_average_m" ||
      d.observable === "absorbed_power" ||
      d.observable === "susceptibility_tensor" ||
      d.observable === "port_impedance" ||
      !d.observable?.trim();
    return {
      stageId,
      stageEnabled: d.stageEnabled ?? true,
      calculationMode:
        d.calculationMode === "response_map" ? "response_map" : "fmr_response",
      equilibriumSource:
        d.equilibriumSource === "relax"
          ? "relax"
          : d.equilibriumSource === "artifact"
            ? "artifact"
            : "provided",
      equilibriumArtifact: d.equilibriumArtifact ?? "",
      includeDemag: d.includeDemag ?? true,
      dampingPolicy: d.dampingPolicy === "ignore" ? "ignore" : "include",
      lateralBc: knownBc
        ? ((d.bc as FrequencyResponseStageSpecDraft["lateralBc"] | undefined) || "free")
        : "custom",
      customBcText: knownBc ? "" : d.bc ?? "",
      magnetostaticBc:
        d.magnetostaticBc === "periodic_airbox_k0" ||
        d.magnetostaticBc === "floquet_airbox"
          ? d.magnetostaticBc
          : "open",
      excitationFieldApm: parseSpectralVec3(
        d.excitationField ?? "",
        [0, 795.77, 0],
      ),
      excitationPhaseRad: Number(d.excitationPhaseRad) || 0,
      sweepMode: hasAuthoredSweep ? "explicit_list" : "range_lin",
      sweepMinHz: freqs[0] ?? 1e9,
      sweepMaxHz: freqs.at(-1) ?? 25e9,
      sweepCount: freqs.length >= 2 ? freqs.length : 241,
      explicitFrequenciesText: d.frequenciesHz || "2.5GHz, 5GHz, 10GHz",
      kVectorRadPerM: parseSpectralVec3(d.kVector ?? "", [0, 0, 0]),
      kGridCountX: kGridMeta.countX,
      kGridMaxRadPerM: kGridMeta.maxRadPerM,
      kSamplingJson: d.kSampling ?? "",
      solverMethod,
      normalization:
        d.normalization === "unit_l2" ? "unit_l2" : "unit_max_amplitude",
      observable: knownObs
        ? ((d.observable as FrequencyResponseStageSpecDraft["observable"] | undefined) ||
          "spatial_average_m")
        : "custom",
      customObservableKey: knownObs ? "" : d.observable ?? "",
      stageMagnetizationAssignments: d.stageMagnetizationAssignments,
      resolvedDeviceLabel: `Requested ${globalDraft.requestedDevice || "auto"}`,
      precision,
      hasPrecedingRelax,
    };
  }, [
    globalDraft.requestedDevice,
    globalDraft.requestedPrecision,
    selectedStageDraft,
    selectedStageIndex,
    selection.ref,
    stageDrafts,
  ]);

  const validationContext = useMemo<SpectralValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <SpectralCapabilitiesLoader
          canLoadManifest={canLoadManifest}
          canLoadPeriodicPairs={canLoadPeriodicPairs}
        >
          {({ manifest, periodicPairs }) => (
            <FrequencyResponseStageInspectorPanelView
              hydratedBaseline={hydratedBaseline}
              lastAuthoringError={lastAuthoringError}
              manifest={manifest}
              periodicPairs={periodicPairs}
              pipelineNodeId={selectedStageDraft?.pipelineNodeId}
              pipelineStripSteps={pipelineStripSteps}
              sceneData={sceneData}
              sceneRevision={sceneRevision}
              selection={selection}
              stageModel={selectedStageModel}
              validationContext={validationContext}
              onCommitStage={(draft) =>
                commitSelectedStageDraft(
                  (base) => toFrequencyResponseStudyStageDraft(draft, base),
                  "frequency_response",
                )
              }
              onRunStage={(stageId, initialChoice) =>
                executeSelectedStage(
                  stageId,
                  initialChoice,
                  "frequency_response",
                )
              }
              onSwitchPrecisionToDouble={() =>
                commitStudyMetadata({ requested_precision: "double" })
              }
            />
          )}
        </SpectralCapabilitiesLoader>
      )}
    </StudyStageTelemetryBridge>
  );
}

function FrequencyResponseStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  manifest = null,
  onCommitStage,
  onRunStage,
  onSwitchPrecisionToDouble,
  periodicPairs = null,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  testSnapshot,
  validationContext,
}: InspectorPanelProps & {
  hydratedBaseline?: FrequencyResponseStageSpecDraft;
  lastAuthoringError?: string | null;
  manifest?: FrequencyDomainManifestResource | null;
  onCommitStage?: (draft: FrequencyResponseStageSpecDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  onSwitchPrecisionToDouble?: () => Promise<boolean>;
  periodicPairs?: MeshPeriodicPairsResource | null;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  testSnapshot?: SpectralStageTestSnapshot;
  validationContext?: SpectralValidationContext;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const stageIndex =
    selection.ref?.type === "study-stage" && typeof selection.ref.stageIndex === "number"
      ? selection.ref.stageIndex
      : 1;
  const stageId =
    hydratedBaseline?.stageId ??
    (selection.ref?.type === "study-stage" && selection.ref.stageId
      ? selection.ref.stageId
      : `freq_${stageIndex + 1}`);

  const fallbackBaseline = useMemo<FrequencyResponseStageSpecDraft>(
    () => ({
      stageId,
      stageEnabled: true,
      calculationMode: "fmr_response",
      equilibriumSource: "provided",
      equilibriumArtifact: "",
      includeDemag: true,
      dampingPolicy: "include",
      lateralBc: "free",
      customBcText: "",
      magnetostaticBc: "open",
      excitationFieldApm: [0, 795.77, 0],
      excitationPhaseRad: 0,
      sweepMode: "range_lin",
      sweepMinHz: 1e9,
      sweepMaxHz: 25e9,
      sweepCount: 241,
      explicitFrequenciesText: "2.5GHz, 5GHz, 10GHz",
      kVectorRadPerM: [0, 0, 0],
      kGridCountX: 64,
      kGridMaxRadPerM: 25e6,
      kSamplingJson: "",
      solverMethod: "auto",
      normalization: "unit_max_amplitude",
      observable: "spatial_average_m",
      customObservableKey: "",
      stageMagnetizationAssignments: undefined,
      resolvedDeviceLabel: testSnapshot?.resolvedDeviceLabel ?? "Auto → GPU (CUDA)",
      precision: testSnapshot?.precision ?? "double",
      hasPrecedingRelax: testSnapshot?.hasPrecedingRelax ?? true,
    }),
    [
      stageId,
      testSnapshot?.hasPrecedingRelax,
      testSnapshot?.precision,
      testSnapshot?.resolvedDeviceLabel,
    ],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const calculationModeRows = useMemo<FrequencyDomainCalculationModeRow[]>(
    () =>
      buildFrequencyDomainCalculationModeRows(
        manifest?.capabilities,
        manifest?.floquet_nonzero_k_response_supported,
      )
        .filter((row) => ["fmr_response", "response_map"].includes(row.mode))
        .map((row) => ({
          ...row,
          capabilityStatus: sanitizeCapabilityStatus(row.capabilityStatus),
        })),
    [manifest?.capabilities, manifest?.floquet_nonzero_k_response_supported],
  );

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            {
              id: "relax_1",
              index: 0,
              kind: "study.stage.relax",
              label: "Relax",
              status: "completed",
            },
            {
              id: stageId,
              index: stageIndex,
              kind: "study.stage.frequency_response",
              label: "Frequency Response",
              status: "ready",
            },
          ],
    [pipelineStripSteps, stageId, stageIndex],
  );

  const titleLabel = `Frequency Response ${stageIndex + 1}`;
  const initialModeTabId = resolveInitialFrequencyResponseTab(selection.kind);

  const spec = useMemo<InspectorSpec<FrequencyResponseStageSpecDraft>>(
    () => ({
      id: "study.stage.frequency_response",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Frequency response solve queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Linearized harmonic response stage",
        entityId: stageId,
        statePill: (d) =>
          d.precision !== "double"
            ? { tone: "err", label: "Requires FP64" }
            : d.excitationFieldApm.every((v) => v === 0)
              ? { tone: "err", label: "Zero excitation" }
              : d.equilibriumSource === "relax" && !d.hasPrecedingRelax
                ? { tone: "warn", label: "Equilibrium missing" }
                : { tone: "ok", label: "Ready" },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "mode",
          label: "Mode",
          value: d.calculationMode === "response_map" ? "2D k-Grid Map" : "FMR Sweep",
        },
        {
          id: "sweep",
          label: "Sweep",
          value:
            d.sweepMode === "explicit_list"
              ? `${parseExplicitFrequencySweepHz(d.explicitFrequenciesText).frequenciesHz.length} explicit pts`
              : `${(d.sweepMinHz / 1e9).toFixed(1)}–${(d.sweepMaxHz / 1e9).toFixed(1)} GHz (${d.sweepCount} pts)`,
        },
        { id: "solver", label: "Solver", value: d.solverMethod },
        { id: "device", label: "Device", value: d.resolvedDeviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup & Equilibrium" },
        { id: "excitation", label: "Excitation & Sweep" },
        { id: "solver", label: "Solver & Outputs" },
      ],
      notices: (d): readonly InspectorNotice<FrequencyResponseStageSpecDraft>[] => {
        const list: InspectorNotice<FrequencyResponseStageSpecDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.precision !== "double") {
          list.push({
            id: "fp64-required",
            tone: "err",
            text: "Driven harmonic frequency-response solvers require double precision (FP64).",
            quickFix: {
              label: "Switch Study Precision to FP64",
              onApply: async (ctx) => {
                ctx.setField("precision", "double");
                if (onSwitchPrecisionToDouble) {
                  await onSwitchPrecisionToDouble();
                }
              },
            },
          });
        }
        if (d.excitationFieldApm.every((component) => component === 0)) {
          list.push({
            id: "zero-excitation",
            tone: "err",
            text: "Harmonic RF excitation amplitude cannot be [0, 0, 0]. Specify at least one non-zero RF field component.",
            focusFieldKey: "excitationFieldApm",
            quickFix: {
              label: "Set 1 mT transverse RF drive",
              onApply: (ctx) =>
                ctx.setField("excitationFieldApm", [0, 795.77, 0]),
            },
          });
        }
        if (d.equilibriumSource === "relax" && !d.hasPrecedingRelax) {
          list.push({
            id: "missing-relax",
            tone: "warn",
            text: "Equilibrium source references a preceding Relax stage, which is not yet in the pipeline.",
            quickFix: {
              label: "Use current runtime state",
              onApply: (ctx) => ctx.setField("equilibriumSource", "provided"),
            },
          });
        }
        const stageDraft = toFrequencyResponseStudyStageDraft(d);
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          if (list.some((existing) => existing.text === issue.message)) continue;
          list.push({
            id: `stage-validation-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline-mode",
          title: "Pipeline & Calculation Mode",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={stageIndex}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
            {
              key: "calculationMode",
              label: "Calculation mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "fmr_response", label: "Driven FMR Sweep" },
                { value: "response_map", label: "Driven k-Space Map" },
              ],
            },
            {
              type: "table",
              label: "Calculation mode capabilities",
              wide: true,
              rowKey: (row) => (row as FrequencyDomainCalculationModeRow).mode,
              rows: () => calculationModeRows,
              columns: [
                {
                  id: "mode",
                  header: "Mode",
                  mono: true,
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).mode,
                },
                {
                  id: "boundary",
                  header: "Boundary",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).boundaryPreset,
                },
                {
                  id: "k",
                  header: "Wavevector",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).kRequirement,
                },
                {
                  id: "cap",
                  header: "Capability",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).capabilityStatus,
                },
              ],
            },
            {
              key: "equilibriumSource",
              label: "Equilibrium source",
              type: "select",
              structural: true,
              options: [
                { value: "provided", label: "Current runtime state" },
                { value: "relax", label: "Preceding Relax stage" },
                { value: "artifact", label: "Named state artifact" },
              ],
            },
            {
              key: "equilibriumArtifact",
              label: "Equilibrium artifact",
              type: "text",
              mono: true,
              showWhen: (d) => d.equilibriumSource === "artifact",
              validate: (val) => (!val.trim() ? "Artifact name is required." : null),
            },
            {
              type: "custom",
              label: "Saved state seed",
              wide: true,
              render: ({ draft }) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    label: "Texture overrides",
                    wide: true,
                    render: ({
                      draft,
                      patchDraft,
                    }: {
                      draft: FrequencyResponseStageSpecDraft;
                      patchDraft: (p: Partial<FrequencyResponseStageSpecDraft>) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={draft.stageMagnetizationAssignments}
                        onChange={(stageMagnetizationAssignments) =>
                          patchDraft({ stageMagnetizationAssignments })
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "excitation-sweep",
          title: "Harmonic RF Excitation & Frequency Sweep",
          icon: Magnet,
          modeTabId: "excitation",
          defaultOpen: true,
          rows: [
            {
              key: "excitationFieldApm",
              label: "RF excitation amplitude",
              symbol: (
                <>
                  h<sub>rf</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_APM_UNITS_SI,
              defaultDisplayUnit: "mT",
              validate: (vec) =>
                vec.every((c) => c === 0)
                  ? "Excitation vector must be non-zero."
                  : null,
            },
            {
              key: "excitationPhaseRad",
              label: "RF excitation phase",
              symbol: (
                <>
                  φ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: ANGLE_RAD_UNITS_SI,
              defaultDisplayUnit: "deg",
            },
            {
              key: "sweepMode",
              label: "Frequency sweep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "range_lin", label: "Linear range" },
                { value: "range_log", label: "Log range" },
                { value: "explicit_list", label: "Explicit list" },
              ],
            },
            {
              key: "sweepMinHz",
              label: "Minimum frequency",
              symbol: (
                <>
                  f<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.sweepMode !== "explicit_list",
            },
            {
              key: "sweepMaxHz",
              label: "Maximum frequency",
              symbol: (
                <>
                  f<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.sweepMode !== "explicit_list",
              validate: (val, d) =>
                val <= d.sweepMinHz ? "Maximum frequency must exceed minimum frequency." : null,
            },
            {
              key: "sweepCount",
              label: "Frequency points",
              symbol: (
                <>
                  N<sub>f</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 2,
              max: 10000,
              showWhen: (d) => d.sweepMode !== "explicit_list",
            },
            {
              key: "explicitFrequenciesText",
              label: "Explicit frequencies",
              type: "expression",
              placeholder: "2.5GHz, 5GHz, 10GHz",
              showWhen: (d) => d.sweepMode === "explicit_list",
              validate: (val) => parseExplicitFrequencySweepHz(val).error,
            },
            {
              key: "lateralBc",
              label: "Lateral boundary condition",
              type: "select",
              structural: true,
              options: [
                { value: "free", label: "Open / Free spins" },
                { value: "pinned", label: "Pinned boundary (∂Ω = 0)" },
                { value: "periodic_1d", label: "1D Periodic (waveguide)" },
                { value: "periodic_2d", label: "2D Bloch-Periodic film" },
                { value: "custom", label: "Custom / JSON BC" },
              ],
            },
            {
              key: "customBcText",
              label: "Custom boundary condition",
              type: "expression",
              showWhen: (d) => d.lateralBc === "custom",
            },
            {
              key: "magnetostaticBc",
              label: "Magnetostatic BC",
              type: "select",
              structural: true,
              options: [
                { value: "open", label: "Open space" },
                { value: "periodic_airbox_k0", label: "Periodic airbox (k = 0)" },
                { value: "floquet_airbox", label: "Bloch–Floquet (k ≠ 0) airbox" },
              ],
            },
            {
              label: "Periodic boundary pairs",
              type: "readonly",
              showWhen: (d) =>
                d.lateralBc === "periodic_1d" ||
                d.lateralBc === "periodic_2d" ||
                d.magnetostaticBc !== "open",
              format: () => summarizePeriodicPairsResource(periodicPairs),
            },
            {
              key: "kVectorRadPerM",
              label: "Reference wavevector k",
              symbol: "k",
              type: "vector3",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kGridCountX",
              label: "Wavevector grid points",
              symbol: (
                <>
                  N<sub>kx</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 2,
              max: 4096,
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kGridMaxRadPerM",
              label: "Max wavevector k_max",
              symbol: (
                <>
                  k<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kSamplingJson",
              label: "k-sampling grid JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"kind":"grid","nx":64,"k_max_rad_per_m":25000000}',
              showWhen: (d) => d.calculationMode === "response_map",
            },
          ],
        },
        {
          id: "linear-solver-outputs",
          title: "Linear System Solver & Outputs",
          icon: FileOutput,
          modeTabId: "solver",
          defaultOpen: true,
          rows: [
            {
              key: "solverMethod",
              label: "Solver method",
              type: "select",
              options: [
                { value: "auto", label: "Auto (capability-resolved)" },
                { value: "dense_reference", label: "Dense direct reference (CPU)" },
                { value: "cpu_sparse_direct", label: "CPU Sparse LU direct" },
                { value: "full_coupled_field_split", label: "Field-split block preconditioner" },
                { value: "schur_reduced", label: "Schur-complement reduced" },
                { value: "modal_reduced", label: "Modal subspace projection" },
                { value: "gpu_operator_host_krylov", label: "GPU operator + host GMRES" },
                { value: "gpu_device_krylov", label: "Full GPU device GMRES" },
              ],
            },
            {
              key: "includeDemag",
              label: "Include demagnetization",
              type: "switch",
            },
            {
              key: "dampingPolicy",
              label: "Damping policy",
              type: "segmented",
              options: [
                { value: "include", label: "Include Gilbert α" },
                { value: "ignore", label: "Undamped limit" },
              ],
            },
            {
              key: "normalization",
              label: "Mode normalization",
              type: "segmented",
              options: [
                { value: "unit_l2", label: "Unit L2" },
                { value: "unit_max_amplitude", label: "Unit max amplitude" },
              ],
            },
            {
              key: "observable",
              label: "Response observable",
              type: "select",
              structural: true,
              options: [
                { value: "spatial_average_m", label: "Volume-averaged ⟨δm⟩" },
                { value: "absorbed_power", label: "Absorbed RF power P_abs" },
                { value: "susceptibility_tensor", label: "Susceptibility tensor χ(f)" },
                { value: "port_impedance", label: "Antenna port ΔZ(f)" },
                { value: "custom", label: "Custom observable key" },
              ],
            },
            {
              key: "customObservableKey",
              label: "Custom observable key",
              type: "text",
              mono: true,
              showWhen: (d) => d.observable === "custom",
            },
            {
              type: "custom",
              label: "Sweep solve status",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this stage to solve the harmonic linear system across the configured frequency sweep."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      calculationModeRows,
      initialChoice,
      kernel,
      lastAuthoringError,
      onCommitStage,
      onRunStage,
      onSwitchPrecisionToDouble,
      periodicPairs,
      pipelineNodeId,
      resolvedSteps,
      sceneData,
      sceneRevision,
      stageId,
      stageIndex,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      options={initialModeTabId ? { initialModeTabId } : undefined}
      selection={selection}
      spec={spec}
      deriveFieldPatch={(key, value, nextDraft) => {
        if (key === "kGridCountX" || key === "kGridMaxRadPerM") {
          return {
            kSamplingJson: buildKGridSamplingJson(
              nextDraft.kSamplingJson,
              nextDraft.kGridCountX,
              nextDraft.kGridMaxRadPerM,
            ),
          };
        }
        if (key === "kSamplingJson") {
          const meta = parseKGridMetadata(String(value ?? ""));
          return {
            kGridCountX: meta.countX,
            kGridMaxRadPerM: meta.maxRadPerM,
          };
        }
        return null;
      }}
    />
  );
}
