/**
 * P3 — Scene Transaction Types
 *
 * Every Inspector Apply or geometry commit creates a SceneTransaction.
 * Transactions carry the invalidation payload and support Undo/Redo.
 */

import type { SelectionTarget } from "./selection";

// ── Transaction kinds ─────────────────────────────────────────

export type SceneTransactionKind =
  | "geometry.object.transform"
  | "geometry.object.parameters"
  | "geometry.boolean"
  | "geometry.airboxSpec"
  | "magnetization.update"
  | "magnetization.transform"
  | "material.update"
  | "mesh.buildFinal"
  | "mesh.buildSelected"
  | "field.realizeInitialState"
  | "study.configure"
  | "study.run";

// ── Invalidation targets ──────────────────────────────────────

export type InvalidationTarget =
  | "geometry"
  | "airbox"
  | "mesh"
  | "initial_state"
  | "results";

// ── Transaction ───────────────────────────────────────────────

export interface SceneTransaction<TPatch = unknown> {
  id: string;
  kind: SceneTransactionKind;
  createdAt: number;
  target: SelectionTarget | null;
  patch: TPatch;
  baseRevision: string;
  invalidates: InvalidationTarget[];
  doesNotInvalidate: InvalidationTarget[];
  selectionAfter?: SelectionTarget | null;
}

// ── Undoable wrapper ──────────────────────────────────────────

export interface UndoableTransaction<TPatch = unknown> {
  transaction: SceneTransaction<TPatch>;
  revertPatch: TPatch;
}

// ── Helper ────────────────────────────────────────────────────

let nextTransactionId = 1;

export function createTransactionId(): string {
  return `tx-${nextTransactionId++}-${Date.now()}`;
}
