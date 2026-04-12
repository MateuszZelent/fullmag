"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { FemMeshData } from "@/components/preview/FemMeshView3D";
import { FemViewportScene } from "@/components/preview/fem/FemViewportScene";
import ScientificViewportShell from "@/components/preview/shared/ScientificViewportShell";
import { fitCameraToBounds } from "@/components/preview/camera/cameraHelpers";
import { currentLiveApiClient } from "@/lib/liveApiClient";
import { normalizeSessionState } from "@/lib/session/normalize";
import type { FemLiveMesh } from "@/lib/session/types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";

function flattenFemMesh(mesh: FemLiveMesh): FemMeshData {
  const flatNodes = new Array<number>(mesh.nodes.length * 3);
  for (let i = 0; i < mesh.nodes.length; i += 1) {
    const node = mesh.nodes[i];
    flatNodes[i * 3] = node[0];
    flatNodes[i * 3 + 1] = node[1];
    flatNodes[i * 3 + 2] = node[2];
  }

  const flatElements = new Array<number>(mesh.elements.length * 4);
  for (let i = 0; i < mesh.elements.length; i += 1) {
    const element = mesh.elements[i];
    flatElements[i * 4] = element[0];
    flatElements[i * 4 + 1] = element[1];
    flatElements[i * 4 + 2] = element[2];
    flatElements[i * 4 + 3] = element[3];
  }

  const flatFaces = new Array<number>(mesh.boundary_faces.length * 3);
  for (let i = 0; i < mesh.boundary_faces.length; i += 1) {
    const face = mesh.boundary_faces[i];
    flatFaces[i * 3] = face[0];
    flatFaces[i * 3 + 1] = face[1];
    flatFaces[i * 3 + 2] = face[2];
  }

  return {
    nodes: flatNodes,
    elements: flatElements,
    boundaryFaces: flatFaces,
    nNodes: mesh.nodes.length,
    nElements: mesh.elements.length,
    fieldData: undefined,
    activeMask: null,
    quantityDomain: "full_domain",
  };
}

function computeMeshCenterAndExtent(mesh: FemLiveMesh) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const [x, y, z] of mesh.nodes) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const center = new THREE.Vector3(
    0.5 * (minX + maxX),
    0.5 * (minY + maxY),
    0.5 * (minZ + maxZ),
  );
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9);
  return {
    center,
    maxDim,
    worldExtent: [maxDim, maxDim, maxDim] as [number, number, number],
    worldCenter: [center.x, center.y, center.z] as [number, number, number],
  };
}

function FemSceneAutoFit({ maxDim }: { maxDim: number }) {
  const { camera, invalidate } = useThree();
  useEffect(() => {
    if (maxDim <= 0) {
      return;
    }
    fitCameraToBounds(camera, maxDim);
    invalidate();
  }, [camera, invalidate, maxDim]);
  return null;
}

function FpsProbe({ onSample }: { onSample: (fps: number) => void }) {
  const lastRef = useRef({ time: 0, frames: 0 });
  useEffect(() => {
    lastRef.current.time = performance.now();
    lastRef.current.frames = 0;
  }, []);
  useFrame(() => {
    if (lastRef.current.time === 0) {
      lastRef.current.time = performance.now();
    }
    lastRef.current.frames += 1;
    const now = performance.now();
    const elapsed = now - lastRef.current.time;
    if (elapsed >= 500) {
      onSample(Math.round((lastRef.current.frames * 1000) / elapsed));
      lastRef.current.frames = 0;
      lastRef.current.time = now;
    }
  });
  return null;
}

