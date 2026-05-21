"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  type ColorRepresentation,
} from "three";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type {
  Viewport3DCameraProjection,
  Viewport3DCameraState,
} from "../viewport3dStore";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  buildDimensionFrameModel,
  type DimensionFrameDensity,
  type DimensionFrameLabel,
  type DimensionFrameMode,
  type DimensionFrameUnitMode,
} from "./dimensionFrameModel";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";

interface DimensionFrameLayerProps {
  bounds: Viewport3DBounds | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraState: Viewport3DCameraState;
  colors: Viewport3DColors;
  density: DimensionFrameDensity;
  labelsVisible: boolean;
  materialProfile: Viewport3DMaterialProfile;
  mode: DimensionFrameMode;
  tracker: Viewport3DResourceTracker;
  unitMode: DimensionFrameUnitMode;
}

interface DimensionFrameLayerColors {
  label: string;
  major: ColorRepresentation;
  minor: ColorRepresentation;
  outline: string;
}

const DIMENSION_FRAME_RENDER_ORDER = 4;

export function DimensionFrameLayer({
  bounds,
  cameraProjection,
  cameraState,
  colors,
  density,
  labelsVisible,
  materialProfile,
  mode,
  tracker,
  unitMode,
}: DimensionFrameLayerProps) {
  const invalidate = useThree((state) => state.invalidate);
  const layerColors = useMemo(
    () => resolveDimensionFrameLayerColors(colors),
    [colors],
  );
  const model = useMemo(
    () =>
      buildDimensionFrameModel({
        bounds,
        cameraProjection,
        cameraState,
        density,
        labelsVisible,
        mode,
        unitMode,
      }),
    [
      bounds,
      cameraProjection,
      cameraState,
      density,
      labelsVisible,
      mode,
      unitMode,
    ],
  );
  const minorGeometry = useMemo(
    () => createDimensionFrameLineGeometry(model.minorLines),
    [model.minorLines],
  );
  const majorGeometry = useMemo(
    () => createDimensionFrameLineGeometry(model.majorLines),
    [model.majorLines],
  );

  useEffect(() => {
    if (!minorGeometry) return undefined;
    trackDimensionFrameGeometry(tracker, minorGeometry);
    return () => releaseDimensionFrameGeometry(tracker, minorGeometry);
  }, [minorGeometry, tracker]);

  useEffect(() => {
    if (!majorGeometry) return undefined;
    trackDimensionFrameGeometry(tracker, majorGeometry);
    return () => releaseDimensionFrameGeometry(tracker, majorGeometry);
  }, [majorGeometry, tracker]);

  useEffect(() => {
    tracker.recordDirtyFrame("dimension-frame");
    invalidate();
  }, [invalidate, model.signature, tracker]);

  if (mode === "off" || (!minorGeometry && !majorGeometry)) {
    return null;
  }

  const labels = [...model.tickLabels, ...model.axisLabels];
  const labelScale = model.labelScaleWorld;

  return (
    <group renderOrder={DIMENSION_FRAME_RENDER_ORDER}>
      {minorGeometry ? (
        <lineSegments
          geometry={minorGeometry}
          renderOrder={DIMENSION_FRAME_RENDER_ORDER}
        >
          <lineBasicMaterial
            color={layerColors.minor}
            depthTest
            depthWrite={false}
            opacity={materialProfile.dimensionFrame.minorOpacity}
            toneMapped={false}
            transparent
          />
        </lineSegments>
      ) : null}
      {majorGeometry ? (
        <lineSegments
          geometry={majorGeometry}
          renderOrder={DIMENSION_FRAME_RENDER_ORDER + 1}
        >
          <lineBasicMaterial
            color={layerColors.major}
            depthTest
            depthWrite={false}
            opacity={materialProfile.dimensionFrame.majorOpacity}
            toneMapped={false}
            transparent
          />
        </lineSegments>
      ) : null}
      {labels.map((label) => (
        <DimensionFrameLabelSprite
          key={label.key}
          color={layerColors.label}
          label={label}
          opacity={
            label.colorRole === "tick"
              ? materialProfile.dimensionFrame.tickOpacity
              : materialProfile.dimensionFrame.labelOpacity
          }
          outlineColor={layerColors.outline}
          scale={labelScale}
        />
      ))}
    </group>
  );
}

export function createDimensionFrameLineGeometry(
  positions: Float32Array,
): BufferGeometry | null {
  if (positions.length === 0) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function trackDimensionFrameGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry,
): BufferGeometry {
  return tracker.track("geometry", geometry);
}

export function releaseDimensionFrameGeometry(
  tracker: Viewport3DResourceTracker,
  geometry: BufferGeometry | null,
): void {
  tracker.release("geometry", geometry);
}

export function resolveDimensionFrameLayerColors(
  colors: Viewport3DColors,
): DimensionFrameLayerColors {
  return {
    label: colorToCss(colors.textPrimary ?? colors.textSecondary ?? colors.wire),
    major: colors.textSecondary ?? colors.wire,
    minor: colors.wire,
    outline: colorToCss(colors.background),
  };
}

function DimensionFrameLabelSprite({
  color,
  label,
  opacity,
  outlineColor,
  scale,
}: {
  color: string;
  label: DimensionFrameLabel;
  opacity: number;
  outlineColor: string;
  scale: number;
}) {
  const texture = useMemo(
    () => buildDimensionFrameLabelTexture(label.text, color, outlineColor),
    [color, label.text, outlineColor],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite
      position={label.position}
      renderOrder={DIMENSION_FRAME_RENDER_ORDER + 3}
      scale={[
        scale * labelWidthScale(label.text, label.colorRole),
        scale * (label.colorRole === "tick" ? 0.72 : 0.9),
        1,
      ]}
    >
      <spriteMaterial
        depthTest={false}
        depthWrite={false}
        map={texture}
        opacity={opacity}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
}

function buildDimensionFrameLabelTexture(
  label: string,
  color: string,
  outlineColor: string,
): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "700 30px JetBrains Mono, Cascadia Code, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 7;
    context.strokeStyle = outlineColor;
    context.fillStyle = color;
    context.strokeText(label, canvas.width / 2, 34);
    context.fillText(label, canvas.width / 2, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function labelWidthScale(
  label: string,
  colorRole: DimensionFrameLabel["colorRole"],
): number {
  const base = colorRole === "tick" ? 2.35 : 1.55;
  return Math.max(base, label.length * 0.62);
}

function colorToCss(color: ColorRepresentation): string {
  return typeof color === "string" ? color : new Color(color).getStyle();
}
