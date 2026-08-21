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
import type { ThreeEvent } from "@react-three/fiber";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { PlanarMonitorFramePreview } from "@/kernel/workspace/planarMonitorFramePreview";
import { planarMonitorFramePreviewCanSelect } from "@/kernel/workspace/planarMonitorFramePreview";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
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
  const invalidate = useBatchedInvalidate("material-style");
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
  const invalidate = useBatchedInvalidate("target-visibility");
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

export function PlanarMonitorFramePreviewLayer({
  colors,
  onSelect,
  preview,
  tracker,
}: {
  colors: Viewport3DColors;
  onSelect?: (monitorId: string, isDraft: boolean) => void;
  preview: PlanarMonitorFramePreview;
  tracker: Viewport3DResourceTracker;
}) {
  const invalidate = useBatchedInvalidate("target-visibility");
  const geometry = useMemo(() => {
    const next = new BufferGeometry();
    next.setAttribute(
      "position",
      new BufferAttribute(planarMonitorFrameSegments(preview), 3),
    );
    next.computeBoundingSphere();
    return next;
  }, [preview]);

  useEffect(() => {
    tracker.recordDirtyFrame("planar-monitor-frame-preview");
    invalidate();
    return () => geometry.dispose();
  }, [geometry, invalidate, tracker]);

  const interaction = planarMonitorFramePreviewInteraction(preview, onSelect);
  usePlanarMonitorFramePreviewAudit(interaction !== null, Boolean(interaction?.onClick), Boolean(interaction?.raycast));
  if (!interaction) return null;

  return (
    <lineSegments
      geometry={geometry}
      onClick={interaction.onClick}
      raycast={interaction.raycast}
      renderOrder={31}
    >
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

function usePlanarMonitorFramePreviewAudit(active: boolean, hitListener: boolean, raycastOwner: boolean): void {
  useEffect(() => {
    if (!active || !planarMonitorFramePreviewAuditEnabled()) return;
    const audit = readPlanarMonitorFramePreviewAudit();
    audit.activeOverlayInstances += 1;
    audit.hitListenerOwners += hitListener ? 1 : 0;
    audit.raycastOwners += raycastOwner ? 1 : 0;
    audit.maxActiveOverlayInstances = Math.max(audit.maxActiveOverlayInstances, audit.activeOverlayInstances);
    audit.maxHitListenerOwners = Math.max(audit.maxHitListenerOwners, audit.hitListenerOwners);
    audit.maxRaycastOwners = Math.max(audit.maxRaycastOwners, audit.raycastOwners);
    return () => {
      audit.activeOverlayInstances -= 1;
      audit.hitListenerOwners -= hitListener ? 1 : 0;
      audit.raycastOwners -= raycastOwner ? 1 : 0;
    };
  }, [active, hitListener, raycastOwner]);
}

function planarMonitorFramePreviewAuditEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUDIT_BUILD === "1" &&
    (globalThis as typeof globalThis & { __FULLMAG_CONFIG__?: { enableAuditHooks?: unknown } }).__FULLMAG_CONFIG__?.enableAuditHooks === true;
}

function readPlanarMonitorFramePreviewAudit() {
  const scope = globalThis as typeof globalThis & { __FULLMAG_PLANAR_MONITOR_PREVIEW_AUDIT__?: Record<string, number> };
  return (scope.__FULLMAG_PLANAR_MONITOR_PREVIEW_AUDIT__ ??= {
    activeOverlayInstances: 0, hitListenerOwners: 0, maxActiveOverlayInstances: 0,
    maxHitListenerOwners: 0, maxRaycastOwners: 0, raycastOwners: 0,
  });
}

export function planarMonitorFramePreviewInteraction(
  preview: PlanarMonitorFramePreview,
  onSelect?: (monitorId: string, isDraft: boolean) => void,
): {
  onClick?: (event: Pick<ThreeEvent<MouseEvent>, "stopPropagation">) => void;
  raycast?: () => void;
} | null {
  if (preview.visible === false) return null;
  if (!planarMonitorFramePreviewCanSelect(preview)) {
    return { raycast: () => undefined };
  }
  return {
    onClick: (event) => {
      event.stopPropagation();
      onSelect?.(preview.monitorId, preview.isDraft === true);
    },
  };
}

export function planarMonitorFrameSegments(
  preview: PlanarMonitorFramePreview,
): Float32Array {
  const [uMin, uMax, vMin, vMax] = preview.boundsUvM;
  const point = (u: number, v: number, normalOffset = 0) =>
    preview.originM.map(
      (origin, axis) =>
        origin +
        u * preview.uAxis[axis] +
        v * preview.vAxis[axis] +
        normalOffset * preview.normal[axis],
    ) as [number, number, number];
  const slabThickness = preview.operator?.kind === "slab_average" &&
    Number.isFinite(preview.operator.thickness_m) &&
    preview.operator.thickness_m > 0
    ? preview.operator.thickness_m
    : null;
  const offsets = slabThickness === null
    ? [0]
    : [-slabThickness / 2, slabThickness / 2];
  const planes = offsets.flatMap((offset) => {
    const corners = [
      point(uMin, vMin, offset),
      point(uMax, vMin, offset),
      point(uMax, vMax, offset),
      point(uMin, vMax, offset),
    ];
    return [
      corners[0], corners[1], corners[1], corners[2],
      corners[2], corners[3], corners[3], corners[0],
      point(uMin, 0, offset), point(uMax, 0, offset),
      point(0, vMin, offset), point(0, vMax, offset),
    ];
  });
  const connectors = slabThickness === null
    ? []
    : [[uMin, vMin], [uMax, vMin], [uMax, vMax], [uMin, vMax]].flatMap(([u, v]) => [
      point(u, v, offsets[0]),
      point(u, v, offsets[1]),
    ]);
  return new Float32Array([...planes, ...connectors].flatMap((position) => position));
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
