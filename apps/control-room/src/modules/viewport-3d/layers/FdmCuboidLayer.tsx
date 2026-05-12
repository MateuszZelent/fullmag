"use client";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  BoxGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";

import type { FdmGridRenderDomain } from "../viewport3dDomainAdapter";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DColors } from "../viewport3dTypes";
import { opacityFromSettings } from "./viewport3DLayerSettings";

interface FdmCuboidInstanceModel {
  cellSize: [number, number, number];
  centers: Float32Array;
  count: number;
}

const IDENTITY_QUATERNION = new Quaternion();
const CELL_VISUAL_FILL = 0.92;

export function buildFdmCuboidInstanceModel(
  domain: FdmGridRenderDomain | null,
): FdmCuboidInstanceModel | null {
  if (!domain || domain.displayCellCount <= 0 || domain.totalCells <= 0) {
    return null;
  }

  const count = Math.min(domain.displayCellCount, domain.totalCells);
  const centers = new Float32Array(count * 3);
  const [nx, ny, nz] = domain.shape;
  const [dx, dy, dz] = domain.spacing;
  const [ox, oy, oz] = domain.origin;
  const gridCells = Math.max(nx * ny * nz, 1);
  const totalCells = Math.min(domain.totalCells, gridCells);

  for (let instance = 0; instance < count; instance += 1) {
    const cellIndex = Math.min(
      totalCells - 1,
      Math.floor((instance * totalCells) / count),
    );
    const ix = cellIndex % nx;
    const iy = Math.floor(cellIndex / nx) % ny;
    const iz = Math.floor(cellIndex / (nx * ny)) % nz;
    const target = instance * 3;

    centers[target] = ox + (ix + 0.5) * dx;
    centers[target + 1] = oy + (iy + 0.5) * dy;
    centers[target + 2] = oz + (iz + 0.5) * dz;
  }

  return {
    cellSize: [
      Math.max(dx * CELL_VISUAL_FILL, 1e-18),
      Math.max(dy * CELL_VISUAL_FILL, 1e-18),
      Math.max(dz * CELL_VISUAL_FILL, 1e-18),
    ],
    centers,
    count,
  };
}

export function FdmCuboidLayer({
  colors,
  domain,
  onSelectDomain,
  settings,
  tracker,
}: {
  colors: Viewport3DColors;
  domain: FdmGridRenderDomain | null;
  onSelectDomain: () => void;
  settings: VisualizationTargetSettings;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const surfaceRef = useRef<InstancedMesh>(null);
  const wireframeRef = useRef<InstancedMesh>(null);
  const model = useMemo(() => buildFdmCuboidInstanceModel(domain), [domain]);
  const geometry = useMemo(
    () => tracker.track("geometry", new BoxGeometry(1, 1, 1)),
    [tracker],
  );
  const surfaceMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: colors.mesh,
          opacity: opacityFromSettings(settings),
          transparent: opacityFromSettings(settings) < 1,
        }),
      ),
    [colors.mesh, settings, tracker],
  );
  const wireframeMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          color: colors.wire,
          opacity: Math.max(opacityFromSettings(settings), 0.42),
          transparent: true,
          wireframe: true,
        }),
      ),
    [colors.wire, settings, tracker],
  );

  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("material", surfaceMaterial),
    [surfaceMaterial, tracker],
  );
  useEffect(
    () => () => tracker.release("material", wireframeMaterial),
    [wireframeMaterial, tracker],
  );

  useEffect(() => {
    if (!model) return;

    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3(...model.cellSize);
    const meshes = [surfaceRef.current, wireframeRef.current].filter(
      (mesh): mesh is InstancedMesh => Boolean(mesh),
    );

    for (const mesh of meshes) {
      for (let index = 0; index < model.count; index += 1) {
        const offset = index * 3;
        position.set(
          model.centers[offset] ?? 0,
          model.centers[offset + 1] ?? 0,
          model.centers[offset + 2] ?? 0,
        );
        matrix.compose(position, IDENTITY_QUATERNION, scale);
        mesh.setMatrixAt(index, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    tracker.recordDirtyFrame("fdm-cuboids");
    invalidate();
  }, [invalidate, model, tracker]);

  if (
    !model ||
    !settings.visible ||
    (!settings.shaderVisible && !settings.wireframeVisible)
  ) {
    return null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectDomain();
  };

  return (
    <group onPointerDown={handlePointerDown}>
      {settings.shaderVisible ? (
        <instancedMesh
          args={[geometry, surfaceMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-surface-${model.count}`}
          ref={surfaceRef}
        />
      ) : null}
      {settings.wireframeVisible ? (
        <instancedMesh
          args={[geometry, wireframeMaterial, model.count]}
          frustumCulled={false}
          key={`fdm-cuboids-wire-${model.count}`}
          ref={wireframeRef}
        />
      ) : null}
    </group>
  );
}
