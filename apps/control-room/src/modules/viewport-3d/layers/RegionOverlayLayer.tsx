"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";
import { Quaternion, Vector3 } from "three";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildRegionOverlayModels,
  type RegionOverlayInput,
  type RegionOverlayModel,
  type RegionOverlayTheme,
} from "./regionOverlayModel";

export interface RegionOverlaySelection {
  objectId: string;
  regionId: string;
}

export interface RegionOverlayLayerProps {
  getRegionSettings?: (region: RegionOverlayInput) => VisualizationTargetSettings;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  regions: readonly RegionOverlayInput[];
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  theme?: RegionOverlayTheme;
  visible?: boolean;
}

const CYLINDER_DEFAULT_AXIS = new Vector3(0, 1, 0);
const MIN_SHAPE_SIZE = 1e-12;
const CSS_VARIABLE_COLOR_PATTERN = /^var\((--[-_a-zA-Z0-9]+)\)$/;

function resolveCssColorToken(color: string): string {
  const match = CSS_VARIABLE_COLOR_PATTERN.exec(color.trim());
  if (!match || typeof document === "undefined") return color;

  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1])
    .trim();
  return resolved || color;
}

export function RegionOverlayLayer({
  getRegionSettings,
  onSelectRegion,
  regions,
  selectedObjectId = null,
  selectedRegionId = null,
  theme = "mocha",
  visible = true,
}: RegionOverlayLayerProps) {
  const models = useMemo(
    () =>
      buildRegionOverlayModels(regions, {
        resolveSettings: getRegionSettings,
        selectedObjectId,
        selectedRegionId,
        theme,
      }),
    [getRegionSettings, regions, selectedObjectId, selectedRegionId, theme],
  );

  if (!visible || models.length === 0) return null;

  return (
    <group name="region-overlays">
      {models.map((model) => (
        <RegionOverlayShape
          key={model.regionId}
          model={model}
          onSelectRegion={onSelectRegion}
        />
      ))}
    </group>
  );
}

function RegionOverlayShape({
  model,
  onSelectRegion,
}: {
  model: RegionOverlayModel;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
}) {
  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };

  const quaternion = useMemo(() => {
    if (model.kind !== "cylinder") return undefined;
    const target = new Vector3(...model.axis).normalize();
    return new Quaternion().setFromUnitVectors(CYLINDER_DEFAULT_AXIS, target);
  }, [model]);
  const ownerQuaternion = useMemo(
    () => new Quaternion(...model.transform.quaternion),
    [model.transform.quaternion],
  );

  const wireframeScale = model.style.wireframeScale;
  const fillColor = resolveCssColorToken(model.style.surfaceColor ?? model.color);
  const wireframeColor = resolveCssColorToken(
    model.style.wireframeColor ?? model.color,
  );

  return (
    <group
      name={`region-overlay:${model.regionId}`}
      position={model.transform.position}
      quaternion={ownerQuaternion}
      scale={model.transform.scale}
    >
      <group
        position={model.center}
        quaternion={quaternion}
      >
        {model.style.fillVisible ? (
          <mesh
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            renderOrder={42}
          >
            <RegionOverlayGeometry model={model} />
            <meshBasicMaterial
              color={fillColor}
              depthTest={false}
              depthWrite={false}
              opacity={model.style.fillOpacity}
              transparent
            />
          </mesh>
        ) : null}
        {model.style.wireframeVisible ? (
          <mesh
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            renderOrder={43}
            scale={[wireframeScale, wireframeScale, wireframeScale]}
          >
            <RegionOverlayGeometry model={model} />
            <meshBasicMaterial
              color={wireframeColor}
              depthTest={false}
              depthWrite={false}
              opacity={model.style.wireframeOpacity}
              transparent
              wireframe
            />
          </mesh>
        ) : null}
      </group>
    </group>
  );
}

function RegionOverlayGeometry({ model }: { model: RegionOverlayModel }) {
  if (model.kind === "box") {
    return (
      <boxGeometry
        args={[
          Math.max(model.size[0], MIN_SHAPE_SIZE),
          Math.max(model.size[1], MIN_SHAPE_SIZE),
          Math.max(model.size[2], MIN_SHAPE_SIZE),
        ]}
      />
    );
  }

  if (model.kind === "cylinder") {
    return (
      <cylinderGeometry
        args={[
          Math.max(model.radius, MIN_SHAPE_SIZE),
          Math.max(model.radius, MIN_SHAPE_SIZE),
          Math.max(model.height, MIN_SHAPE_SIZE),
          48,
          1,
          false,
        ]}
      />
    );
  }

  return (
    <sphereGeometry
      args={[Math.max(model.radius, MIN_SHAPE_SIZE), 48, 24]}
    />
  );
}
