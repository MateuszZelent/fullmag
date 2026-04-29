/**
 * Type definitions extracted from FemMeshView3D.tsx.
 * Shared across viewport components.
 */

import type { FemMeshPart, MeshEntityViewState } from "../../../lib/session/types";

export interface RenderLayer {
  part: FemMeshPart;
  viewState: MeshEntityViewState;
  boundaryFaceIndices: number[] | null;
  elementIndices: number[] | null;
  nodeMask: Uint8Array | null;
  surfaceFaces: [number, number, number][] | null;
  isPrimaryForCamera: boolean;
  isMagnetic: boolean;
  isSelected: boolean;
  isDimmed: boolean;
  meshColor: string;
  edgeColor: string;
}

export interface FemMeshData {
  nodes: ArrayLike<number>;
  elements: ArrayLike<number>;
  boundaryFaces: ArrayLike<number>;
  nNodes: number;
  nElements: number;
  fieldData?: { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };
  shaderFieldData?: { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number> };
  fieldNComp?: number;
  fieldRevision?: number | string | null;
  /** Backend-assigned mesh generation id. Used as primary topology cache key. */
  meshGenerationId?: string | null;
  activeMask?: boolean[] | null;
  quantityDomain?: "magnetic_only" | "full_domain" | "surface_only" | null;
}

export interface MeshSelectionSnapshot {
  selectedFaceIndices: number[];
  primaryFaceIndex: number | null;
}

export type FemColorField = "orientation" | "x" | "y" | "z" | "magnitude" | "quality" | "sicn" | "none";
export type FemArrowColorMode = "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
export type ArrowSamplingMode = "auto" | "surface" | "volume";
export type RenderMode = "surface" | "surface+edges" | "wireframe" | "mesh" | "points";
export type ClipAxis = "x" | "y" | "z";
export type FemVectorDomainFilter = "auto" | "magnetic_only" | "full_domain" | "airbox_only";
export type FemFerromagnetVisibilityMode = "hide" | "ghost";
