/**
 * Scene geometry hook.
 *
 * Computes dynamic bounding box, scene-space texture transforms,
 * camera presets, focus, and screenshot helpers.
 * Extracted from FemMeshView3D.tsx to reduce file size.
 */

import { useMemo, useCallback, useRef, useEffect, type MutableRefObject } from "react";
import * as THREE from "three";
import {
  rotateCameraAroundTarget,
  setCameraPresetAroundTarget,
  focusCameraOnBounds,
} from "../camera/cameraHelpers";
import { exportCanvasAsImage } from "../export/FigureExport";
import type { TextureTransform3D } from "@/lib/textureTransform";
import type { BuilderObjectOverlay, FocusObjectRequest } from "../../runs/control-room/shared";
import type { FemMeshData, RenderLayer } from "./femMeshTypes";

interface UseFemSceneGeometryArgs {
  meshData: FemMeshData;
  hasMeshParts: boolean;
  visibleLayers: RenderLayer[];
  airBoundaryFaceIndices: readonly number[] | null;
  magneticBoundaryFaceIndices: readonly number[] | null;
  shouldRenderAirGeometry: boolean;
  shouldRenderMagneticGeometryResolved: boolean;
  enableBoundsDerivedModel: boolean;
  enableTextureTransformModel: boolean;
  enableCameraFitEffect: boolean;
  enableScreenshotCapture: boolean;
  suppressInitialCameraFit?: boolean;
  activeTextureTransform: TextureTransform3D | null;
  viewportFitSeed?: string | number;
  selectedObjectOverlay: BuilderObjectOverlay | null;
  objectOverlays: BuilderObjectOverlay[];
  focusObjectRequest: FocusObjectRequest | null;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  viewportAxesScope?: "universe" | "object";
  viewCubeSceneRef: MutableRefObject<any>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  qualityProfileRef: MutableRefObject<string>;
  onTextureTransformChange?: (next: TextureTransform3D) => void;
  onTextureTransformCommit?: (next: TextureTransform3D) => void;
  setCameraFitGeneration: React.Dispatch<React.SetStateAction<number>>;
  setCaptureOverlayHidden: React.Dispatch<React.SetStateAction<boolean>>;
  setCaptureActive: React.Dispatch<React.SetStateAction<boolean>>;
  setQualityProfile: React.Dispatch<React.SetStateAction<any>>;
}

export interface FemSceneGeometry {
  dynamicGeomCenter: THREE.Vector3;
  dynamicGeomSize: [number, number, number];
  dynamicMaxDim: number;
  axesWorldExtent: [number, number, number];
  axesCenter: [number, number, number];
  universeWireframeExtent: [number, number, number] | null;
  universeWireframeCenter: [number, number, number];
  sceneMaxDim: number;
  resolvedWorldTextureTransform: TextureTransform3D | null;
  sceneTextureTransform: TextureTransform3D | null;
  handleTextureTransformLiveChange: (next: TextureTransform3D) => void;
  handleTextureTransformCommit: (next: TextureTransform3D) => void;
  setCameraPreset: (view: "reset" | "front" | "top" | "right") => void;
  focusObject: (objectId: string) => void;
  handleViewCubeRotate: (quat: THREE.Quaternion) => void;
  takeScreenshot: () => Promise<void>;
}

export interface SceneFrameBounds {
  extent: [number, number, number];
  center: [number, number, number];
}

export function mergeSceneFrameBounds(
  first: SceneFrameBounds,
  second: SceneFrameBounds,
): SceneFrameBounds {
  const min = first.extent.map((extent, axis) =>
    Math.min(
      first.center[axis] - extent / 2,
      second.center[axis] - second.extent[axis] / 2,
    ),
  ) as [number, number, number];
  const max = first.extent.map((extent, axis) =>
    Math.max(
      first.center[axis] + extent / 2,
      second.center[axis] + second.extent[axis] / 2,
    ),
  ) as [number, number, number];
  return {
    extent: max.map((value, axis) => value - min[axis]) as [number, number, number],
    center: max.map((value, axis) => 0.5 * (value + min[axis])) as [number, number, number],
  };
}

