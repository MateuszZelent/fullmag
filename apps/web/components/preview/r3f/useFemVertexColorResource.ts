import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { FemColorField, FemMeshData } from "../fem/femMeshTypes";
import {
  computeVertexColors,
  computeVertexColorsOffThread,
  getSharedVertexColors,
  shouldUseVertexColorWorker,
} from "./femVertexColors";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import { recordViewportLifecycleEventForLabel } from "@/lib/debug/viewportTelemetry";
import { applyLiveBufferTransition } from "./liveBufferAnimation";

function flattenBoundaryFaces(customBoundaryFaces: readonly [number, number, number][]): Uint32Array {
  const flat = new Uint32Array(customBoundaryFaces.length * 3);
  let offset = 0;
  for (const [a, b, c] of customBoundaryFaces) {
    flat[offset] = a;
    flat[offset + 1] = b;
    flat[offset + 2] = c;
    offset += 3;
  }
  return flat;
}

export function useFemVertexColorResource({
  customBoundaryFaces,
  field,
  fieldData,
  fieldRevision,
  geometry,
  meshData,
  nElements,
  nNodes,
  nodes,
  pointsGeometry,
  pointsVertexMap,
  qualityPerFace,
  scheduleInvalidate,
  sharedBaseVertexColors,
  uniformColor,
  vertexMap,
  enableGeometryVertexColors,
  viewportTelemetryLabel,
}: {
  customBoundaryFaces?: readonly [number, number, number][] | null;
  field: FemColorField;
  fieldData: FemMeshData["fieldData"];
  fieldRevision: FemMeshData["fieldRevision"];
  geometry: THREE.BufferGeometry | null;
  meshData: FemMeshData;
  nElements: number;
  nNodes: number;
  nodes: ArrayLike<number>;
  pointsGeometry: THREE.BufferGeometry | null;
  pointsVertexMap: Int32Array | null;
  qualityPerFace?: number[] | null;
  scheduleInvalidate: () => void;
  sharedBaseVertexColors?: Float32Array | null;
  uniformColor?: string;
  vertexMap: Int32Array | null;
  enableGeometryVertexColors: boolean;
  viewportTelemetryLabel?: string;
}): void {
  const colorTransitionCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!geometry) return;
    if (!enableGeometryVertexColors) {
      scheduleInvalidate();
      return;
    }
    let cancelled = false;
    const quantityUploadStart = performance.now();
    recordFrontendPerfSample({
      scope: "QuantitySwitch",
      phase: "geometry-color-upload-start",
      durationMs: 0,
      timestampMs: quantityUploadStart,
      meta: {
        field,
        fieldRevision:
          fieldRevision == null
            ? null
            : typeof fieldRevision === "string"
              ? fieldRevision
              : String(fieldRevision),
      },
    });
    const perfEnabled = FRONTEND_DIAGNOSTIC_FLAGS.femViewport.enableGeometryPerfLogging;
    const totalStart = perfEnabled ? performance.now() : 0;
    const mark = (phase: string, start: number, extra?: Record<string, number | string | boolean | null>) => {
      if (!perfEnabled) return;
      recordFrontendPerfSample({
        scope: "FemGeometry",
        phase,
        durationMs: performance.now() - start,
        timestampMs: performance.now(),
        meta: {
          field,
          nNodes,
          nElements,
          ...extra,
        },
      });
    };
    const runColorUpload = async () => {
      const baseColorStart = perfEnabled ? performance.now() : 0;
      const boundaryFacesForColor = customBoundaryFaces
        ? flattenBoundaryFaces(customBoundaryFaces)
        : meshData.boundaryFaces;
      const workerEligible =
        !sharedBaseVertexColors &&
        shouldUseVertexColorWorker({
          enabled: FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.femVertexColorWorker,
          nNodes,
          field,
          hasUniformColor: Boolean(uniformColor),
        });
      const workerColors = workerEligible
        ? await computeVertexColorsOffThread({
            nNodes,
            field,
            fieldData,
            fieldNComp: meshData.fieldNComp ?? 3,
            nodes,
            boundaryFaces: boundaryFacesForColor,
            qualityPerFace,
          })
        : null;
      if (cancelled) return;
      const baseColors: Float32Array =
        sharedBaseVertexColors && sharedBaseVertexColors.length === nNodes * 3
          ? sharedBaseVertexColors
          : workerColors && workerColors.length === nNodes * 3
            ? workerColors
            : customBoundaryFaces
              ? computeVertexColors(
                  nNodes,
                  field,
                  fieldData,
                  meshData.fieldNComp ?? 3,
                  nodes,
                  boundaryFacesForColor,
                  qualityPerFace,
                )
              : getSharedVertexColors({
                  meshData,
                  field,
                  uniformColor,
                  qualityPerFace,
                });
      mark("colorBaseCompute", baseColorStart, { worker: Boolean(workerColors) });

      const meshApplyStart = perfEnabled ? performance.now() : 0;
      const colorAttr = geometry.getAttribute("color") as THREE.BufferAttribute;
      const meshColorTarget = new Float32Array(colorAttr.array.length);
      if (vertexMap) {
        for (let i = 0; i < vertexMap.length; i += 1) {
          const orig = vertexMap[i];
          meshColorTarget[i * 3] = baseColors[orig * 3];
          meshColorTarget[i * 3 + 1] = baseColors[orig * 3 + 1];
          meshColorTarget[i * 3 + 2] = baseColors[orig * 3 + 2];
        }
      } else {
        const posCount = geometry.getAttribute("position").count;
        for (let i = 0; i < posCount * 3; i += 1) {
          meshColorTarget[i] = baseColors[i];
        }
      }
      colorTransitionCleanupRef.current?.();
      const transitionCleanups: Array<() => void> = [
        applyLiveBufferTransition({
          destination: colorAttr.array as Float32Array,
          target: meshColorTarget,
          maxAnimatedValues: 900_000,
          markNeedsUpdate: () => {
            colorAttr.needsUpdate = true;
          },
          scheduleInvalidate,
        }),
      ];
      mark("colorMeshApply", meshApplyStart, { mapped: Boolean(vertexMap) });
      if (pointsGeometry) {
        const pointsApplyStart = perfEnabled ? performance.now() : 0;
        const pointsColorAttr = pointsGeometry.getAttribute("color") as THREE.BufferAttribute | undefined;
        if (!pointsColorAttr) {
          scheduleInvalidate();
          return;
        }
        const pointsColorTarget = new Float32Array(pointsColorAttr.array.length);
        if (pointsVertexMap) {
          for (let i = 0; i < pointsVertexMap.length; i += 1) {
            const orig = pointsVertexMap[i];
            pointsColorTarget[i * 3] = baseColors[orig * 3];
            pointsColorTarget[i * 3 + 1] = baseColors[orig * 3 + 1];
            pointsColorTarget[i * 3 + 2] = baseColors[orig * 3 + 2];
          }
        } else {
          const colorCount = Math.min(pointsColorAttr.count, Math.floor(baseColors.length / 3));
          for (let i = 0; i < colorCount; i += 1) {
            pointsColorTarget[i * 3] = baseColors[i * 3];
            pointsColorTarget[i * 3 + 1] = baseColors[i * 3 + 1];
            pointsColorTarget[i * 3 + 2] = baseColors[i * 3 + 2];
          }
        }
        transitionCleanups.push(
          applyLiveBufferTransition({
            destination: pointsColorAttr.array as Float32Array,
            target: pointsColorTarget,
            maxAnimatedValues: 900_000,
            markNeedsUpdate: () => {
              pointsColorAttr.needsUpdate = true;
            },
            scheduleInvalidate,
          }),
        );
        mark("colorPointsApply", pointsApplyStart, { mapped: Boolean(pointsVertexMap) });
      }
      colorTransitionCleanupRef.current = () => {
        for (const cleanup of transitionCleanups) {
          cleanup();
        }
      };
      mark("colorTotal", totalStart);
      recordFrontendPerfSample({
        scope: "QuantitySwitch",
        phase: "geometry-color-upload-done",
        durationMs: performance.now() - quantityUploadStart,
        timestampMs: performance.now(),
        meta: {
          field,
          mapped: Boolean(vertexMap),
          pointsMapped: Boolean(pointsVertexMap),
          worker: Boolean(workerColors),
          fieldRevision:
            fieldRevision == null
              ? null
              : typeof fieldRevision === "string"
                ? fieldRevision
                : String(fieldRevision),
        },
      });
      if (viewportTelemetryLabel) {
        recordViewportLifecycleEventForLabel(viewportTelemetryLabel, "field_buffer_update");
      }
    };
    void runColorUpload();
    return () => {
      cancelled = true;
      colorTransitionCleanupRef.current?.();
      colorTransitionCleanupRef.current = null;
    };
  }, [
    customBoundaryFaces,
    field,
    fieldData,
    fieldRevision,
    geometry,
    meshData,
    nElements,
    nNodes,
    nodes,
    pointsGeometry,
    pointsVertexMap,
    qualityPerFace,
    scheduleInvalidate,
    sharedBaseVertexColors,
    uniformColor,
    vertexMap,
    enableGeometryVertexColors,
    viewportTelemetryLabel,
  ]);
}
