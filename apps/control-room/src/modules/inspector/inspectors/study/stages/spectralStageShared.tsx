"use client";

import type { ReactNode } from "react";

import type {
  FrequencyDomainManifestResource,
  JsonValue,
  MeshPeriodicPairsResource,
} from "@/kernel/api/apiTypes";
import { parseQuantityInput } from "@/kernel/authoring/object-edit/quantityInput";
import {
  useFrequencyDomainManifestResource,
  useMeshPeriodicPairsResource,
} from "@/kernel/resources/studyRuntimeResources";
import type {
  ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";

import { periodicStatusView } from "../../../panels/frequencyDomainInspectorModel";
import {
  createDefaultStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import { MU0_SI } from "../../../panels/study/ConnectedInspectorSpec";
import { serializeStageEnabled } from "../../../panels/stages/StageSharedControls";
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

export interface SpectralStageTestSnapshot {
  resolvedDeviceLabel?: string;
  precision?: "double" | "single";
  hasPrecedingRelax?: boolean;
}

export interface SpectralValidationContext {
  activeLane?: ActiveLaneCapabilitySnapshot | null;
  algorithmsAvailable?: readonly string[];
  backend: string;
  demagEnabled: boolean;
  device: string;
  mode: string;
  precision: string;
}

export interface EigenmodesStageSpecDraft {
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

export function parseSpectralVec3(
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

export function parseFirstBiasSampleTesla(
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

export function formatBiasFieldApmLine(
  fieldTesla: readonly [number, number, number],
): string {
  return fieldTesla
    .map((b) => Number((b / MU0_SI).toPrecision(7)))
    .join(", ");
}

export function syncFirstBiasLineApm(
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

export function parseKGridMetadata(
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

export function buildKGridSamplingJson(
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

export function buildSweepFrequenciesCsv(
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

export function sanitizeCapabilityStatus(raw: string): string {
  return raw.replace(/\bunknown\b/gi, "pending session check");
}

export function resolveInitialEigenmodesTab(
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

export function resolveInitialFrequencyResponseTab(
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

export function toEigenmodesStudyStageDraft(
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

export function summarizePeriodicPairsResource(
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


export function SpectralCapabilitiesLoader({
  canLoadManifest,
  canLoadPeriodicPairs,
  children,
}: {
  canLoadManifest: boolean;
  canLoadPeriodicPairs: boolean;
  children: (resources: {
    manifest: FrequencyDomainManifestResource | null;
    periodicPairs: MeshPeriodicPairsResource | null;
  }) => ReactNode;
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
  }) => ReactNode;
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
  }) => ReactNode;
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
  }) => ReactNode;
}) {
  const periodic = useMeshPeriodicPairsResource();
  return <>{children({ manifest: null, periodicPairs: periodic.data ?? null })}</>;
}
