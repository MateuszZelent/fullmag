/**
 * P4 — Magnetization Domain Model
 *
 * Types for magnetization authoring: asset, draft, realization.
 * ADR-003: Inspector edits draft, Apply commits transaction.
 * ADR-005: Magnetization changes do NOT invalidate mesh topology.
 */

import type { TextureTransform3D } from "@/lib/textureTransform";

// ── Preset kinds ──────────────────────────────────────────────

export type MagneticPresetKind =
  | "uniform"
  | "random_seeded"
  | "vortex"
  | "antivortex"
  | "bloch_skyrmion"
  | "neel_skyrmion"
  | "domain_wall"
  | "helical"
  | "conical"
  | "two_domain"
  | "custom";

// ── Mapping ───────────────────────────────────────────────────

export interface MagnetizationMapping {
  space: "object_local" | "world";
  projection: "object_bounds" | "unit_cube" | "cylindrical";
}

// ── MagnetizationAsset (committed) ────────────────────────────

export interface MagnetizationAsset {
  id: string;
  kind: "uniform" | "random_seeded" | "analytic_texture" | "sampled_field" | "external_dataset";
  presetKind: MagneticPresetKind | null;
  presetParams: Record<string, unknown>;
  mapping: MagnetizationMapping;
  textureTransform: TextureTransform3D;
  seed: number | null;
  uiLabel: string | null;
  semanticRevision: string;
}

// ── MagnetizationDraft (inspector editable) ───────────────────

export interface MagnetizationDraft {
  target: { objectId: string; assetId: string };
  presetKind: MagneticPresetKind;
  presetParams: Record<string, unknown>;
  mapping: MagnetizationMapping;
  textureTransform: TextureTransform3D;
  seed: number | null;
  baseRevision: string;
}

// ── Draft status ──────────────────────────────────────────────

export type MagnetizationDraftStatus = "clean" | "dirty" | "applying" | "error";

// ── MagnetizationRealization ──────────────────────────────────

export interface MagnetizationRealization {
  assetId: string;
  objectId: string;
  semanticRevision: string;
  realizationRevision: string;
  targetTopologyRevision: string | null;
  kind: "procedural_preview" | "sampled_mesh_field" | "sampled_grid_field";
  status: "missing" | "realizing" | "ready" | "error";
  error?: string | null;
  stats?: {
    minNorm: number;
    maxNorm: number;
    average: [number, number, number];
    sampleCount: number;
  };
}

// ── Validation ────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  message?: string;
  normalized?: [number, number, number];
}

export function validateUniformDirection(v: [number, number, number]): ValidationResult {
  const norm = Math.hypot(v[0], v[1], v[2]);
  if (norm < 1e-12) {
    return { ok: false, message: "Direction vector cannot be zero." };
  }
  return {
    ok: true,
    normalized: [v[0] / norm, v[1] / norm, v[2] / norm],
  };
}

export function validateSeed(seed: unknown): ValidationResult {
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 1) {
    return { ok: false, message: "Seed must be an integer ≥ 1." };
  }
  return { ok: true };
}

// ── Draft helpers ─────────────────────────────────────────────

export function isDraftDirty(draft: MagnetizationDraft, committed: MagnetizationAsset): boolean {
  return (
    draft.presetKind !== committed.presetKind ||
    draft.seed !== committed.seed ||
    JSON.stringify(draft.presetParams) !== JSON.stringify(committed.presetParams) ||
    JSON.stringify(draft.mapping) !== JSON.stringify(committed.mapping) ||
    JSON.stringify(draft.textureTransform) !== JSON.stringify(committed.textureTransform)
  );
}

export function createDraftFromAsset(
  objectId: string,
  asset: MagnetizationAsset,
): MagnetizationDraft {
  return {
    target: { objectId, assetId: asset.id },
    presetKind: asset.presetKind ?? "uniform",
    presetParams: { ...asset.presetParams },
    mapping: { ...asset.mapping },
    textureTransform: {
      translation: [...asset.textureTransform.translation] as [number, number, number],
      rotation_quat: [...asset.textureTransform.rotation_quat] as [number, number, number, number],
      scale: [...asset.textureTransform.scale] as [number, number, number],
      pivot: [...asset.textureTransform.pivot] as [number, number, number],
    },
    seed: asset.seed,
    baseRevision: asset.semanticRevision,
  };
}
