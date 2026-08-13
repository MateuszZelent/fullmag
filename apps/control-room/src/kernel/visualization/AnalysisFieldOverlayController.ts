"use client";

import { useSyncExternalStore } from "react";

import type {
  FloquetSpatialConvention,
  PhasorConvention,
} from "@/shared/domain/analysis/phasorConventionAdapter";

import type { FieldVectorQuery } from "../api/apiTypes";
import type {
  SurfaceColorSource,
  VisualizationGeometryScope,
} from "./ObjectVisualizationController";

export type AnalysisFieldOverlaySource = "eigen-mode" | "frequency-response";
export type AnalysisFieldOverlayRepresentation = "complex-vector-xyz";
export type AnalysisFieldOverlayKContextKind =
  | "finite_open"
  | "fixed_k"
  | "gamma"
  | "k_grid"
  | "k_path";

interface AnalysisFieldOverlayAnimationState {
  animatePhase: boolean;
  animationRateHz: number;
  direction?: -1 | 1;
  loop?: boolean;
}

export interface AnalysisFieldOverlayAppearanceState {
  colorRangeMax?: number;
  colorRangeMin?: number;
  colorRangeMode?: "auto" | "manual" | "symmetric";
  displayGain?: number;
  geometryScope?: VisualizationGeometryScope;
  scalarColorPalette?: string;
  shaderMonoColor?: string;
  shaderVisible?: boolean;
  surfaceColorSource?: SurfaceColorSource;
  vectorBudget?: number;
  vectorScale?: number;
  vectorsVisible?: boolean;
}

export interface AnalysisFieldOverlayState {
  appearance?: AnalysisFieldOverlayAppearanceState;
  animation?: AnalysisFieldOverlayAnimationState;
  fieldId: string;
  frequencyHz?: number;
  frequencyIndex?: number;
  kPathCoordinateRadPerM?: number;
  label: string;
  modeIndex?: number;
  query: FieldVectorQuery;
  sampleIndex?: number;
  source: AnalysisFieldOverlaySource;
  visualizationPhaseRad?: number;
  wavevectorKf?: [number, number, number];
  cellOrigin?: [number, number, number];
  floquetSpatialConvention?: FloquetSpatialConvention;
  phasorConvention?: PhasorConvention;
  provenance?: {
    artifactRevision?: number | string;
    equilibriumId?: string;
    kContextKind?: AnalysisFieldOverlayKContextKind;
    normalization?: string;
    observableId?: string;
    representation?: AnalysisFieldOverlayRepresentation;
    resourceRef?: string;
    runId?: string;
    stageId?: string;
    studyProduct?: string;
  };
}

export type AnalysisFieldOverlayContextStatus =
  | "compatible"
  | "foreign"
  | "inactive"
  | "unverified";

export interface AnalysisFieldOverlayContextSnapshot {
  overlay: AnalysisFieldOverlayState | null;
  reason: string | null;
  resultRunId: string | null;
  status: AnalysisFieldOverlayContextStatus;
}

type AnalysisFieldOverlayListener = () => void;

export class AnalysisFieldOverlayController {
  private snapshot: AnalysisFieldOverlayState | null = null;
  private resultRunId: string | null = null;
  private contextSnapshot: AnalysisFieldOverlayContextSnapshot =
    analysisFieldOverlayContextSnapshot(null, null);
  private readonly listeners = new Set<AnalysisFieldOverlayListener>();

  getSnapshot(): AnalysisFieldOverlayState | null {
    return this.snapshot;
  }

  getContextSnapshot(): AnalysisFieldOverlayContextSnapshot {
    return this.contextSnapshot;
  }

  getRenderableSnapshot(): AnalysisFieldOverlayState | null {
    return this.contextSnapshot.status === "compatible" ? this.snapshot : null;
  }

  set(next: AnalysisFieldOverlayState): void {
    if (analysisFieldOverlayStateEquals(this.snapshot, next)) {
      return;
    }
    this.snapshot = {
      ...next,
      ...(next.appearance ? { appearance: { ...next.appearance } } : {}),
      ...(next.animation ? { animation: { ...next.animation } } : {}),
      ...(next.provenance ? { provenance: { ...next.provenance } } : {}),
      ...(next.cellOrigin ? { cellOrigin: [...next.cellOrigin] } : {}),
      query: { ...next.query },
      ...(next.wavevectorKf ? { wavevectorKf: [...next.wavevectorKf] } : {}),
    };
    this.notify();
  }