export default function StandaloneFemSceneDiagnosticViewport() {
  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("StandaloneFemSceneDiagnosticViewport");
  }

  const [mesh, setMesh] = useState<FemLiveMesh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void currentLiveApiClient()
      .fetchBootstrap()
      .then((raw) => {
        if (cancelled) return;
        const state = normalizeSessionState(raw);
        const nextMesh = state.fem_mesh ?? state.live_state?.fem_mesh ?? null;
        if (!nextMesh || nextMesh.nodes.length === 0 || nextMesh.elements.length === 0) {
          setError("Bootstrap loaded, but no FEM mesh was available.");
          setMesh(null);
          return;
        }
        setMesh(nextMesh);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setMesh(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const meshData = useMemo(() => (mesh ? flattenFemMesh(mesh) : null), [mesh]);
  const meshFrame = useMemo(
    () => (mesh ? computeMeshCenterAndExtent(mesh) : null),
    [mesh],
  );

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
      {meshData && meshFrame ? (
        <ScientificViewportShell
          toolbar={null}
          hud={null}
          projection="perspective"
          navigation="trackball"
          qualityProfile="interactive"
          target={[0, 0, 0]}
          renderDefaultGizmos={false}
          diagnosticOverrides={{
            enableControls: true,
            enableLights: false,
            enableCanvasPointerMissedHandler: false,
            enableCanvasContextMenuHandler: false,
            enableCanvasCreatedHandler: false,
            enableBridgeSync: false,
            forceFrameloopMode: "always",
          }}
        >
          <FemSceneAutoFit maxDim={meshFrame.maxDim} />
          <FpsProbe onSample={setFps} />
          <FemViewportScene
            meshData={meshData}
            hasMeshParts={false}
            visibleLayers={[]}
            shouldRenderAirGeometry={false}
            airBoundaryFaceIndices={null}
            airElementIndices={null}
            airSegmentOpacity={20}
            shouldRenderMagneticGeometry={true}
            magneticVisibilityMode="ghost"
            field="none"
            renderMode="surface"
            effectiveOpacity={100}
            magneticBoundaryFaceIndices={null}
            magneticElementIndices={null}
            qualityPerFace={null}
            shrinkFactor={1}
            clipEnabled={false}
            clipAxis="x"
            clipPos={50}
            dynamicGeomCenter={meshFrame.center}
            dynamicMaxDim={meshFrame.maxDim}
            effectiveShowArrows={false}
            arrowField="none"
            arrowSamplingMode="auto"
            arrowDensity={0}
            arrowColorMode="monochrome"
            arrowMonoColor="#4f8cff"
            arrowAlpha={1}
            arrowLengthScale={1}
            arrowThickness={1}
            arrowActiveNodeMask={null}
            arrowBoundaryFaceIndices={null}
            selectedFaces={[]}
            antennaOverlays={[]}
            focusedEntityId={null}
            selectedAntennaId={null}
            axesWorldExtent={meshFrame.worldExtent}
            axesCenter={meshFrame.worldCenter}
            showSceneGeometry={true}
            showPerPartGeometry={false}
            showAirGeometry={false}
            showMagneticGeometry={true}
            showSurfacePass={true}
            showSurfaceHiddenEdgesPass={false}
            showSurfaceVisibleEdgesPass={false}
            showVolumeHiddenEdgesPass={false}
            showVolumeVisibleEdgesPass={false}
            showPointsPass={false}
            enableGeometryCompaction={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryCompaction}
            enableGeometryNormals={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryNormals}
            enableGeometryVertexColors={FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryVertexColors}
            enableGeometryPointerInteractions={false}
            showSelectionHighlight={false}
            showAntennaOverlays={false}
            showSceneAxes={false}
          />
        </ScientificViewportShell>
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {loading ? "Loading FEM scene bootstrap..." : error ?? "No FEM mesh available"}
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80">
        <div>Standalone FEM scene diagnostic viewport</div>
        <div>{loading ? "Status: loading" : meshData ? "Status: loaded" : `Status: ${error ?? "empty"}`}</div>
        <div>{fps == null ? "FPS: measuring..." : `FPS: ${fps}`}</div>
        {mesh ? <div>{`${mesh.nodes.length.toLocaleString()} nodes, ${mesh.elements.length.toLocaleString()} tets`}</div> : null}
      </div>
    </div>
  );
}
