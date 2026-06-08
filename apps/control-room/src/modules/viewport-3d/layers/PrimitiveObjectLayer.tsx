"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferAttribute, BufferGeometry, SphereGeometry } from "three";
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
import {
  buildPrimitiveTransformGizmoSegments,
  releasePrimitiveObjectGeometry,
  shouldRenderPrimitiveObject,
  shouldRenderPrimitiveTransformGizmo,
  trackPrimitiveObjectGeometry,
} from "./PrimitiveObjectLayerModel";
import { eventIntersectsRegionOverlay } from "./regionOverlayPicking";

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

  if (!shouldRenderPrimitiveObject(object, settings)) return null;


  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
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
          onPointerDown={handlePointerDown}
          renderOrder={surfaceMaterialPolicyProps(opacity).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
          userData={{
            fallbackLabel: object.fallbackLabel,
            objectId: object.objectId,
            primitive: true,
          }}
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
          onPointerDown={handlePointerDown}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
          userData={{
            fallbackLabel: object.fallbackLabel,
            objectId: object.objectId,
            primitive: true,
          }}
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
        <mesh
          onPointerDown={handlePointerDown}
          userData={{
            fallbackLabel: object.fallbackLabel,
            objectId: object.objectId,
            primitive: true,
          }}
        >
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
      {shouldRenderPrimitiveTransformGizmo(settings) ? (
        <PrimitiveObjectGizmo
          colors={colors}
          materialProfile={materialProfile}
          object={object}
          tracker={tracker}
        />
      ) : null}
    </group>
  );
}

function PrimitiveObjectGizmo({
  colors,
  materialProfile,
  object,
  tracker,
}: {
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
  object: Viewport3DPrimitiveObject;
  tracker: Viewport3DResourceTracker;
}) {
  const axisGeometry = useMemo(() => {
    const next = tracker.track("geometry", new BufferGeometry());
    next.setAttribute(
      "position",
      new BufferAttribute(buildPrimitiveTransformGizmoSegments(object), 3),
    );
    return next;
  }, [object, tracker]);
  const pivotGeometry = useMemo(
    () =>
      object.magnetizationTexturePreview?.pivot
        ? tracker.track("geometry", new SphereGeometry(object.bounds.radius * 0.045, 12, 6))
        : null,
    [object, tracker],
  );

  useEffect(
    () => () => tracker.release("geometry", axisGeometry),
    [axisGeometry, tracker],
  );
  useEffect(
    () => () => tracker.release("geometry", pivotGeometry),
    [pivotGeometry, tracker],
  );

  return (
    <>
      <lineSegments
        geometry={axisGeometry}
        renderOrder={RENDER_POLICIES.selectionShell.renderOrder}
        userData={{ gizmo: "transform", objectId: object.objectId }}
      >
        <lineBasicMaterial
          color={colors.accent}
          depthTest={materialProfile.axes.depthTest}
          depthWrite={materialProfile.axes.depthWrite}
          opacity={materialProfile.axes.opacity}
          toneMapped={materialProfile.axes.toneMapped}
          transparent={materialProfile.axes.opacity < 1}
        />
      </lineSegments>
      {pivotGeometry && object.magnetizationTexturePreview?.pivot ? (
        <mesh
          geometry={pivotGeometry}
          position={object.magnetizationTexturePreview.pivot}
          renderOrder={RENDER_POLICIES.selectionShell.renderOrder}
          userData={{
            gizmo: "texture-pivot",
            objectId: object.objectId,
            textureAssetId: object.magnetizationTexturePreview.assetId,
          }}
        >
          <meshBasicMaterial
            color={object.magnetizationTexturePreview.color}
            depthTest={false}
            depthWrite={false}
            opacity={materialProfile.selectionShell.opacity}
            toneMapped={false}
            transparent
          />
        </mesh>
      ) : null}
    </>
  );
}
