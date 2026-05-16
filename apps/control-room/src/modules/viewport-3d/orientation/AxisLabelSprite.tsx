"use client";

import { useEffect, useMemo } from "react";
import { CanvasTexture } from "three";

import { WIDGET_RENDER_ORDER } from "./orientationHudConstants";

export function AxisLabelSprite({
  color,
  label,
  outlineColor,
  position,
  renderOrder = WIDGET_RENDER_ORDER + 5,
  scale = [0.88, 0.42, 1],
}: {
  color: string;
  label: string;
  outlineColor: string;
  position: [number, number, number];
  renderOrder?: number;
  scale?: [number, number, number];
}) {
  const texture = useMemo(
    () => buildAxisLabelTexture(label, color, outlineColor),
    [color, label, outlineColor],
  );

  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <sprite position={position} renderOrder={renderOrder} scale={scale}>
      <spriteMaterial
        depthTest={false}
        depthWrite={false}
        map={texture}
        toneMapped={false}
        transparent
      />
    </sprite>
  );
}

function buildAxisLabelTexture(
  label: string,
  color: string,
  outlineColor: string,
): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = "800 38px Inter, Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = 8;
    context.strokeStyle = outlineColor;
    context.fillStyle = color;
    context.strokeText(label, 64, 34);
    context.fillText(label, 64, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

