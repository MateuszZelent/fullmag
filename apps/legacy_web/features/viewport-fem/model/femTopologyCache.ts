/**
 * Layer D – FEM Viewport Engine: Topology Cache
 *
 * Extracted from the huge `useMemo` chains inside FemMeshView3D.
 * Pure functions that build per-part index caches from the raw mesh array.
 * No React, no side effects.
 */

import type { FemMeshPart, FemLiveMeshObjectSegment } from "../../../lib/session/types";

/** Pre-computed index sets for a single mesh part. */
export interface PartRenderData {
  boundaryFaceIndices: number[] | null;
  elementIndices: number[] | null;
  nodeMask: Uint8Array | null;
  surfaceFaces: [number, number, number][] | null;
}

/* ── helpers ──────────────────────────────────────────────────────── */

function uniqueSortedMarkers(markers: readonly number[]): number[] {
  return Array.from(
    new Set(markers.filter((v) => Number.isFinite(v) && v >= 0)),
  ).sort((a, b) => a - b);
}

export function markersForPart(
  part: FemMeshPart,
  elementMarkers: readonly number[] | null | undefined,
): number[] {
  if (!elementMarkers || elementMarkers.length === 0 || part.element_count <= 0) return [];
  const start = Math.max(0, Math.trunc(part.element_start));
  const end = Math.min(elementMarkers.length, start + Math.max(0, Math.trunc(part.element_count)));
  if (start >= end) return [];
  return uniqueSortedMarkers(elementMarkers.slice(start, end));
}

/* ── Part-level ──────────────────────────────────────────────────── */

export function collectPartBoundaryFaceIndices(
  part: FemMeshPart,
  maxFaceCount: number,
): number[] | null {
  if (part.boundary_face_indices.length > 0) {
    return part.boundary_face_indices.filter(
      (i: number) => Number.isInteger(i) && i >= 0 && i < maxFaceCount,
    );
  }
  const start = Math.max(0, Math.trunc(part.boundary_face_start));
  const count = Math.max(0, Math.trunc(part.boundary_face_count));
  const end = Math.min(start + count, maxFaceCount);
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  if (result.length === 0) return [];
  if (result.length >= maxFaceCount) return null;
  return result;
}

export function collectPartElementIndices(
  part: FemMeshPart,
  maxElementCount: number,
): number[] | null {
  const start = Math.max(0, Math.trunc(part.element_start));
  const count = Math.max(0, Math.trunc(part.element_count));
  const end = Math.min(start + count, maxElementCount);
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  if (result.length === 0) return [];
  if (result.length >= maxElementCount) return null;
  return result;
}

export function collectPartNodeMask(
  part: FemMeshPart,
  nNodes: number,
): Uint8Array | null {
  if (part.node_indices.length > 0) {
    const mask = new Uint8Array(nNodes);
    let saw = false;
    for (const idx of part.node_indices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= nNodes) continue;
      mask[idx] = 1;
      saw = true;
    }
    return saw ? mask : null;
  }
  const start = Math.max(0, Math.trunc(part.node_start));
  const count = Math.max(0, Math.trunc(part.node_count));
  const end = Math.min(start + count, nNodes);
  if (start >= end) return null;
  const mask = new Uint8Array(nNodes);
  for (let i = start; i < end; i++) mask[i] = 1;
  return mask;
}

/* ── Segment-level (object_id groups) ──────────────────────────── */

export function collectSegmentBoundaryFaceIndicesByIds(
  segments: readonly FemLiveMeshObjectSegment[],
  maxFaceCount: number,
  ids: ReadonlySet<string>,
): number[] | null {
  if (ids.size === 0) return [];
  const relevant = segments.filter((s) => ids.has(s.object_id));
  if (relevant.length === 0) return [];
  const result: number[] = [];
  for (const seg of relevant) {
    const start = Math.max(0, Math.trunc(seg.boundary_face_start));
    const count = Math.max(0, Math.trunc(seg.boundary_face_count));
    const end = Math.min(start + count, maxFaceCount);
    for (let i = start; i < end; i++) result.push(i);
  }
  if (result.length === 0) return [];
  if (result.length >= maxFaceCount) return null;
  return result;
}

export function collectSegmentElementIndicesByIds(
  segments: readonly FemLiveMeshObjectSegment[],
  maxElementCount: number,
  ids: ReadonlySet<string>,
): number[] | null {
  if (ids.size === 0) return [];
  const relevant = segments.filter((s) => ids.has(s.object_id));
  if (relevant.length === 0) return [];
  const result: number[] = [];
  for (const seg of relevant) {
    const start = Math.max(0, Math.trunc(seg.element_start));
    const count = Math.max(0, Math.trunc(seg.element_count));
    const end = Math.min(start + count, maxElementCount);
    for (let i = start; i < end; i++) result.push(i);
  }
  if (result.length === 0) return [];
  if (result.length >= maxElementCount) return null;
  return result;
}

export function collectSegmentNodeMask(
  segments: readonly FemLiveMeshObjectSegment[],
  nNodes: number,
  ids: ReadonlySet<string>,
): Uint8Array | null {
  if (ids.size === 0) return null;
  const mask = new Uint8Array(nNodes);
  let saw = false;
  for (const seg of segments) {
    if (!ids.has(seg.object_id)) continue;
    const start = Math.max(0, Math.trunc(seg.node_start));
    const count = Math.max(0, Math.trunc(seg.node_count));
    const end = Math.min(start + count, nNodes);
    for (let i = start; i < end; i++) {
      mask[i] = 1;
      saw = true;
    }
  }
  return saw ? mask : null;
}

/* ── Full cache builder ──────────────────────────────────────────── */

export function buildPartRenderDataCache(
  parts: readonly FemMeshPart[],
  boundaryFaceArrayLength: number,
  nElements: number,
  nNodes: number,
): Map<string, PartRenderData> {
  const maxFaceCount = Math.floor(boundaryFaceArrayLength / 3);
  const cache = new Map<string, PartRenderData>();
  for (const part of parts) {
    cache.set(part.id, {
      boundaryFaceIndices: collectPartBoundaryFaceIndices(part, maxFaceCount),
      elementIndices: collectPartElementIndices(part, nElements),
      nodeMask: collectPartNodeMask(part, nNodes),
      surfaceFaces: part.surface_faces.length > 0 ? part.surface_faces : null,
    });
  }
  return cache;
}
