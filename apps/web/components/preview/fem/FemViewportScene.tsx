"use client";

import React from "react";
import * as THREE from "three";
import { PivotControls } from "@react-three/drei";
import { FemGeometry } from "../r3f/FemGeometry";
import { FemArrows } from "../r3f/FemArrows";
import { FemHighlightView } from "../r3f/FemHighlightView";
import { getSharedVertexColors } from "../r3f/femVertexColors";
import SceneAxes3D from "../r3f/SceneAxes3D";
import type { AntennaOverlay, BuilderObjectOverlay } from "../../runs/control-room/shared";
import type {
  ArrowSamplingMode,
  FemArrowColorMode,
  ClipAxis,
  FemColorField,
  FemMeshData,
  RenderMode,
} from "../FemMeshView3D";
import type { FemMeshPart, MeshEntityViewState } from "../../../lib/session/types";

export interface FemViewportRenderLayer {
  part: {
    id: string;
    role: FemMeshPart["role"];
  };
  viewState: MeshEntityViewState;
  boundaryFaceIndices: number[] | null;
  elementIndices: number[] | null;
  surfaceFaces: [number, number, number][] | null;
  isSelected: boolean;
  meshColor: string;
  edgeColor: string;
}

function antennaOverlayColors(role: AntennaOverlay["conductors"][number]["role"], selected: boolean) {
  if (role === "ground") {
    return selected
      ? { fill: "#67e8f9", wire: "#a5f3fc" }
      : { fill: "#0ea5e9", wire: "#67e8f9" };
  }
  return selected
    ? { fill: "#fb923c", wire: "#fdba74" }
    : { fill: "#f97316", wire: "#fb923c" };
}

function AntennaOverlayMeshes({
  overlays,
  geomCenter,
  selectedAntennaId,
  onAntennaTranslate,
}: {
  overlays: AntennaOverlay[];
  geomCenter: THREE.Vector3;
  selectedAntennaId?: string | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const groupRef = React.useRef<THREE.Group>(null);

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedAntennaId === overlay.id;
        const conductors = overlay.conductors.map((conductor) => {
          const size = [
            conductor.boundsMax[0] - conductor.boundsMin[0],
            conductor.boundsMax[1] - conductor.boundsMin[1],
            conductor.boundsMax[2] - conductor.boundsMin[2],
          ] as const;
          if (size.some((value) => value <= 0)) {
            return null;
          }
          const center = [
            0.5 * (conductor.boundsMin[0] + conductor.boundsMax[0]) - geomCenter.x,
            0.5 * (conductor.boundsMin[1] + conductor.boundsMax[1]) - geomCenter.y,
            0.5 * (conductor.boundsMin[2] + conductor.boundsMax[2]) - geomCenter.z,
          ] as const;
          const colors = antennaOverlayColors(conductor.role, selected);
          return (
            <group key={conductor.id}>
              <mesh position={center} renderOrder={8}>
                <boxGeometry args={size} />
                <meshStandardMaterial
                  color={colors.fill}
                  emissive={colors.fill}
                  emissiveIntensity={selected ? 0.35 : 0.18}
                  transparent
                  opacity={selected ? 0.34 : 0.16}
                  depthWrite={false}
                />
              </mesh>
              <mesh position={center} renderOrder={9}>
                <boxGeometry args={size} />
                <meshBasicMaterial
                  color={colors.wire}
                  wireframe
                  transparent
                  opacity={selected ? 0.95 : 0.72}
                  depthWrite={false}
                />
              </mesh>
            </group>
          );
        });

        if (selected && onAntennaTranslate) {
          return (
            <PivotControls
              key={overlay.id}
              depthTest={false}
              lineWidth={2}
              axisColors={["#f87171", "#4ade80", "#60a5fa"]}
              scale={75}
              fixed={true}
              onDragEnd={() => {
                if (groupRef.current) {
                  const p = groupRef.current.position;
                  onAntennaTranslate(overlay.id, p.x, p.y, p.z);
                  groupRef.current.position.set(0, 0, 0);
                }
              }}
            >
              <group ref={groupRef}>{conductors}</group>
            </PivotControls>
          );
        }
        return <group key={overlay.id}>{conductors}</group>;
      })}
    </group>
  );
}

