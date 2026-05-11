"use client";

import { Html } from "@react-three/drei";
import type { ThreeEvent } from "@react-three/fiber";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import type {
  Viewport3DPrimitiveObject,
  Viewport3DPrimitiveRenderModel,
} from "../viewport3dPrimitiveModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import { opacityFromSettings } from "./viewport3DLayerSettings";

export function PrimitiveObjectLayer({
  colors,
  getObjectSettings,
  onSelectObject,
  primitiveModel,
}: {
  colors: Viewport3DColors;
  getObjectSettings: (object: Viewport3DPrimitiveObject) => VisualizationTargetSettings;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  primitiveModel: Viewport3DPrimitiveRenderModel | null;
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
}: {
  colors: Viewport3DColors;
  object: Viewport3DPrimitiveObject;
  onSelectObject: (object: Viewport3DPrimitiveObject) => void;
  settings: VisualizationTargetSettings;
}) {
  if (!settings.visible) return null;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectObject(object);
  };
  const opacity = opacityFromSettings(settings);

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
        <mesh>
          <PrimitiveGeometry object={object} />
          <meshStandardMaterial
            color={colors.mesh}
            opacity={Math.min(opacity, 0.58)}
            roughness={0.78}
            transparent
          />
        </mesh>
      ) : null}
      {settings.wireframeVisible ? (
        <mesh>
          <PrimitiveGeometry object={object} />
          <meshBasicMaterial
            color={colors.wire}
            opacity={Math.max(opacity, 0.68)}
            transparent
            wireframe
          />
        </mesh>
      ) : null}
      <Html center distanceFactor={8} position={[0, object.bounds.size[1] / 2, 0]}>
        <span className="fm-viewport-3d__primitive-label">
          {object.fallbackLabel}
        </span>
      </Html>
    </group>
  );
}

function PrimitiveGeometry({ object }: { object: Viewport3DPrimitiveObject }) {
  const [x, y, z] = object.bounds.size;
  if (object.kind === "sphere") {
    return <sphereGeometry args={[Math.max(x, y, z) / 2, 32, 16]} />;
  }
  if (object.kind === "cylinder") {
    return <cylinderGeometry args={[x / 2, x / 2, y, 32, 1]} />;
  }
  return <boxGeometry args={[x, y, z]} />;
}
