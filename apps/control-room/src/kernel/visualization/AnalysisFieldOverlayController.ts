"use client";

import { useSyncExternalStore } from "react";

import type { FieldVectorQuery } from "../api/apiTypes";

export type AnalysisFieldOverlaySource = "eigen-mode" | "frequency-response";

export interface AnalysisFieldOverlayAnimationState {
  animatePhase: boolean;
  animationRateHz: number;
}

export interface AnalysisFieldOverlayState {
  animation?: AnalysisFieldOverlayAnimationState;
  fieldId: string;
  label: string;
  query: FieldVectorQuery;
  source: AnalysisFieldOverlaySource;
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
      animation: next.animation ? { ...next.animation } : undefined,
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
      animation:
        next.animation === undefined
          ? this.snapshot.animation
            ? { ...this.snapshot.animation }
            : undefined
          : { ...next.animation },
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
    analysisFieldOverlayAnimationEquals(left.animation, right.animation) &&
    fieldVectorQueryEquals(left.query, right.query)
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
    left.animationRateHz === right.animationRateHz
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
