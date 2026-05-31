"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Plane,
  Quaternion,
  Vector3,
  type WebGLRenderer,
} from "three";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { Viewport3DColors } from "../viewport3dTypes";
import {
  resolveClipPlaneFrame,
  resolveClipPlaneFrameOutlineSegments,
  type ClipPlaneFrame,
  type ClipPlaneIntersectionMarkerBuffers,
} from "./clipPlaneModel";

interface ClipPlaneLayerProps {
  bounds: Viewport3DBounds | null;
  clip: VisualizationStateResource["clip"] | null;
  colors: Viewport3DColors;
  frameRotationDegrees: number;
  intersectionMarkers: ClipPlaneIntersectionMarkerBuffers | null;
  tracker: Viewport3DResourceTracker;
}

interface ClipPlaneFramePreviewLayerProps {
  bounds: Viewport3DBounds | null;
  clip: VisualizationStateResource["clip"] | null;
  colors: Viewport3DColors;
  frameRotationDegrees: number;
  tracker: Viewport3DResourceTracker;
}

const DEFAULT_PLANE_NORMAL = new Vector3(0, 0, 1);

export function ClipPlaneLayer({
  bounds,
  clip,
  colors,
  frameRotationDegrees,
  intersectionMarkers,
  tracker,
}: ClipPlaneLayerProps) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const frame = useMemo(
    () => resolveClipPlaneFrame(clip, bounds, frameRotationDegrees),
    [bounds, clip, frameRotationDegrees],
  );
  const clippingPlane = useMemo(() => {
    if (!frame) return null;
    return new Plane(
      new Vector3(...frame.normal).normalize(),
      frame.planeConstant,
    );
  }, [frame]);
  const planeQuaternion = useMemo(() => {
    return resolveClipPlaneFrameQuaternion(frame);
  }, [frame]);

  useEffect(() => {
    const previousLocalClippingEnabled = gl.localClippingEnabled;
    const previousClippingPlanes = gl.clippingPlanes;
    applyRendererClipping(gl, clippingPlane);
    tracker.recordDirtyFrame("clip-plane");
    invalidate();

    return () => {
      restoreRendererClipping(gl, {
        clippingPlanes: previousClippingPlanes,
        localClippingEnabled: previousLocalClippingEnabled,
      });
      tracker.recordDirtyFrame("clip-plane-cleanup");
      invalidate();
    };
  }, [clippingPlane, gl, invalidate, tracker]);

  if (!frame) return null;

  return (
    <>
      <group
        position={frame.center}
        quaternion={planeQuaternion}
        renderOrder={30}
      >
        <mesh renderOrder={30}>
          <planeGeometry args={[frame.width, frame.height]} />
          <meshBasicMaterial
            color={colors.accent}
            depthWrite={false}
            opacity={0.22}
            side={DoubleSide}
            transparent
          />
        </mesh>
        <ClipPlaneFrameOutline colors={colors} frame={frame} />
      </group>
      <ClipPlaneIntersectionMarkers
        colors={colors}
        markers={intersectionMarkers}
      />
    </>
  );
}

export function ClipPlaneFramePreviewLayer({
  bounds,
  clip,
  colors,
  frameRotationDegrees,
  tracker,
}: ClipPlaneFramePreviewLayerProps) {
  const invalidate = useThree((state) => state.invalidate);
  const frame = useMemo(
    () => resolveClipPlaneFrame(clip, bounds, frameRotationDegrees),
    [bounds, clip, frameRotationDegrees],
  );
  const planeQuaternion = useMemo(
    () => resolveClipPlaneFrameQuaternion(frame),
    [frame],
  );

  useEffect(() => {
    if (!frame) return;
    tracker.recordDirtyFrame("cross-section-frame-preview");
    invalidate();
  }, [frame, invalidate, tracker]);

  if (!frame) return null;

  return (
    <group position={frame.center} quaternion={planeQuaternion} renderOrder={31}>
      <ClipPlaneFrameOutline colors={colors} frame={frame} />
    </group>
  );
}

function resolveClipPlaneFrameQuaternion(frame: ClipPlaneFrame | null): Quaternion {
  if (!frame) return new Quaternion();
  const normalQuaternion = new Quaternion().setFromUnitVectors(
    DEFAULT_PLANE_NORMAL,
    new Vector3(...frame.normal).normalize(),
  );
  const frameQuaternion = new Quaternion().setFromAxisAngle(
    DEFAULT_PLANE_NORMAL,
    (frame.rotationDegrees * Math.PI) / 180,
  );
  return normalQuaternion.multiply(frameQuaternion);
}

function ClipPlaneFrameOutline({
  colors,
  frame,
}: {
  colors: Viewport3DColors;
  frame: ClipPlaneFrame;
}) {
  const geometry = useMemo(() => {
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(resolveClipPlaneFrameOutlineSegments(frame), 3),
    );
    next.computeBoundingSphere();
    return next;
  }, [frame]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} renderOrder={31}>
      <lineBasicMaterial
        color={colors.accent}
        depthTest={false}
        depthWrite={false}
        opacity={0.95}
        transparent
      />
    </lineSegments>
  );
}

function ClipPlaneIntersectionMarkers({
  colors,
  markers,
}: {
  colors: Viewport3DColors;
  markers: ClipPlaneIntersectionMarkerBuffers | null;
}) {
  if (!markers) return null;

  return (
    <>
      {markers.edgeIntersectionCount > 0 ? (
        <ClipPlaneIntersectionMarkerCloud
          color={colors.wire}
          opacity={0.72}
          positions={markers.edgeIntersectionPositions}
          size={5}
        />
      ) : null}
      {markers.meshNodeCount > 0 ? (
        <ClipPlaneIntersectionMarkerCloud
          color={colors.accentStrong ?? colors.accent}
          opacity={0.98}
          positions={markers.meshNodePositions}
          size={7}
        />
      ) : null}
    </>
  );
}

function ClipPlaneIntersectionMarkerCloud({
  color,
  opacity,
  positions,
  size,
}: {
  color: Viewport3DColors["accent"];
  opacity: number;
  positions: Float32Array;
  size: number;
}) {
  const geometry = useMemo(() => {
    const next = new BufferGeometry();
    next.setAttribute("position", new BufferAttribute(positions, 3));
    next.computeBoundingSphere();
    return next;
  }, [positions]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <points geometry={geometry} renderOrder={32}>
      <pointsMaterial
        color={color}
        depthTest={false}
        depthWrite={false}
        opacity={opacity}
        size={size}
        sizeAttenuation={false}
        transparent
      />
    </points>
  );
}

function applyRendererClipping(
  renderer: WebGLRenderer,
  clippingPlane: Plane | null,
): void {
  renderer.localClippingEnabled = Boolean(clippingPlane);
  renderer.clippingPlanes = clippingPlane ? [clippingPlane] : [];
}

function restoreRendererClipping(
  renderer: WebGLRenderer,
  previous: {
    clippingPlanes: Plane[];
    localClippingEnabled: boolean;
  },
): void {
  renderer.localClippingEnabled = previous.localClippingEnabled;
  renderer.clippingPlanes = previous.clippingPlanes;
}
