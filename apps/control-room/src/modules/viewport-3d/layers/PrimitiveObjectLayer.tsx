"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  SphereGeometry,
} from "three";
import {
  RENDER_POLICIES,
  materialPolicyProps,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { buildSurfaceEdgeGeometryFromBufferGeometry } from "../viewport3dSurfaceEdges";
import { buildViewport3DPrimitiveFrameKey } from "../viewport3dPrimitiveModel";
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import {
  opacityFromSettings,
  shaderColorFromSettings,
  wireframeColorFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";

export function trackPrimitiveObjectGeometry(
  tracker: Viewport3DResourceTracker,
  object: Viewport3DPrimitiveObject,
): BufferGeometry {
  return tracker.track("geometry", createPrimitiveObjectGeometry(object));
}

export function releasePrimitiveObjectGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry,
): void {
  tracker.release("geometry", geometry);
}

export function PrimitiveObjectLayer({
  colors,
  getObjectSettings,
  materialProfile,
  onSelectObject,
  primitiveModel,
  tracker,
}: {
  colors: Viewport3DColors;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  materialProfile: Viewport3DMaterialProfile;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate();
  const primitiveFrameKey = buildViewport3DPrimitiveFrameKey(primitiveModel);

  useEffect(() => {
    tracker.recordDirtyFrame("primitive-geometry");
    invalidate();
  }, [invalidate, primitiveFrameKey, tracker]);

  if (!primitiveModel?.objects.length) return null;

  return (
    <>
      {primitiveModel.objects.map((object) => (
        <PrimitiveObject
          colors={colors}
          key={object.geometryKey}
          object={object}
          onSelectObject={onSelectObject}
          materialProfile={materialProfile}
          settings={getObjectSettings(object)}
          tracker={tracker}
        />
      ))}
    </>
  );
}

function PrimitiveObject({
  colors,
  object,
  materialProfile,
  onSelectObject,
  settings,
  tracker,
}: {
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
  object: Viewport3DPrimitiveObject;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  settings: VisualizationTargetSettings;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(
    () => trackPrimitiveObjectGeometry(tracker, object),
    [object, tracker],
  );

  useEffect(
    () => () => releasePrimitiveObjectGeometry(tracker, geometry),
    [geometry, tracker],
  );
  const edgeGeometry = useMemo(() => {
    const next = buildSurfaceEdgeGeometryFromBufferGeometry(geometry);
    return next ? tracker.track("geometry", next) : null;
  }, [geometry, tracker]);

  useEffect(
    () => () => tracker.release("geometry", edgeGeometry),
    [edgeGeometry, tracker],
  );

  if (!settings.visible) return null;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectObject(object);
  };
  const opacity = opacityFromSettings(settings);
  const shaderColor = shaderColorFromSettings(
    settings,
    (settings.surfaceColorSource !== "solid"
      ? object.magnetizationTexturePreview?.color
      : null) ?? colors.mesh,
  );

  return (
    <group
      onPointerDown={handlePointerDown}
      position={object.bounds.center}
      userData={{
        fallbackLabel: object.fallbackLabel,
        objectId: object.objectId,
        primitive: true,
      }}
    >
      {settings.shaderVisible ? (
        <mesh
          renderOrder={surfaceMaterialPolicyProps(opacity).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          <primitive attach="geometry" object={geometry} />
          <meshStandardMaterial
            color={shaderColor}
            opacity={opacity}
            {...materialProfile.primitivePreview}
            {...surfaceMaterialPolicyProps(opacity)}
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible && edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <lineBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(
              settings,
              materialProfile.featureEdges,
            )}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
      {settings.boundsVisible ? (
        <mesh>
          <boxGeometry
            args={[
              Math.max(object.bounds.size[0], 1e-9),
              Math.max(object.bounds.size[1], 1e-9),
              Math.max(object.bounds.size[2], 1e-9),
            ]}
          />
          <meshBasicMaterial
            color={colors.accent}
            opacity={Math.max(opacity, 0.35)}
            transparent
            wireframe
          />
        </mesh>
      ) : null}
    </group>
  );
}

export function createPrimitiveObjectGeometry(
  object: Viewport3DPrimitiveObject,
): BufferGeometry {
  const [x, y, z] = object.bounds.size;
  if (object.kind === "sphere") {
    return new SphereGeometry(Math.max(x, y, z) / 2, 32, 16);
  }
  if (object.kind === "cylinder") {
    return new CylinderGeometry(x / 2, x / 2, y, 32, 1);
  }
  return new BoxGeometry(x, y, z);
}
