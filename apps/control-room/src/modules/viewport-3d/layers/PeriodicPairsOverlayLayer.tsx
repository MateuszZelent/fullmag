"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type {
  PeriodicOverlayModel,
  PeriodicOverlayPoint,
} from "@/shared/domain/mesh/periodicOverlayModel";

export interface PeriodicPairsOverlayLayerProps {
  readonly model: PeriodicOverlayModel | null;
  readonly tracker?: Viewport3DResourceTracker;
  readonly visible?: boolean;
}

function resolveCssColorToken(token: string): string {
  const match = /^var\((--[-_a-zA-Z0-9]+)\)$/.exec(token);
  if (!match || typeof document === "undefined") return token;
  return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim() || token;
}

function lineGeometry(
  segments: readonly (readonly [PeriodicOverlayPoint, PeriodicOverlayPoint])[],
): BufferGeometry | null {
  if (segments.length === 0) return null;
  const positions = new Float32Array(segments.length * 6);
  segments.forEach(([source, destination], index) => {
    const offset = index * 6;
    positions[offset] = source.x;
    positions[offset + 1] = source.y;
    positions[offset + 2] = source.z;
    positions[offset + 3] = destination.x;
    positions[offset + 4] = destination.y;
    positions[offset + 5] = destination.z;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  return geometry;
}

function triangleEdgeGeometry(
  triangles: readonly (readonly PeriodicOverlayPoint[])[],
): BufferGeometry | null {
  const segments: Array<readonly [PeriodicOverlayPoint, PeriodicOverlayPoint]> = [];
  for (const triangle of triangles) {
    if (triangle.length !== 3) continue;
    const [a, b, c] = triangle;
    if (!a || !b || !c) continue;
    segments.push([a, b], [b, c], [c, a]);
  }
  return lineGeometry(segments);
}

function LineSet({
  color,
  geometry,
  opacity,
}: {
  color: string;
  geometry: BufferGeometry | null;
  opacity: number;
}) {
  useEffect(() => () => geometry?.dispose(), [geometry]);
  if (!geometry) return null;
  return (
    <lineSegments geometry={geometry} renderOrder={20}>
      <lineBasicMaterial
        color={resolveCssColorToken(color)}
        depthTest={false}
        depthWrite={false}
        opacity={opacity}
        transparent
      />
    </lineSegments>
  );
}

export function PeriodicPairsOverlayLayer({
  model,
  visible = true,
}: PeriodicPairsOverlayLayerProps) {
  const facePairGeometry = useMemo(
    () =>
      lineGeometry(
        model?.facePairs.map((pair) => [pair.source, pair.destination] as const) ?? [],
      ),
    [model?.facePairs],
  );
  const nodeLinkGeometry = useMemo(
    () =>
      lineGeometry(
        model?.nodeLinks.map((link) => [link.source, link.destination] as const) ?? [],
      ),
    [model?.nodeLinks],
  );
  const arrowGeometry = useMemo(
    () =>
      lineGeometry(
        model?.arrows.map((arrow) => [arrow.source, arrow.destination] as const) ?? [],
      ),
    [model?.arrows],
  );
  const unpairedGeometry = useMemo(
    () => triangleEdgeGeometry(model?.unpaired.map((face) => face.vertices) ?? []),
    [model?.unpaired],
  );

  if (!visible || !model || model.status !== "valid") return null;
  return (
    <group name="periodic-pairs-overlay">
      <LineSet color="var(--fm-periodic-source)" geometry={facePairGeometry} opacity={0.9} />
      <LineSet color="var(--fm-periodic-node-link)" geometry={nodeLinkGeometry} opacity={0.65} />
      <LineSet color="var(--fm-periodic-translation)" geometry={arrowGeometry} opacity={0.95} />
      <LineSet color="var(--fm-periodic-unpaired)" geometry={unpairedGeometry} opacity={0.95} />
    </group>
  );
}