export function resolveDimensionFrameBounds({
  dynamicExtent,
  worldExtent,
  worldCenter,
}: {
  dynamicExtent: [number, number, number];
  worldExtent: [number, number, number] | null;
  worldCenter: [number, number, number];
}): SceneFrameBounds {
  const dynamicFrame: SceneFrameBounds = {
    extent: dynamicExtent.every((value) => Number.isFinite(value) && value > 0)
      ? dynamicExtent
      : [1, 1, 1] as [number, number, number],
    center: [0, 0, 0],
  };
  return worldExtent
    ? mergeSceneFrameBounds(dynamicFrame, { extent: worldExtent, center: worldCenter })
    : dynamicFrame;
}

export function useFemSceneGeometry({
  meshData,
  hasMeshParts,
  visibleLayers,
  airBoundaryFaceIndices,
  magneticBoundaryFaceIndices,
  shouldRenderAirGeometry,
  shouldRenderMagneticGeometryResolved,
  enableBoundsDerivedModel,
  enableTextureTransformModel,
  enableCameraFitEffect,
  enableScreenshotCapture,
  suppressInitialCameraFit = false,
  activeTextureTransform,
  selectedObjectOverlay,
  objectOverlays,
  focusObjectRequest,
  worldExtent = null,
  worldCenter = null,
  viewportAxesScope = "universe",
  viewportFitSeed,
  viewCubeSceneRef,
  canvasRef,
  qualityProfileRef,
  onTextureTransformChange,
  onTextureTransformCommit,
  setCameraFitGeneration,
  setCaptureOverlayHidden,
  setCaptureActive,
  setQualityProfile,
}: UseFemSceneGeometryArgs): FemSceneGeometry {
  // ── Dynamic bounding box ──────────────────────────────────────────
  const { dynamicGeomCenter, dynamicGeomSize, dynamicMaxDim } = useMemo(() => {
    if (!enableBoundsDerivedModel) {
      return {
        dynamicGeomCenter: new THREE.Vector3(0, 0, 0),
        dynamicGeomSize: [1, 1, 1] as [number, number, number],
        dynamicMaxDim: 1,
      };
    }
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;

    const tryAddFaceIndices = (indices: readonly number[] | null) => {
      if (!indices || indices.length === 0) return;
      const count = Math.floor(meshData.boundaryFaces.length / 3);
      for (const idx of indices) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
        const base = idx * 3;
        const faceNodes = [
          meshData.boundaryFaces[base],
          meshData.boundaryFaces[base + 1],
          meshData.boundaryFaces[base + 2],
        ];
        for (const ni of faceNodes) {
          const nBase = ni * 3;
          const px = meshData.nodes[nBase],
            py = meshData.nodes[nBase + 1],
            pz = meshData.nodes[nBase + 2];
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          if (pz < minZ) minZ = pz;
          if (pz > maxZ) maxZ = pz;
        }
      }
    };

    if (hasMeshParts) {
      for (const layer of visibleLayers) {
        if (layer.surfaceFaces && layer.surfaceFaces.length > 0) {
          for (const face of layer.surfaceFaces) {
            for (let i = 0; i < 3; i++) {
              const nBase = face[i] * 3;
              const px = meshData.nodes[nBase],
                py = meshData.nodes[nBase + 1],
                pz = meshData.nodes[nBase + 2];
              if (px < minX) minX = px;
              if (px > maxX) maxX = px;
              if (py < minY) minY = py;
              if (py > maxY) maxY = py;
              if (pz < minZ) minZ = pz;
              if (pz > maxZ) maxZ = pz;
            }
          }
        } else {
          tryAddFaceIndices(layer.boundaryFaceIndices);
        }
      }
    } else {
      if (shouldRenderAirGeometry) tryAddFaceIndices(airBoundaryFaceIndices);
      if (shouldRenderMagneticGeometryResolved)
        tryAddFaceIndices(magneticBoundaryFaceIndices);
    }

    for (const overlay of objectOverlays) {
      const min = overlay.boundsMin;
      const max = overlay.boundsMax;
      if (
        min.length !== 3 ||
        max.length !== 3 ||
        min.some((value) => !Number.isFinite(value)) ||
        max.some((value) => !Number.isFinite(value))
      ) {
        continue;
      }
      minX = Math.min(minX, min[0]);
      minY = Math.min(minY, min[1]);
      minZ = Math.min(minZ, min[2]);
      maxX = Math.max(maxX, max[0]);
      maxY = Math.max(maxY, max[1]);
      maxZ = Math.max(maxZ, max[2]);
    }

    if (minX === Infinity) {
      minX = 0;
      maxX = 1;
      minY = 0;
      maxY = 1;
      minZ = 0;
      maxZ = 1;
    }
    const sx = maxX - minX,
      sy = maxY - minY,
      sz = maxZ - minZ;
    return {
      dynamicGeomCenter: new THREE.Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
      ),
      dynamicGeomSize: [sx, sy, sz] as [number, number, number],
      dynamicMaxDim: Math.max(sx, sy, sz),
    };
  }, [
    airBoundaryFaceIndices,
    enableBoundsDerivedModel,
    hasMeshParts,
    magneticBoundaryFaceIndices,
    meshData.boundaryFaces,
    meshData.nodes,
    objectOverlays,
    shouldRenderAirGeometry,
    shouldRenderMagneticGeometryResolved,
    visibleLayers,
  ]);

  // ── Texture transform resolution ─────────────────────────────────
  const resolvedWorldTextureTransform = useMemo(() => {
    if (!activeTextureTransform) {
      return null;
    }
    const transform: TextureTransform3D = {
      translation: [...activeTextureTransform.translation] as [number, number, number],
      rotation_quat: [...activeTextureTransform.rotation_quat] as [
        number,
        number,
        number,
        number,
      ],
      scale: [...activeTextureTransform.scale] as [number, number, number],
      pivot: [...activeTextureTransform.pivot] as [number, number, number],
    };
    const isDefaultTranslation = transform.translation.every(
      (value) => Math.abs(value) < 1e-18,
    );
    if (!selectedObjectOverlay || !isDefaultTranslation) {
      return transform;
    }
    const boundsCenter: [number, number, number] = [
      0.5 * (selectedObjectOverlay.boundsMin[0] + selectedObjectOverlay.boundsMax[0]),
      0.5 * (selectedObjectOverlay.boundsMin[1] + selectedObjectOverlay.boundsMax[1]),
      0.5 * (selectedObjectOverlay.boundsMin[2] + selectedObjectOverlay.boundsMax[2]),
    ];
    return {
      ...transform,
      translation: boundsCenter,
      pivot: [...transform.pivot] as [number, number, number],
    };
  }, [activeTextureTransform, selectedObjectOverlay]);

  const sceneTextureTransform = useMemo(() => {
    if (!enableTextureTransformModel) {
      return null;
    }
    if (!resolvedWorldTextureTransform) {
      return null;
    }
    return {
      translation: [
        resolvedWorldTextureTransform.translation[0] - dynamicGeomCenter.x,
        resolvedWorldTextureTransform.translation[1] - dynamicGeomCenter.y,
        resolvedWorldTextureTransform.translation[2] - dynamicGeomCenter.z,
      ] as [number, number, number],
      rotation_quat: [...resolvedWorldTextureTransform.rotation_quat] as [
        number,
        number,
        number,
        number,
      ],
      scale: [...resolvedWorldTextureTransform.scale] as [number, number, number],
      pivot: [
        resolvedWorldTextureTransform.pivot[0] - dynamicGeomCenter.x,
        resolvedWorldTextureTransform.pivot[1] - dynamicGeomCenter.y,
        resolvedWorldTextureTransform.pivot[2] - dynamicGeomCenter.z,
      ] as [number, number, number],
    } as TextureTransform3D;
  }, [
    dynamicGeomCenter.x,
    dynamicGeomCenter.y,
    dynamicGeomCenter.z,
    enableTextureTransformModel,
    resolvedWorldTextureTransform,
  ]);

  // ── Texture transform callbacks ───────────────────────────────────
  const handleTextureTransformLiveChange = useCallback(
    (next: TextureTransform3D) => {
      if (!onTextureTransformChange) {
        return;
      }
      onTextureTransformChange({
        translation: [
          next.translation[0] + dynamicGeomCenter.x,
          next.translation[1] + dynamicGeomCenter.y,
          next.translation[2] + dynamicGeomCenter.z,
        ] as [number, number, number],
        rotation_quat: [...next.rotation_quat] as [number, number, number, number],
        scale: [...next.scale] as [number, number, number],
        pivot: [
          next.pivot[0] + dynamicGeomCenter.x,
          next.pivot[1] + dynamicGeomCenter.y,
          next.pivot[2] + dynamicGeomCenter.z,
        ] as [number, number, number],
      });
    },
    [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z, onTextureTransformChange],
  );

  const handleTextureTransformCommit = useCallback(
    (next: TextureTransform3D) => {
      if (!onTextureTransformCommit) {
        return;
      }
      onTextureTransformCommit({
        translation: [
          next.translation[0] + dynamicGeomCenter.x,
          next.translation[1] + dynamicGeomCenter.y,
          next.translation[2] + dynamicGeomCenter.z,
        ] as [number, number, number],
        rotation_quat: [...next.rotation_quat] as [number, number, number, number],
        scale: [...next.scale] as [number, number, number],
        pivot: [
          next.pivot[0] + dynamicGeomCenter.x,
          next.pivot[1] + dynamicGeomCenter.y,
          next.pivot[2] + dynamicGeomCenter.z,
        ] as [number, number, number],
      });
    },
    [dynamicGeomCenter.x, dynamicGeomCenter.y, dynamicGeomCenter.z, onTextureTransformCommit],
  );

  // ── Camera fit effect ─────────────────────────────────────────────
  const lastFittedGeomRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enableCameraFitEffect) {
      return;
    }
    const fitSeed = viewportFitSeed == null ? null : String(viewportFitSeed);
    const sig = fitSeed
      ?? `${dynamicMaxDim.toFixed(6)}_${dynamicGeomCenter.x.toFixed(6)}_${dynamicGeomCenter.y.toFixed(6)}_${dynamicGeomCenter.z.toFixed(6)}`;
    if (lastFittedGeomRef.current === null && suppressInitialCameraFit) {
      lastFittedGeomRef.current = sig;
      return;
    }
    if (lastFittedGeomRef.current !== sig) {
      lastFittedGeomRef.current = sig;
      setCameraFitGeneration((g) => g + 1);
    }
  }, [
    dynamicMaxDim,
    dynamicGeomCenter,
    enableCameraFitEffect,
    suppressInitialCameraFit,
    setCameraFitGeneration,
    viewportFitSeed,
  ]);

  // ── Derived scene constants ───────────────────────────────────────
  const hasUniverseExtent =
    Array.isArray(worldExtent) &&
    worldExtent.every((value) => Number.isFinite(value) && value > 0);
  const worldFrameExtent = hasUniverseExtent
    ? [...worldExtent] as [number, number, number]
    : null;
  const worldFrameCenter = hasUniverseExtent
    ? [
        (worldCenter?.[0] ?? 0) - dynamicGeomCenter.x,
        (worldCenter?.[1] ?? 0) - dynamicGeomCenter.y,
        (worldCenter?.[2] ?? 0) - dynamicGeomCenter.z,
      ] as [number, number, number]
    : [0, 0, 0] as [number, number, number];
  const dynamicFrameExtent =
    dynamicGeomSize.every((value) => Number.isFinite(value) && value > 0)
      ? dynamicGeomSize
      : [1, 1, 1] as [number, number, number];
  const dimensionFrame = resolveDimensionFrameBounds({
    dynamicExtent: dynamicFrameExtent,
    worldExtent: worldFrameExtent,
    worldCenter: worldFrameCenter,
  });
  const universeWireframeExtent = dimensionFrame.extent;
  const universeWireframeCenter = dimensionFrame.center;
  const selectedObjectAxes = selectedObjectOverlay
    ? {
        extent: [
          selectedObjectOverlay.boundsMax[0] - selectedObjectOverlay.boundsMin[0],
          selectedObjectOverlay.boundsMax[1] - selectedObjectOverlay.boundsMin[1],
          selectedObjectOverlay.boundsMax[2] - selectedObjectOverlay.boundsMin[2],
        ] as [number, number, number],
        center: [
          0.5 * (selectedObjectOverlay.boundsMin[0] + selectedObjectOverlay.boundsMax[0]) - dynamicGeomCenter.x,
          0.5 * (selectedObjectOverlay.boundsMin[1] + selectedObjectOverlay.boundsMax[1]) - dynamicGeomCenter.y,
          0.5 * (selectedObjectOverlay.boundsMin[2] + selectedObjectOverlay.boundsMax[2]) - dynamicGeomCenter.z,
        ] as [number, number, number],
      }
    : null;
  const axesWorldExtent =
    viewportAxesScope === "object" && selectedObjectAxes?.extent.every((value) => value > 0)
      ? selectedObjectAxes.extent
      : universeWireframeExtent;
  const axesCenter =
    viewportAxesScope === "object" && selectedObjectAxes?.extent.every((value) => value > 0)
      ? selectedObjectAxes.center
      : universeWireframeCenter;
  const sceneMaxDim = dynamicMaxDim;

  // ── Camera presets ────────────────────────────────────────────────
  const setCameraPreset = useCallback(
    (view: "reset" | "front" | "top" | "right") => {
      const bridge = viewCubeSceneRef.current;
      if (!bridge?.camera || !bridge?.controls) return;
      setCameraPresetAroundTarget(bridge.camera, bridge.controls, view, sceneMaxDim * 2);
    },
    [sceneMaxDim, viewCubeSceneRef],
  );

  const focusObject = useCallback(
    (objectId: string) => {
      const overlay = objectOverlays.find((candidate) => candidate.id === objectId);
      const bridge = viewCubeSceneRef.current;
      if (!overlay || !bridge?.camera || !bridge?.controls) return;
      focusCameraOnBounds(
        bridge.camera,
        bridge.controls,
        {
          min: [
            overlay.boundsMin[0] - dynamicGeomCenter.x,
            overlay.boundsMin[1] - dynamicGeomCenter.y,
            overlay.boundsMin[2] - dynamicGeomCenter.z,
          ],
          max: [
            overlay.boundsMax[0] - dynamicGeomCenter.x,
            overlay.boundsMax[1] - dynamicGeomCenter.y,
            overlay.boundsMax[2] - dynamicGeomCenter.z,
          ],
        },
        { fallbackMinRadius: sceneMaxDim * 0.05 },
      );
    },
    [dynamicGeomCenter, objectOverlays, sceneMaxDim, viewCubeSceneRef],
  );

  useEffect(() => {
    if (!focusObjectRequest) {
      return;
    }
    focusObject(focusObjectRequest.objectId);
  }, [focusObject, focusObjectRequest]);

  const handleViewCubeRotate = useCallback(
    (quat: THREE.Quaternion) => {
      const bridge = viewCubeSceneRef.current;
      if (!bridge?.camera || !bridge?.controls) return;
      rotateCameraAroundTarget(bridge.camera, bridge.controls, quat);
    },
    [viewCubeSceneRef],
  );

  // ── Screenshot ────────────────────────────────────────────────────
  const takeScreenshot = useCallback(async () => {
    if (!enableScreenshotCapture) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const previousProfile = qualityProfileRef.current;
    setCaptureOverlayHidden(true);
    setCaptureActive(true);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    exportCanvasAsImage(canvas, `fem-mesh-${Date.now()}`, {
      pixelRatio: 4,
      backgroundColor: "#171726",
      format: "png",
    });
    setCaptureActive(false);
    setQualityProfile(previousProfile);
    setCaptureOverlayHidden(false);
  }, [
    canvasRef,
    enableScreenshotCapture,
    qualityProfileRef,
    setCaptureActive,
    setCaptureOverlayHidden,
    setQualityProfile,
  ]);

  return {
    dynamicGeomCenter,
    dynamicGeomSize,
    dynamicMaxDim,
    axesWorldExtent,
    axesCenter,
    universeWireframeExtent,
    universeWireframeCenter,
    sceneMaxDim,
    resolvedWorldTextureTransform,
    sceneTextureTransform,
    handleTextureTransformLiveChange,
    handleTextureTransformCommit,
    setCameraPreset,
    focusObject,
    handleViewCubeRotate,
    takeScreenshot,
  };
}