  update(next: Partial<AnalysisFieldOverlayState>): void {
    if (this.snapshot === null) {
      return;
    }
    this.set({
      ...this.snapshot,
      ...next,
      ...(next.appearance === undefined
        ? this.snapshot.appearance
          ? { appearance: { ...this.snapshot.appearance } }
          : {}
        : { appearance: { ...next.appearance } }),
      ...(next.animation === undefined
        ? this.snapshot.animation
          ? { animation: { ...this.snapshot.animation } }
          : {}
        : { animation: { ...next.animation } }),
      ...(next.provenance === undefined
        ? this.snapshot.provenance
          ? { provenance: { ...this.snapshot.provenance } }
          : {}
        : { provenance: { ...next.provenance } }),
      query: next.query ? { ...next.query } : { ...this.snapshot.query },
    });
  }

  clear(): void {
    if (this.snapshot === null) {
      return;
    }
    this.snapshot = null;
    this.notify();
  }

  setResultContext(runId: string | null | undefined): void {
    const nextRunId = nonEmptyString(runId);
    if (this.resultRunId === nextRunId) {
      return;
    }
    this.resultRunId = nextRunId;
    this.notify();
  }

  rebindDisabledReason(next: AnalysisFieldOverlayState | null): string | null {
    if (!this.snapshot) {
      return "No active analysis overlay is available to rebind.";
    }
    if (this.contextSnapshot.status === "compatible") {
      return "Active analysis overlay already belongs to the selected result context.";
    }
    if (!next) {
      return "Select a typed analysis field in the selected result context to rebind.";
    }
    const targetContext = analysisFieldOverlayContextSnapshot(
      next,
      this.resultRunId,
    );
    if (targetContext.status === "unverified") {
      return (
        targetContext.reason?.replace(
          "Active analysis overlay",
          "Selected analysis target",
        ) ??
        "Selected analysis target owner identity is incomplete and cannot be rebound."
      );
    }
    if (targetContext.status === "foreign") {
      return targetContext.reason?.replace(
        "Active analysis overlay",
        "Selected analysis target",
      ) ?? "Selected analysis target belongs to another result context.";
    }
    return targetContext.status === "compatible" ? null : "Selected analysis target is unavailable.";
  }

  rebind(next: AnalysisFieldOverlayState): boolean {
    if (this.rebindDisabledReason(next) !== null || !this.snapshot) {
      return false;
    }
    const previous = this.snapshot;
    const visualizationPhaseRad =
      previous.visualizationPhaseRad ?? previous.query.phase_rad ?? 0;
    this.set({
      ...next,
      ...(previous.appearance ? { appearance: { ...previous.appearance } } : {}),
      ...(previous.animation ? { animation: { ...previous.animation } } : {}),
      query: {
        ...next.query,
        phase_rad: visualizationPhaseRad,
        view: previous.query.view ?? next.query.view,
      },
      visualizationPhaseRad,
    });
    return true;
  }

  belongsToResultContext(runId: string | null | undefined): boolean {
    if (!this.snapshot) return true;
    return analysisFieldOverlayContextSnapshot(
      this.snapshot,
      nonEmptyString(runId),
    ).status === "compatible";
  }

