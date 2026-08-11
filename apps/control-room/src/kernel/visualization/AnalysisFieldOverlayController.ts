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

interface AnalysisFieldOverlayAnimationState {
  animatePhase: boolean;
  animationRateHz: number;
  direction?: -1 | 1;
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
  label: string;
  query: FieldVectorQuery;
  source: AnalysisFieldOverlaySource;
  visualizationPhaseRad?: number;
  wavevectorKf?: [number, number, number];
  cellOrigin?: [number, number, number];
  floquetSpatialConvention?: FloquetSpatialConvention;
  phasorConvention?: PhasorConvention;
}

type AnalysisFieldOverlayListener = () => void;

export class AnalysisFieldOverlayController {
  private snapshot: AnalysisFieldOverlayState | null = null;
  private readonly listeners = new Set<AnalysisFieldOverlayListener>();

  getSnapshot(): AnalysisFieldOverlayState | null {
    return this.snapshot;
  }

  set(next: AnalysisFieldOverlayState): void {
    if (analysisFieldOverlayStateEquals(this.snapshot, next)) {
      return;
    }
    this.snapshot = {
      ...next,
      ...(next.appearance ? { appearance: { ...next.appearance } } : {}),
      ...(next.animation ? { animation: { ...next.animation } } : {}),
      query: { ...next.query },
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

  subscribe(listener: AnalysisFieldOverlayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
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
    left.label === right.label &&
    left.source === right.source &&
    (left.visualizationPhaseRad ?? null) ===
      (right.visualizationPhaseRad ?? null) &&
    analysisFieldOverlayAppearanceEquals(left.appearance, right.appearance) &&
    analysisFieldOverlayAnimationEquals(left.animation, right.animation) &&
    fieldVectorQueryEquals(left.query, right.query) &&
    numberArrayEquals(left.wavevectorKf, right.wavevectorKf) &&
    numberArrayEquals(left.cellOrigin, right.cellOrigin) &&
    left.floquetSpatialConvention === right.floquetSpatialConvention &&
    left.phasorConvention === right.phasorConvention
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
    (left.direction ?? 1) === (right.direction ?? 1)
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
