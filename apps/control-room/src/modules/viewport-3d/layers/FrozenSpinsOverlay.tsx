"use client";

import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  type ColorRepresentation,
} from "three";

import type {
  DecodedFrozenSpinsMask,
} from "@/kernel/resources/frozenSpinsResources";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

const MAX_FROZEN_SPINS_OVERLAY_POINTS = 50_000;

export interface FrozenSpinsOverlayModel {
  carrierKind: "fdm-cells" | "fem-local-nodes";
  current: boolean;
  frozenCount: number;
  maskSha256: string;
  positions: Float32Array;
  previewId: string;
  renderedCount: number;
  totalCount: number;
}

export interface FemLocalNodeRenderCarrier {
  schemaVersion: "fullmag.fem-local-node-render.v1";
  carrierFingerprint: string;
  meshFingerprint: string;
  feSpaceOrder: number;
  vectorOrdering: "by_nodes" | "by_vdim";
  localNodeCount: number;
  renderVertexPositions: Float32Array | Float64Array;
}

export function buildFrozenSpinsOverlayModel({
  fdmDomain,
  femCarrier,
  expectedTopologyFingerprint,
  current,
  mask,
  previewId,
}: {
  fdmDomain: FdmGridRenderDomain | null | undefined;
  femCarrier: FemLocalNodeRenderCarrier | null | undefined;
  expectedTopologyFingerprint: string | null | undefined;
  current: boolean;
  mask: DecodedFrozenSpinsMask | null | undefined;
  previewId: string;
}): FrozenSpinsOverlayModel | null {
  if (!mask || !previewId) return null;
  const frozenIndices = sampleFrozenIndices(
    mask.frozenIndices,
    MAX_FROZEN_SPINS_OVERLAY_POINTS,
  );

  if (fdmDomain && mask.bitCount === fdmDomain.totalCells) {
    return {
      carrierKind: "fdm-cells",
      current,
      frozenCount: mask.frozenIndices.length,
      maskSha256: mask.maskSha256,
      positions: fdmCellCenters(fdmDomain, frozenIndices),
      previewId,
      renderedCount: frozenIndices.length,
      totalCount: mask.bitCount,
    };
  }

  const femPositions = femCarrier
    ? frozenFemRenderPositions(
        femCarrier,
        frozenIndices,
        mask.bitCount,
        expectedTopologyFingerprint,
      )
    : null;
  if (femPositions) {
    return {
      carrierKind: "fem-local-nodes",
      current,
      frozenCount: mask.frozenIndices.length,
      maskSha256: mask.maskSha256,
      positions: femPositions,
      previewId,
      renderedCount: femPositions.length / 3,
      totalCount: mask.bitCount,
    };
  }

  return null;
}

export function FrozenSpinsOverlay({
  color,
  model,
  tracker,
}: {
  color: ColorRepresentation;
  model: FrozenSpinsOverlayModel;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate("frozen-spins-overlay");
  const resources = useMemo(
    () => createFrozenSpinsOverlayResources(model.positions, color),
    [color, model.positions],
  );
  const { geometry, material } = resources;

  useEffect(() => {
    tracker.track("geometry", geometry, {
      byteLength: model.positions.byteLength,
      label: "Frozen Spins overlay positions",
      owner: `frozen-spins:${model.previewId}`,
    });
    tracker.track("material", material, {
      label: "Frozen Spins overlay material",
      owner: `frozen-spins:${model.previewId}`,
    });
    tracker.recordDirtyFrame("frozen-spins-overlay");
    invalidate();
    return () => {
      tracker.release("geometry", geometry, "frozen-spins-overlay-cleanup");
      tracker.release("material", material, "frozen-spins-overlay-cleanup");
      tracker.recordDirtyFrame("frozen-spins-overlay-cleanup");
      invalidate();
    };
  }, [geometry, invalidate, material, model.positions.byteLength, model.previewId, tracker]);

  return (
    <points
      frustumCulled
      geometry={geometry}
      material={material}
      renderOrder={120}
      userData={{
        carrierKind: model.carrierKind,
        previewId: model.previewId,
      }}
    />
  );
}

export function createFrozenSpinsOverlayResources(
  positions: Float32Array,
  color: ColorRepresentation,
): { geometry: BufferGeometry; material: PointsMaterial } {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return {
    geometry,
    material: new PointsMaterial({
      color,
      depthTest: false,
      opacity: 0.95,
      size: 5,
      sizeAttenuation: false,
      transparent: true,
    }),
  };
}

function sampleFrozenIndices(
  indices: Uint32Array,
  limit: number,
): Uint32Array {
  if (indices.length <= limit) return indices;
  const sampled = new Uint32Array(limit);
  for (let output = 0; output < limit; output += 1) {
    sampled[output] = indices[Math.floor((output * indices.length) / limit)]!;
  }
  return sampled;
}

function fdmCellCenters(
  domain: FdmGridRenderDomain,
  indices: Uint32Array,
): Float32Array {
  const [nx, ny] = domain.shape;
  const positions = new Float32Array(indices.length * 3);
  for (let output = 0; output < indices.length; output += 1) {
    const ordinal = indices[output]!;
    const ix = ordinal % nx;
    const iy = Math.floor(ordinal / nx) % ny;
    const iz = Math.floor(ordinal / (nx * ny));
    positions[output * 3] = domain.origin[0] + (ix + 0.5) * domain.spacing[0];
    positions[output * 3 + 1] = domain.origin[1] + (iy + 0.5) * domain.spacing[1];
    positions[output * 3 + 2] = domain.origin[2] + (iz + 0.5) * domain.spacing[2];
  }
  return positions;
}

function frozenFemRenderPositions(
  carrier: FemLocalNodeRenderCarrier,
  frozenLocalNodes: Uint32Array,
  maskLocalNodeCount: number,
  expectedTopologyFingerprint: string | null | undefined,
): Float32Array | null {
  if (
    carrier.schemaVersion !== "fullmag.fem-local-node-render.v1" ||
    !isCanonicalFingerprint(carrier.carrierFingerprint) ||
    !isCanonicalFingerprint(carrier.meshFingerprint) ||
    !isCanonicalFingerprint(expectedTopologyFingerprint ?? "") ||
    carrier.meshFingerprint !== expectedTopologyFingerprint ||
    !Number.isInteger(carrier.feSpaceOrder) ||
    carrier.feSpaceOrder < 1 ||
    carrier.localNodeCount !== maskLocalNodeCount ||
    carrier.renderVertexPositions.length !== carrier.localNodeCount * 3
  ) {
    return null;
  }
  if (frozenLocalNodes.some((node) => node >= carrier.localNodeCount)) return null;
  const sampled = sampleFrozenIndices(frozenLocalNodes, MAX_FROZEN_SPINS_OVERLAY_POINTS);
  const selected = new Float32Array(sampled.length * 3);
  for (let output = 0; output < sampled.length; output += 1) {
    const source = sampled[output]! * 3;
    selected[output * 3] = carrier.renderVertexPositions[source]!;
    selected[output * 3 + 1] = carrier.renderVertexPositions[source + 1]!;
    selected[output * 3 + 2] = carrier.renderVertexPositions[source + 2]!;
  }
  return selected;
}

function isCanonicalFingerprint(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