  subscribe(listener: AnalysisFieldOverlayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.contextSnapshot = analysisFieldOverlayContextSnapshot(
      this.snapshot,
      this.resultRunId,
    );
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function nonEmptyString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function finiteVector3(
  value: readonly number[] | null | undefined,
): value is readonly [number, number, number] {
  return Boolean(
    value &&
      value.length === 3 &&
      value.every((component) => Number.isFinite(component)),
  );
}

function nonzeroVector(value: readonly [number, number, number]): boolean {
  return value.some((component) => Math.abs(component) > 1e-12);
}

function overlayOwnerIdentityIssue(
  overlay: AnalysisFieldOverlayState,
): string | null {
  const provenance = overlay.provenance;
  const hasArtifactRevision =
    typeof provenance?.artifactRevision === "number" ||
    (nonEmptyString(provenance?.artifactRevision) !== null &&
      provenance?.artifactRevision !== "unknown");
  const phaseRad = overlay.visualizationPhaseRad ?? overlay.query.phase_rad;
  if (!nonEmptyString(overlay.fieldId)) return "Active analysis overlay field identity is missing.";
  if (!nonEmptyString(overlay.query.view)) return "Active analysis overlay view representation is missing.";
  if (!Number.isFinite(phaseRad)) return "Active analysis overlay phase is invalid.";
  if (!hasArtifactRevision) return "Active analysis overlay artifact revision is missing.";
  if (!nonEmptyString(provenance?.equilibriumId)) return "Active analysis overlay equilibrium identity is missing.";
  if (!nonEmptyString(provenance?.resourceRef)) return "Active analysis overlay field resource identity is missing.";
  if (!nonEmptyString(provenance?.runId)) return "Active analysis overlay run identity is missing.";
  if (!nonEmptyString(provenance?.stageId)) return "Active analysis overlay stage identity is missing.";
  if (provenance?.representation !== "complex-vector-xyz") {
    return "Active analysis overlay representation is missing or is not a spatial complex XYZ vector.";
  }
  if (!Number.isFinite(overlay.frequencyHz)) {
    return "Active analysis overlay frequency identity is missing.";
  }
  if (overlay.source === "eigen-mode") {
    if (provenance?.studyProduct !== "modal_eigen") {
      return "Active analysis overlay source does not match its modal study product.";
    }
    if (!Number.isInteger(overlay.sampleIndex) || !Number.isInteger(overlay.modeIndex)) {
      return "Active analysis overlay modal sample or mode identity is missing.";
    }
  } else {
    if (provenance?.studyProduct !== "driven_response") {
      return "Active analysis overlay source does not match its driven study product.";
    }
    if (!Number.isInteger(overlay.frequencyIndex) || !Number.isFinite(overlay.frequencyHz)) {
      return "Active analysis overlay frequency sample identity is incomplete.";
    }
  }

  const kContextKind = provenance?.kContextKind;
  if (!kContextKind) return "Active analysis overlay k-sampling kind is missing.";
  if (kContextKind === "finite_open") return null;
  if (kContextKind === "gamma") {
    return finiteVector3(overlay.wavevectorKf) && nonzeroVector(overlay.wavevectorKf)
      ? "Active analysis overlay gamma identity has a nonzero wavevector."
      : null;
  }
  if (!finiteVector3(overlay.wavevectorKf)) {
    return "Active analysis overlay exact wavevector identity is missing.";
  }
  if (kContextKind === "fixed_k") {
    return nonzeroVector(overlay.wavevectorKf)
      ? null
      : "Active analysis overlay fixed-k identity has a zero wavevector.";
  }
  if (!Number.isInteger(overlay.sampleIndex)) {
    return `Active analysis overlay ${kContextKind} sample index is missing.`;
  }
  if (kContextKind === "k_path" && !Number.isFinite(overlay.kPathCoordinateRadPerM)) {
    return "Active analysis overlay k-path coordinate is missing.";
  }
  return null;
}

function analysisFieldOverlayContextSnapshot(
  overlay: AnalysisFieldOverlayState | null,
  resultRunId: string | null,
): AnalysisFieldOverlayContextSnapshot {
  if (!overlay) {
    return { overlay: null, reason: null, resultRunId, status: "inactive" };
  }
  const identityIssue = overlayOwnerIdentityIssue(overlay);
  if (identityIssue) {
    return {
      overlay,
      reason: identityIssue,
      resultRunId,
      status: "unverified",
    };
  }
  if (!resultRunId) {
    return {
      overlay,
      reason: "Result context is unavailable, so the active analysis overlay cannot be verified.",
      resultRunId,
      status: "unverified",
    };
  }
  if (overlay.provenance?.runId !== resultRunId) {
    return {
      overlay,
      reason: `Active analysis overlay belongs to run ${overlay.provenance?.runId}, not selected run ${resultRunId}.`,
      resultRunId,
      status: "foreign",
    };
  }
  return { overlay, reason: null, resultRunId, status: "compatible" };
}

function numberArrayEquals(
  left: readonly number[] | undefined | null,
  right: readonly number[] | undefined | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((val, index) => val === right[index]);
}

function analysisFieldOverlayStateEquals(
  left: AnalysisFieldOverlayState | null,
  right: AnalysisFieldOverlayState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.fieldId === right.fieldId &&
    (left.frequencyHz ?? null) === (right.frequencyHz ?? null) &&
    (left.frequencyIndex ?? null) === (right.frequencyIndex ?? null) &&
    (left.kPathCoordinateRadPerM ?? null) ===
      (right.kPathCoordinateRadPerM ?? null) &&
    left.label === right.label &&
    (left.modeIndex ?? null) === (right.modeIndex ?? null) &&
    (left.sampleIndex ?? null) === (right.sampleIndex ?? null) &&
    left.source === right.source &&
    (left.visualizationPhaseRad ?? null) ===
      (right.visualizationPhaseRad ?? null) &&
    analysisFieldOverlayAppearanceEquals(left.appearance, right.appearance) &&
    analysisFieldOverlayAnimationEquals(left.animation, right.animation) &&
    fieldVectorQueryEquals(left.query, right.query) &&
    numberArrayEquals(left.wavevectorKf, right.wavevectorKf) &&
    numberArrayEquals(left.cellOrigin, right.cellOrigin) &&
    analysisFieldOverlayProvenanceEquals(left.provenance, right.provenance) &&
    left.floquetSpatialConvention === right.floquetSpatialConvention &&
    left.phasorConvention === right.phasorConvention
  );
}

function analysisFieldOverlayProvenanceEquals(
  left: AnalysisFieldOverlayState["provenance"],
  right: AnalysisFieldOverlayState["provenance"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    (left.artifactRevision ?? null) === (right.artifactRevision ?? null) &&
    (left.equilibriumId ?? null) === (right.equilibriumId ?? null) &&
    (left.kContextKind ?? null) === (right.kContextKind ?? null) &&
    (left.normalization ?? null) === (right.normalization ?? null) &&
    (left.observableId ?? null) === (right.observableId ?? null) &&
    (left.representation ?? null) === (right.representation ?? null) &&
    (left.resourceRef ?? null) === (right.resourceRef ?? null) &&
    (left.runId ?? null) === (right.runId ?? null) &&
    (left.stageId ?? null) === (right.stageId ?? null) &&
    (left.studyProduct ?? null) === (right.studyProduct ?? null)
  );
}

function analysisFieldOverlayAppearanceEquals(
  left: AnalysisFieldOverlayAppearanceState | undefined,
  right: AnalysisFieldOverlayAppearanceState | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    (left.geometryScope ?? null) === (right.geometryScope ?? null) &&
    (left.colorRangeMax ?? null) === (right.colorRangeMax ?? null) &&
    (left.colorRangeMin ?? null) === (right.colorRangeMin ?? null) &&
    (left.colorRangeMode ?? null) === (right.colorRangeMode ?? null) &&
    (left.displayGain ?? null) === (right.displayGain ?? null) &&
    (left.scalarColorPalette ?? null) === (right.scalarColorPalette ?? null) &&
    (left.shaderMonoColor ?? null) === (right.shaderMonoColor ?? null) &&
    (left.shaderVisible ?? null) === (right.shaderVisible ?? null) &&
    (left.surfaceColorSource ?? null) === (right.surfaceColorSource ?? null) &&
    (left.vectorBudget ?? null) === (right.vectorBudget ?? null) &&
    (left.vectorScale ?? null) === (right.vectorScale ?? null) &&
    (left.vectorsVisible ?? null) === (right.vectorsVisible ?? null)
  );
}