function ObjectOverlayMeshes({
  overlays,
  geomCenter,
  selectedObjectId,
  activeTransformScope,
  onGeometryTranslate,
  onObjectSelect,
}: {
  overlays: BuilderObjectOverlay[];
  geomCenter: THREE.Vector3;
  selectedObjectId?: string | null;
  activeTransformScope?: "object" | "texture" | null;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  onObjectSelect?: (id: string) => void;
}) {
  const groupRef = React.useRef<THREE.Group>(null);
  const previewOverlays = overlays.filter((overlay) => overlay.fidelity !== "mesh-backed");
  if (previewOverlays.length === 0) return null;
  return (
    <group>
      {previewOverlays.map((overlay) => {
        const size = [
          overlay.boundsMax[0] - overlay.boundsMin[0],
          overlay.boundsMax[1] - overlay.boundsMin[1],
          overlay.boundsMax[2] - overlay.boundsMin[2],
        ] as const;
        if (size.some((value) => !Number.isFinite(value) || value <= 0)) {
          return null;
        }
        const center = [
          0.5 * (overlay.boundsMin[0] + overlay.boundsMax[0]) - geomCenter.x,
          0.5 * (overlay.boundsMin[1] + overlay.boundsMax[1]) - geomCenter.y,
          0.5 * (overlay.boundsMin[2] + overlay.boundsMax[2]) - geomCenter.z,
        ] as const;
        const selected = selectedObjectId === overlay.id;
        const fill = selected ? "#86efac" : "#8dd3ff";
        const wire = selected ? "#22c55e" : "#bae6fd";
        const overlayMeshes = (
          <group
            key={`${overlay.id}-meshes`}
            onClick={(event) => {
              event.stopPropagation();
              onObjectSelect?.(overlay.id);
            }}
          >
            <mesh position={center} renderOrder={7}>
              <boxGeometry args={size} />
              <meshStandardMaterial
                color={fill}
                emissive={fill}
                emissiveIntensity={selected ? 0.24 : 0.12}
                transparent
                opacity={selected ? 0.52 : 0.34}
                depthWrite={false}
              />
            </mesh>
            <mesh position={center} renderOrder={8}>
              <boxGeometry args={size} />
              <meshBasicMaterial
                color={wire}
                wireframe
                transparent
                opacity={selected ? 0.98 : 0.78}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
        if (selected && activeTransformScope === "object" && onGeometryTranslate) {
          return (
            <PivotControls
              key={overlay.id}
              depthTest={false}
              lineWidth={2}
              axisColors={["#f87171", "#4ade80", "#60a5fa"]}
              scale={75}
              fixed
              onDragEnd={() => {
                if (!groupRef.current) return;
                const p = groupRef.current.position;
                onGeometryTranslate(overlay.id, p.x, p.y, p.z);
                groupRef.current.position.set(0, 0, 0);
              }}
            >
              <group ref={groupRef}>{overlayMeshes}</group>
            </PivotControls>
          );
        }
        return <group key={overlay.id}>{overlayMeshes}</group>;
      })}
    </group>
  );
}

export const FemViewportScene = React.memo(function FemViewportScene({
  meshData,
  hasMeshParts,
  visibleLayers,
  shouldRenderAirGeometry,
  airBoundaryFaceIndices,
  airElementIndices,
  airSegmentOpacity,
  shouldRenderMagneticGeometry,
  magneticVisibilityMode,
  field,
  airColorField,
  magneticColorField,
  renderMode,
  effectiveOpacity,
  magneticBoundaryFaceIndices,
  magneticElementIndices,
  qualityPerFace,
  shrinkFactor,
  clipEnabled,
  clipAxis,
  clipPos,
  dynamicGeomCenter,
  dynamicMaxDim,
  effectiveShowArrows,
  arrowField,
  arrowDensity,
  arrowColorMode,
  arrowMonoColor,
  arrowAlpha,
  arrowLengthScale,
  arrowThickness,
  arrowSamplingMode,
  arrowActiveNodeMask,
  arrowBoundaryFaceIndices,
  selectedFaces,
  antennaOverlays,
  objectOverlays = [],
  focusedEntityId,
  selectedAntennaId,
  selectedObjectId,
  onAntennaTranslate,
  activeTransformScope,
  onGeometryTranslate,
  onObjectSelect,
  axesWorldExtent,
  axesCenter,
  universeWireframeExtent,
  universeWireframeCenter,
  universeWireframeVisible = true,
  onFaceClick,
  onFaceHover,
  onFaceUnhover,
  onFaceContextMenu,
  showSceneGeometry = true,
  showPerPartGeometry = true,
  showAirGeometry = true,
  showMagneticGeometry = true,
  showSurfacePass = true,
  showSurfaceHiddenEdgesPass = true,
  showSurfaceVisibleEdgesPass = true,
  showVolumeHiddenEdgesPass = true,
  showVolumeVisibleEdgesPass = true,
  showPointsPass = true,
  enableGeometryCompaction = true,
  enableGeometryNormals = true,
  enableGeometryVertexColors = true,
  enableGeometryPointerInteractions = true,
  enableGeometryHoverInteractions = true,
  showSelectionHighlight = true,
  showAntennaOverlays = true,
  showSceneAxes = true,
  onArrowSampledCount,
}: {
  meshData: FemMeshData;
  hasMeshParts: boolean;
  visibleLayers: FemViewportRenderLayer[];
  shouldRenderAirGeometry: boolean;
  airBoundaryFaceIndices: number[] | null;
  airElementIndices: number[] | null;
  airSegmentOpacity: number;
  shouldRenderMagneticGeometry: boolean;
  magneticVisibilityMode: "hide" | "ghost";
  field: FemColorField;
  airColorField: FemColorField;
  magneticColorField: FemColorField;
  renderMode: RenderMode;
  effectiveOpacity: number;
  magneticBoundaryFaceIndices: number[] | null;
  magneticElementIndices: number[] | null;
  qualityPerFace?: number[] | null;
  shrinkFactor: number;
  clipEnabled: boolean;
  clipAxis: ClipAxis;
  clipPos: number;
  dynamicGeomCenter: THREE.Vector3;
  dynamicMaxDim: number;
  effectiveShowArrows: boolean;
  arrowField: FemColorField;
  arrowDensity: number;
  arrowColorMode: FemArrowColorMode;
  arrowMonoColor: string;
  arrowAlpha: number;
  arrowLengthScale: number;
  arrowThickness: number;
  arrowSamplingMode: ArrowSamplingMode;
  arrowActiveNodeMask: Uint8Array | boolean[] | null;
  arrowBoundaryFaceIndices: number[] | null;
  selectedFaces: number[];
  antennaOverlays: AntennaOverlay[];
  objectOverlays?: BuilderObjectOverlay[];
  focusedEntityId: string | null;
  selectedAntennaId?: string | null;
  selectedObjectId?: string | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  activeTransformScope?: "object" | "texture" | null;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  onObjectSelect?: (id: string) => void;
  axesWorldExtent: [number, number, number];
  axesCenter: [number, number, number];
  universeWireframeExtent?: [number, number, number] | null;
  universeWireframeCenter?: [number, number, number];
  universeWireframeVisible?: boolean;
  onFaceClick?: (e: any) => void;
  onFaceHover?: (e: any) => void;
  onFaceUnhover?: (e: any) => void;
  onFaceContextMenu?: (e: any) => void;
  showSceneGeometry?: boolean;
  showPerPartGeometry?: boolean;
  showAirGeometry?: boolean;
  showMagneticGeometry?: boolean;
  showSurfacePass?: boolean;
  showSurfaceHiddenEdgesPass?: boolean;
  showSurfaceVisibleEdgesPass?: boolean;
  showVolumeHiddenEdgesPass?: boolean;
  showVolumeVisibleEdgesPass?: boolean;
  showPointsPass?: boolean;
  enableGeometryCompaction?: boolean;
  enableGeometryNormals?: boolean;
  enableGeometryVertexColors?: boolean;
  enableGeometryPointerInteractions?: boolean;
  enableGeometryHoverInteractions?: boolean;
  showSelectionHighlight?: boolean;
  showAntennaOverlays?: boolean;
  showSceneAxes?: boolean;
  onArrowSampledCount?: (count: number | undefined) => void;
}) {
  const sharedVertexColorsByField = React.useMemo(() => {
    const fields = new Set<FemColorField>();
    if (hasMeshParts) {
      for (const layer of visibleLayers) {
        fields.add(layer.viewState.colorField);
      }
    } else {
      fields.add(meshData.quantityDomain === "full_domain" ? airColorField : "none");
      fields.add(magneticVisibilityMode === "ghost" ? "none" : magneticColorField);
    }
    const next = new Map<FemColorField, Float32Array>();
    for (const colorField of fields) {
      next.set(
        colorField,
        getSharedVertexColors({
          meshData,
          field: colorField,
          fieldData:
            colorField === "orientation" ||
            colorField === "x" ||
            colorField === "y" ||
            colorField === "z" ||
            colorField === "magnitude"
              ? meshData.shaderFieldData ?? meshData.fieldData
              : meshData.fieldData,
          qualityPerFace,
        }),
      );
    }
    return next;
  }, [field, hasMeshParts, magneticVisibilityMode, meshData, qualityPerFace, visibleLayers]);

  return (
    <>
      {showSceneGeometry && showPerPartGeometry && hasMeshParts
        ? visibleLayers
            // P4-1: Skip layers with explicitly empty subsets (no faces AND no elements)
            .filter((layer) => {
              const emptyFaces = Array.isArray(layer.boundaryFaceIndices) && layer.boundaryFaceIndices.length === 0;
              const emptyElements = Array.isArray(layer.elementIndices) && layer.elementIndices.length === 0;
              return !(emptyFaces && emptyElements);
            })
            .map((layer) => {
              const layerRenderMode =
                layer.part.role === "air" || layer.part.role === "outer_boundary"
                  ? layer.viewState.renderMode
                  : renderMode;
              return (
                <FemGeometry
                  key={layer.part.id}
                  meshData={meshData}
                  field={layer.viewState.colorField}
                  sharedBaseVertexColors={
                    layer.viewState.colorField === "none" && layer.meshColor
                      ? null
                      : sharedVertexColorsByField.get(layer.viewState.colorField) ?? null
                  }
                  renderMode={layerRenderMode}
                  opacity={layer.viewState.opacity}
                  customBoundaryFaces={layer.surfaceFaces}
                  displayBoundaryFaceIndices={layer.boundaryFaceIndices}
                  displayElementIndices={layer.elementIndices}
                  qualityPerFace={qualityPerFace}
                  shrinkFactor={shrinkFactor}
                  clipEnabled={clipEnabled}
                  clipAxis={clipAxis}
                  clipPos={clipPos}
                  uniformColor={layer.meshColor}
                  edgeColor={layer.edgeColor}
                  highlight={layer.isSelected}
                  globalCenter={dynamicGeomCenter}
                  onFaceClick={onFaceClick}
                  onFaceHover={onFaceHover}
                  onFaceUnhover={onFaceUnhover}
                  onFaceContextMenu={onFaceContextMenu}
                  showSurfacePass={showSurfacePass}
                  showSurfaceHiddenEdgesPass={showSurfaceHiddenEdgesPass}
                  showSurfaceVisibleEdgesPass={showSurfaceVisibleEdgesPass}
                  showVolumeHiddenEdgesPass={showVolumeHiddenEdgesPass}
                  showVolumeVisibleEdgesPass={showVolumeVisibleEdgesPass}
                  showPointsPass={showPointsPass}
                  enableGeometryCompaction={enableGeometryCompaction}
                  enableGeometryNormals={enableGeometryNormals}
                  enableGeometryVertexColors={enableGeometryVertexColors}
                  enableGeometryPointerInteractions={enableGeometryPointerInteractions}
                  enableGeometryHoverInteractions={enableGeometryHoverInteractions}
                />
              );
            })
        : null}

      {showSceneGeometry && showAirGeometry && !hasMeshParts && shouldRenderAirGeometry ? (
        <FemGeometry
          meshData={meshData}
          field={meshData.quantityDomain === "full_domain" ? airColorField : "none"}
          sharedBaseVertexColors={sharedVertexColorsByField.get(meshData.quantityDomain === "full_domain" ? airColorField : "none") ?? null}
          renderMode={renderMode}
          opacity={airSegmentOpacity}
          displayBoundaryFaceIndices={airBoundaryFaceIndices}
          displayElementIndices={airElementIndices}
          qualityPerFace={qualityPerFace}
          shrinkFactor={shrinkFactor}
          clipEnabled={clipEnabled}
          clipAxis={clipAxis}
          clipPos={clipPos}
          globalCenter={dynamicGeomCenter}
          onFaceClick={onFaceClick}
          onFaceHover={onFaceHover}
          onFaceUnhover={onFaceUnhover}
          onFaceContextMenu={onFaceContextMenu}
          showSurfacePass={showSurfacePass}
          showSurfaceHiddenEdgesPass={showSurfaceHiddenEdgesPass}
          showSurfaceVisibleEdgesPass={showSurfaceVisibleEdgesPass}
          showVolumeHiddenEdgesPass={showVolumeHiddenEdgesPass}
          showVolumeVisibleEdgesPass={showVolumeVisibleEdgesPass}
          showPointsPass={showPointsPass}
          enableGeometryCompaction={enableGeometryCompaction}
          enableGeometryNormals={enableGeometryNormals}
          enableGeometryVertexColors={enableGeometryVertexColors}
          enableGeometryPointerInteractions={enableGeometryPointerInteractions}
          enableGeometryHoverInteractions={enableGeometryHoverInteractions}
        />
      ) : null}

      {showSceneGeometry && showMagneticGeometry && !hasMeshParts && shouldRenderMagneticGeometry ? (
        <FemGeometry
          meshData={meshData}
          field={magneticVisibilityMode === "ghost" ? "none" : magneticColorField}
          sharedBaseVertexColors={
            magneticVisibilityMode === "ghost"
              ? null
              : sharedVertexColorsByField.get(magneticColorField) ?? null
          }
          renderMode={renderMode}
          opacity={magneticVisibilityMode === "ghost" ? Math.min(effectiveOpacity, 22) : effectiveOpacity}
          uniformColor={magneticVisibilityMode === "ghost" ? "#94a3b8" : undefined}
          edgeColor={magneticVisibilityMode === "ghost" ? "#cbd5e1" : undefined}
          displayBoundaryFaceIndices={magneticBoundaryFaceIndices}
          displayElementIndices={magneticElementIndices}
          qualityPerFace={qualityPerFace}
          shrinkFactor={shrinkFactor}
          clipEnabled={clipEnabled}
          clipAxis={clipAxis}
          clipPos={clipPos}
          globalCenter={dynamicGeomCenter}
          onFaceClick={onFaceClick}
          onFaceHover={onFaceHover}
          onFaceUnhover={onFaceUnhover}
          onFaceContextMenu={onFaceContextMenu}
          showSurfacePass={showSurfacePass}
          showSurfaceHiddenEdgesPass={showSurfaceHiddenEdgesPass}
          showSurfaceVisibleEdgesPass={showSurfaceVisibleEdgesPass}
          showVolumeHiddenEdgesPass={showVolumeHiddenEdgesPass}
          showVolumeVisibleEdgesPass={showVolumeVisibleEdgesPass}
          showPointsPass={showPointsPass}
          enableGeometryCompaction={enableGeometryCompaction}
          enableGeometryNormals={enableGeometryNormals}
          enableGeometryVertexColors={enableGeometryVertexColors}
          enableGeometryPointerInteractions={enableGeometryPointerInteractions}
          enableGeometryHoverInteractions={enableGeometryHoverInteractions}
        />
      ) : null}

      {/* Arrow visibility is controlled entirely via effectiveShowArrows
          (which already incorporates the diagnostic showArrowLayer flag
           through ArrowRenderState). No separate showArrowLayer gate needed. */}
      <FemArrows
        meshData={meshData}
        field={arrowField}
        arrowDensity={arrowDensity}
        colorMode={arrowColorMode}
        monoColor={arrowMonoColor}
        alpha={arrowAlpha}
        lengthScale={arrowLengthScale}
        thickness={arrowThickness}
        samplingMode={arrowSamplingMode}
        center={dynamicGeomCenter}
        maxDim={dynamicMaxDim}
        visible={effectiveShowArrows}
        activeNodeMask={arrowActiveNodeMask}
        boundaryFaceIndices={arrowBoundaryFaceIndices}
        onSampledCount={onArrowSampledCount}
      />
      {showSelectionHighlight ? (
        <FemHighlightView meshData={meshData} selectedFaces={selectedFaces} center={dynamicGeomCenter} />
      ) : null}

      {showSceneGeometry ? (
        <ObjectOverlayMeshes
          overlays={objectOverlays}
          geomCenter={dynamicGeomCenter}
          selectedObjectId={selectedObjectId}
          activeTransformScope={activeTransformScope}
          onGeometryTranslate={onGeometryTranslate}
          onObjectSelect={onObjectSelect}
        />
      ) : null}

      {showAntennaOverlays && antennaOverlays.length > 0 && !Boolean(focusedEntityId) ? (
        <AntennaOverlayMeshes
          overlays={antennaOverlays}
          geomCenter={dynamicGeomCenter}
          selectedAntennaId={selectedAntennaId}
          onAntennaTranslate={onAntennaTranslate}
        />
      ) : null}

      {showSceneAxes ? (
        <SceneAxes3D worldExtent={axesWorldExtent} center={axesCenter} sceneScale={[1, 1, 1]} />
      ) : null}

      {universeWireframeVisible && universeWireframeExtent ? (
        <mesh position={universeWireframeCenter ?? [0, 0, 0]} renderOrder={18}>
          <boxGeometry args={universeWireframeExtent} />
          <meshBasicMaterial
            color="#94a3b8"
            transparent
            opacity={0.22}
            wireframe
            depthWrite={false}
          />
        </mesh>
      ) : null}
    </>
  );
});
