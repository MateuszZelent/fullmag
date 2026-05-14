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
import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
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
  onSelectObject,
  primitiveModel,
  tracker,
}: {
  colors: Viewport3DColors;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
  tracker: Viewport3DResourceTracker;
}) {
  if (!primitiveModel?.objects.length) return null;

  return (
    <>
      {primitiveModel.objects.map((object) => (
        <PrimitiveObject
          colors={colors}
          key={object.geometryKey}
          object={object}
          onSelectObject={onSelectObject}
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
  onSelectObject,
  settings,
  tracker,
}: {
  colors: Viewport3DColors;
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

  if (!settings.visible) return null;

  // When mesh topology exists but is stale (scene revision mismatch), render
  // the primitive as a wireframe ghost only.  The topology layer still renders
  // the stale mesh surface, so showing a second full transparent primitive
  // surface on top causes surface-mixing artifacts.
  const isStale = object.meshState === "mesh-stale";

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
      {settings.shaderVisible && !isStale ? (
        <mesh
          renderOrder={surfaceMaterialPolicyProps(opacity).transparent
            ? RENDER_POLICIES.contextSurface.renderOrder
            : RENDER_POLICIES.solidSurface.renderOrder}
        >
          <primitive attach="geometry" object={geometry} />
          <meshStandardMaterial
            color={shaderColor}
            opacity={opacity}
            roughness={0.78}
            {...surfaceMaterialPolicyProps(opacity)}
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible ? (
        <mesh
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder}
        >
          <primitive attach="geometry" object={geometry} />
          <meshBasicMaterial
            color={wireframeColorFromSettings(settings, colors.wire)}
            opacity={wireframeOpacityFromSettings(settings)}
            wireframe
            {...materialPolicyProps("featureEdges")}
          />
        </mesh>
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