function analysisFieldOverlayAnimationEquals(
  left: AnalysisFieldOverlayAnimationState | undefined,
  right: AnalysisFieldOverlayAnimationState | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.animatePhase === right.animatePhase &&
    left.animationRateHz === right.animationRateHz &&
    (left.direction ?? 1) === (right.direction ?? 1) &&
    (left.loop ?? true) === (right.loop ?? true)
  );
}

function fieldVectorQueryEquals(
  left: FieldVectorQuery,
  right: FieldVectorQuery,
): boolean {
  return (
    (left.component ?? null) === (right.component ?? null) &&
    (left.max_samples ?? null) === (right.max_samples ?? null) &&
    (left.phase_rad ?? null) === (right.phase_rad ?? null) &&
    (left.scope_id ?? null) === (right.scope_id ?? null) &&
    (left.scope_kind ?? null) === (right.scope_kind ?? null) &&
    (left.snapshot_id ?? null) === (right.snapshot_id ?? null) &&
    (left.view ?? null) === (right.view ?? null)
  );
}

export function useAnalysisFieldOverlay(
  controller: AnalysisFieldOverlayController,
): AnalysisFieldOverlayState | null {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => null,
  );
}

const EMPTY_ANALYSIS_FIELD_OVERLAY_CONTEXT: AnalysisFieldOverlayContextSnapshot = {
  overlay: null,
  reason: null,
  resultRunId: null,
  status: "inactive",
};

export function useAnalysisFieldOverlayContext(
  controller: AnalysisFieldOverlayController,
): AnalysisFieldOverlayContextSnapshot {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getContextSnapshot(),
    () => EMPTY_ANALYSIS_FIELD_OVERLAY_CONTEXT,
  );
}

export function useRenderableAnalysisFieldOverlay(
  controller: AnalysisFieldOverlayController,
): AnalysisFieldOverlayState | null {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getRenderableSnapshot(),
    () => null,
  );
}
