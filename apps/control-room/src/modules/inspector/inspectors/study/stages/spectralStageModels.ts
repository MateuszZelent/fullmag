import type { JsonValue } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import type { InspectorNotice } from "../../../template";
import {
  createDefaultStudyStageDraft,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import { serializeStageEnabled } from "../../../panels/stages/StageSharedControls";
import {
  SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS,
  type FrequencyResponseSolverMethod,
  DEFAULT_CANONICAL_K_PATH,
  parseExplicitFrequencySweepHz,
  type SpectralStageTestSnapshot,
  type SpectralValidationContext,
  type EigenmodesStageSpecDraft,
  parseSpectralVec3,
  parseFirstBiasSampleTesla,
  formatBiasFieldApmLine,
  syncFirstBiasLineApm,
  parseKPathSamplesPerSegment,
  formatKPathWithSamples,
  parseKGridMetadata,
  buildKGridSamplingJson,
  buildSweepFrequenciesCsv,
  toEigenmodesStudyStageDraft,
} from "./spectralStageShared";
export function buildHydratedEigenmodesBaseline({
  requestedDevice,
  requestedPrecision,
  selectedStageDraft,
  selectedStageIndex,
  selection,
  stageDrafts,
}: {
  requestedDevice: string;
  requestedPrecision: string;
  selectedStageDraft: StudyStageDraft | null;
  selectedStageIndex: number;
  selection: Selection;
  stageDrafts: readonly StudyStageDraft[];
}): EigenmodesStageSpecDraft {
  const globalDraft = { requestedDevice, requestedPrecision };
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
}

export function createFallbackEigenmodesBaseline(
  stageId: string,
  testSnapshot?: SpectralStageTestSnapshot,
): EigenmodesStageSpecDraft {
  return {
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
  };
}

export function buildEigenmodesStageNotices({
  d,
  lastAuthoringError,
  onSwitchPrecisionToDouble,
  validationContext,
}: {
  d: EigenmodesStageSpecDraft;
  lastAuthoringError: string | null;
  onSwitchPrecisionToDouble?: () => Promise<boolean>;
  validationContext?: SpectralValidationContext;
}): readonly InspectorNotice<EigenmodesStageSpecDraft>[] {
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
}

export function deriveEigenmodesFieldPatch<K extends keyof EigenmodesStageSpecDraft>(
  key: K,
  value: EigenmodesStageSpecDraft[K],
  nextDraft: EigenmodesStageSpecDraft,
): Partial<EigenmodesStageSpecDraft> | null {
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
}

export interface FrequencyResponseStageSpecDraft {
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

export function toFrequencyResponseStudyStageDraft(
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


export function buildHydratedFrequencyResponseBaseline({
  requestedDevice,
  requestedPrecision,
  selectedStageDraft,
  selectedStageIndex,
  selection,
  stageDrafts,
}: {
  requestedDevice: string;
  requestedPrecision: string;
  selectedStageDraft: StudyStageDraft | null;
  selectedStageIndex: number;
  selection: Selection;
  stageDrafts: readonly StudyStageDraft[];
}): FrequencyResponseStageSpecDraft {
  const globalDraft = { requestedDevice, requestedPrecision };
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
}

export function createFallbackFrequencyResponseBaseline(
  stageId: string,
  testSnapshot?: SpectralStageTestSnapshot,
): FrequencyResponseStageSpecDraft {
  return {
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
  };
}

export function deriveFrequencyResponseFieldPatch<
  K extends keyof FrequencyResponseStageSpecDraft,
>(
  key: K,
  value: FrequencyResponseStageSpecDraft[K],
  nextDraft: FrequencyResponseStageSpecDraft,
): Partial<FrequencyResponseStageSpecDraft> | null {
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
}
