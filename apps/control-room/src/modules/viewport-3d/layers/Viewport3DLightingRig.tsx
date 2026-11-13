"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  ShadowMaterial,
  type RenderTarget,
  Quaternion,
  Vector3,
  type ColorRepresentation,
} from "three";

import { resolveViewport3DPresentationQuality, resolveViewport3DShadowBounds } from "../viewport3dPresentation";
import type { Viewport3DBounds } from "../viewport3dRenderModel";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { Viewport3DStudioEnvironment } from "./Viewport3DStudioEnvironment";

import {
  DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  type Viewport3DAppearancePreferences,
} from "../viewport3dAppearancePreferences";
import {
  getViewport3DVisualProfile,
  type Viewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "../viewport3dVisualProfile";
import {
  readViewport3DLightingAudit,
  type Viewport3DLightingAudit,
} from "../viewport3dLightingAudit";

declare global {
  interface Window {
    __FULLMAG_READ_VIEWPORT_3D_LIGHTING__?: () => Viewport3DLightingAudit;
  }
}

export type Viewport3DLightingAppearance = Pick<
  Viewport3DAppearancePreferences,
  | "lightingAzimuth"
  | "lightingElevation"
  | "lightingIntensity"
  | "lightingMode"
  | "lightingSpace"
> & Partial<Pick<Viewport3DAppearancePreferences, "renderMode" | "softShadows">>;

export interface Viewport3DLightingRigModel {
  ambient: {
    color: ColorRepresentation;
    intensity: number;
  };
  directional: Array<{
    color: ColorRepresentation;
    intensity: number;
    key: "fill" | "key";
    position: [number, number, number];
  }>;
  hemisphere: {
    args: [ColorRepresentation, ColorRepresentation, number];
  } | null;
}

const LIGHT_DISTANCE = 10;
const KEY_INTENSITY = 0.82;
const FILL_INTENSITY = 0.28;
const STUDIO_AMBIENT_INTENSITY = 0.24;

function clampLightingIntensity(value: number): number {
  return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1;
}

function directionFromAngles(azimuthDegrees: number, elevationDegrees: number) {
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const elevation = (elevationDegrees * Math.PI) / 180;
  const cosElevation = Math.cos(elevation);
  return new Vector3(
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.cos(azimuth) * cosElevation,
  ).normalize();
}

function lightPosition(direction: Vector3): [number, number, number] {
  return [
    direction.x * LIGHT_DISTANCE,
    direction.y * LIGHT_DISTANCE,
    direction.z * LIGHT_DISTANCE,
  ];
}

export function resolveViewport3DLightingRig(
  profile: Viewport3DVisualProfile,
  appearance: Viewport3DLightingAppearance =
    DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
): Viewport3DLightingRigModel {
  const studioEnabled = appearance.lightingMode === "studio";
  const rigEnabled = studioEnabled;
  const intensity = clampLightingIntensity(appearance.lightingIntensity);
  const keyDirection = directionFromAngles(
    appearance.lightingAzimuth,
    appearance.lightingElevation,
  );
  const fillDirection = directionFromAngles(
    appearance.lightingAzimuth + 100,
    Math.max(-10, appearance.lightingElevation - 18),
  );

  return {
    ambient: {
      color: 0xffffff,
      intensity: rigEnabled
        ? STUDIO_AMBIENT_INTENSITY * intensity
        : profile.lighting === "minimal"
          ? 0.6
          : 0.72,
    },
    directional: rigEnabled
      ? [
          {
            key: "key",
            color: 0xffffff,
            intensity: KEY_INTENSITY * intensity,
            position: lightPosition(keyDirection),
          },
          {
            key: "fill",
            color: 0xffffff,
            intensity: FILL_INTENSITY * intensity,
            position: lightPosition(fillDirection),
          },
        ]
      : [],
    hemisphere: null,
  };
}

export function Viewport3DLightingRig({
  appearance = DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  profileId,
  bounds = null,
  tracker,
}: {
  bounds?: Viewport3DBounds | null;
  tracker: Viewport3DResourceTracker;
  appearance?: Viewport3DLightingAppearance;
  profileId: Viewport3DVisualProfileId;
}) {
  const getThree = useThree((state) => state.get);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const readAudit = () => {
      const { scene, camera } = getThree();
      const pbrMaterials: Array<{ roughness: number; metalness: number; color: string; opacity: number }> = [];
      scene.traverseVisible((object) => {
        if (!(object instanceof Mesh) || object.userData.primitive !== true) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material instanceof MeshStandardMaterial) pbrMaterials.push({ roughness: material.roughness, metalness: material.metalness, color: material.color.getHexString(), opacity: material.opacity });
        }
      });
      return { ...readViewport3DLightingAudit(scene, camera), presentation: {
        environmentReady: scene.environment !== null,
        environmentIntensity: scene.environmentIntensity,
        pbrMaterials,
      } };
    };
    window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__ = readAudit;
    return () => {
      if (window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__ === readAudit) {
        delete window.__FULLMAG_READ_VIEWPORT_3D_LIGHTING__;
      }
    };
  }, [getThree]);
  const profile = getViewport3DVisualProfile(profileId);
  const invalidate = useBatchedInvalidate("material-style");
  const presentation = appearance.renderMode === "presentation" && appearance.lightingMode === "studio";
  const quality = resolveViewport3DPresentationQuality(profileId);
  const shadows = presentation && appearance.softShadows !== false && quality.shadowMapSize > 0;
  const [centerX, centerY, centerZ] = bounds?.center ?? [0, 0, 0];
  const [sizeX, sizeY, sizeZ] = bounds?.size ?? [1, 1, 1];
  const shadowBounds = useMemo(() => resolveViewport3DShadowBounds({
    center: [centerX, centerY, centerZ], size: [sizeX, sizeY, sizeZ], radius: 0,
  }), [centerX, centerY, centerZ, sizeX, sizeY, sizeZ]);
  const trackedShadow = useRef<RenderTarget | null>(null);
  const rig = resolveViewport3DLightingRig(profile, appearance);
  const keyLightRef = useRef<DirectionalLight>(null);
  const fillLightRef = useRef<DirectionalLight>(null);
  const cameraQuaternion = useMemo(() => new Quaternion(), []);
  const keyLocalDirection = useMemo(
    () => directionFromAngles(appearance.lightingAzimuth, appearance.lightingElevation),
    [appearance.lightingAzimuth, appearance.lightingElevation],
  );
  const fillLocalDirection = useMemo(
    () =>
      directionFromAngles(
        appearance.lightingAzimuth + 100,
        Math.max(-10, appearance.lightingElevation - 18),
      ),
    [appearance.lightingAzimuth, appearance.lightingElevation],
  );
  const worldPosition = useMemo(() => new Vector3(), []);
  const sceneCenter = useMemo(() => new Vector3(...shadowBounds.center), [shadowBounds]);

  useEffect(() => {
    const { gl } = getThree();
    const previousEnabled = gl.shadowMap.enabled;
    const previousType = gl.shadowMap.type;
    gl.shadowMap.enabled = shadows;
    gl.shadowMap.type = PCFShadowMap;
    invalidate();
    return () => { gl.shadowMap.enabled = previousEnabled; gl.shadowMap.type = previousType; };
  }, [getThree, invalidate, shadows]);
  useEffect(() => {
    const light = keyLightRef.current;
    if (!light) return;
    const oldMap = light.shadow.map;
    if (oldMap) {
      if (trackedShadow.current === oldMap) tracker.release("render-target", oldMap);
      else oldMap.dispose();
      trackedShadow.current = null;
      light.shadow.map = null;
    }
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.needsUpdate = true;
    invalidate();
    return () => {
      tracker.release("render-target", trackedShadow.current);
      if (light.shadow.map === trackedShadow.current) light.shadow.map = null;
      trackedShadow.current = null;
    };
  }, [invalidate, quality.shadowMapSize, shadows, shadowBounds, tracker]);
  // Observe after the scene (priority 1) and HUD (2) renders; a demand canvas
  // may have no following frame in which to register the newly allocated map.
  useFrame(() => {
    const map = keyLightRef.current?.shadow.map;
    if (map && map !== trackedShadow.current) {
      tracker.release("render-target", trackedShadow.current);
      trackedShadow.current = tracker.track("render-target", map, { owner: "viewport-studio", label: "soft shadow map", byteLength: quality.shadowMapSize ** 2 * 4 });
    }
  }, 2.5);

  useFrame(({ camera }) => {
    camera.getWorldQuaternion(cameraQuaternion);
    if (keyLightRef.current) {
      worldPosition
        .copy(keyLocalDirection)
        .multiplyScalar(presentation ? shadowBounds.radius * 3 : LIGHT_DISTANCE);
      if (appearance.lightingSpace === "camera") worldPosition.applyQuaternion(cameraQuaternion);
      if (presentation) worldPosition.add(sceneCenter);
      keyLightRef.current.position.copy(worldPosition);
      keyLightRef.current.target.position.set(...(presentation ? shadowBounds.center : [0, 0, 0] as [number, number, number]));
      keyLightRef.current.target.updateMatrixWorld();
    }
    if (fillLightRef.current) {
      worldPosition
        .copy(fillLocalDirection)
        .multiplyScalar(presentation ? shadowBounds.radius * 3 : LIGHT_DISTANCE);
      if (appearance.lightingSpace === "camera") worldPosition.applyQuaternion(cameraQuaternion);
      if (presentation) worldPosition.add(sceneCenter);
      fillLightRef.current.position.copy(worldPosition);
      fillLightRef.current.target.position.set(...(presentation ? shadowBounds.center : [0, 0, 0] as [number, number, number]));
      fillLightRef.current.target.updateMatrixWorld();
    }
  });

  return (
    <>
      <Viewport3DStudioEnvironment enabled={presentation} intensity={clampLightingIntensity(appearance.lightingIntensity)} tracker={tracker} />
      {shadows && bounds ? (
        <Viewport3DShadowFloor bounds={bounds} radius={shadowBounds.radius} tracker={tracker} />
      ) : null}
      <ambientLight color={rig.ambient.color} intensity={rig.ambient.intensity} />
      {rig.directional.map((light) => (
        <directionalLight
          castShadow={light.key === "key" && shadows}
          shadow-mapSize-width={quality.shadowMapSize || 512}
          shadow-mapSize-height={quality.shadowMapSize || 512}
          shadow-camera-left={-shadowBounds.radius}
          shadow-camera-right={shadowBounds.radius}
          shadow-camera-top={shadowBounds.radius}
          shadow-camera-bottom={-shadowBounds.radius}
          shadow-camera-near={shadowBounds.near}
          shadow-camera-far={shadowBounds.far}
          shadow-normalBias={shadowBounds.radius * 0.003}
          shadow-bias={-0.00005}
          shadow-radius={2.5}
          color={light.color}
          intensity={light.intensity}
          key={light.key}
          position={light.position}
          ref={light.key === "key" ? keyLightRef : fillLightRef}
        />
      ))}
      {rig.hemisphere ? <hemisphereLight args={rig.hemisphere.args} /> : null}
    </>
  );
}


/** A presentation-only shadow receiver; never part of solver geometry or picking. */
function Viewport3DShadowFloor({ bounds, radius, tracker }: {
  bounds: Viewport3DBounds;
  radius: number;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(() => tracker.track("geometry", new PlaneGeometry(1, 1), { owner: "viewport-studio", label: "shadow receiver" }), [tracker]);
  const material = useMemo(() => tracker.track("material", new ShadowMaterial({ transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false }), { owner: "viewport-studio", label: "shadow receiver" }), [tracker]);
  useEffect(() => () => {
    tracker.release("geometry", geometry);
    tracker.release("material", material);
  }, [geometry, material, tracker]);
  return <mesh geometry={geometry} material={material} dispose={null} raycast={() => {}} position={[bounds.center[0], bounds.center[1], bounds.center[2] - bounds.size[2] / 2 - radius * 0.01]} scale={[radius * 4, radius * 4, 1]} receiveShadow />;
}
