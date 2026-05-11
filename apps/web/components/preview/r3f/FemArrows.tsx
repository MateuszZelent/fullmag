import React, { useMemo, useRef, useEffect, useId } from "react";
import * as THREE from "three";
import type {
  FemMeshData,
  FemColorField,
  FemArrowColorMode,
  ArrowSamplingMode,
} from "../fem/femMeshTypes";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";
import { maskKind } from "../fem/femNodeMask";
import { RENDER_POLICIES_V2 } from "../shared/renderPolicyV2";
import { useBatchedInvalidate } from "./useBatchedInvalidate";
import {
  type ArrowLengthMode,
  buildFemArrowGeometryPayload,
  buildFemArrowColorPayload,
  useFemArrowInstanceBufferUpload,
  useFemArrowSamplingResource,
  useStableFemArrowCapacity,
} from "./femArrowResources";
import {
  estimateThreeBufferGeometryBytes,
  releaseViewportResource,
  trackViewportResource,
} from "@/lib/debug/viewportResourceManager";

interface FemArrowsProps {
  meshData: FemMeshData;
  field: FemColorField;
  arrowDensity: number;
  colorMode?: FemArrowColorMode;
  monoColor?: string;
  alpha?: number;
  lengthScale?: number;
  thickness?: number;
  center: THREE.Vector3;
  maxDim: number;
  visible: boolean;
  activeNodeMask?: Uint8Array | boolean[] | null;
  boundaryFaceIndices?: number[] | null;
  lengthMode?: ArrowLengthMode;
  samplingMode?: ArrowSamplingMode;
  /** Reports the final sampled node count after density filtering. */
  onSampledCount?: (count: number | undefined) => void;
}

/* ── Arrow template geometry — only depends on maxDim ───────────────── */
export function resolveFemArrowTemplateScale(maxDim: number): number {
  return Number.isFinite(maxDim) && maxDim > 0 ? maxDim * 0.035 : 0;
}

function useArrowTemplate() {
  return useMemo(() => {
    const arrowLen = 1;
    const shaftRadius = arrowLen * 0.08;
    const headRadius = arrowLen * 0.20;
    const headLen = arrowLen * 0.35;
    const shaftLen = arrowLen - headLen;

    const shaft = new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLen, 6);
    shaft.rotateX(Math.PI / 2);
    shaft.translate(0, 0, shaftLen / 2);
    
    const head = new THREE.ConeGeometry(headRadius, headLen, 6);
    head.rotateX(Math.PI / 2);
    head.translate(0, 0, shaftLen + headLen / 2);

    const shaftPos = shaft.getAttribute("position") as THREE.BufferAttribute;
    const headPos = head.getAttribute("position") as THREE.BufferAttribute;
    const totalVerts = shaftPos.count + headPos.count;
    const positions = new Float32Array(totalVerts * 3);
    const normals = new Float32Array(totalVerts * 3);
    positions.set(new Float32Array(shaftPos.array), 0);
    positions.set(new Float32Array(headPos.array), shaftPos.count * 3);
    const shaftNorm = shaft.getAttribute("normal") as THREE.BufferAttribute;
    const headNorm = head.getAttribute("normal") as THREE.BufferAttribute;
    normals.set(new Float32Array(shaftNorm.array), 0);
    normals.set(new Float32Array(headNorm.array), shaftPos.count * 3);

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    merged.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    const baseColors = new Float32Array(totalVerts * 3);
    baseColors.fill(1);
    merged.setAttribute("color", new THREE.BufferAttribute(baseColors, 3));

    const shaftIdx = shaft.getIndex()!;
    const headIdx = head.getIndex()!;
    const indexArr = new Uint32Array(shaftIdx.count + headIdx.count);
    for (let i = 0; i < shaftIdx.count; i++) indexArr[i] = shaftIdx.array[i];
    for (let i = 0; i < headIdx.count; i++) indexArr[shaftIdx.count + i] = headIdx.array[i] + shaftPos.count;
    merged.setIndex(new THREE.BufferAttribute(indexArr, 1));
    merged.translate(0, 0, -arrowLen / 2);

    shaft.dispose();
    head.dispose();
    return merged;
  }, []);
}

export function FemArrows({
  meshData,
  field,
  arrowDensity,
  colorMode = "orientation",
  monoColor = "#00c2ff",
  alpha = 1,
  lengthScale = 1,
  thickness = 1,
  center,
  maxDim,
  visible,
  activeNodeMask,
  boundaryFaceIndices,
  lengthMode = "magnitude",
  samplingMode = "auto",
  onSampledCount,
}: FemArrowsProps) {
  const resourceOwner = `FemArrows:${useId()}`;
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const scheduleInvalidate = useBatchedInvalidate();
  const glyphPolicy = RENDER_POLICIES_V2.glyphs;
  const clampedAlpha = Math.max(0.05, Math.min(1, alpha));
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: glyphPolicy.transparent || clampedAlpha < 0.999,
        opacity: clampedAlpha,
        depthWrite: glyphPolicy.depthWrite,
        depthTest: glyphPolicy.depthTest,
        side: glyphPolicy.side,
        toneMapped: false,
      }),
    [
      clampedAlpha,
      glyphPolicy.depthTest,
      glyphPolicy.depthWrite,
      glyphPolicy.side,
      glyphPolicy.transparent,
    ],
  );

  const templateGeometry = useArrowTemplate();
  const arrowTemplateScale = resolveFemArrowTemplateScale(maxDim);
  const resourceKeys = useMemo(
    () => ({
      template: `${resourceOwner}:template`,
      material: `${resourceOwner}:material`,
      instanceBuffers: `${resourceOwner}:instanceBuffers`,
    }),
    [resourceOwner],
  );

  useEffect(() => {
    trackViewportResource({
      key: resourceKeys.template,
      owner: resourceOwner,
      label: "FEM arrow template geometry",
      resource: templateGeometry,
      estimatedBytes: estimateThreeBufferGeometryBytes(templateGeometry),
      dispose: () => templateGeometry.dispose(),
    });
    return () => {
      releaseViewportResource(resourceKeys.template);
    };
  }, [resourceKeys.template, resourceOwner, templateGeometry]);

  useEffect(() => {
    trackViewportResource({
      key: resourceKeys.material,
      owner: resourceOwner,
      label: "FEM arrow material",
      resource: material,
      estimatedBytes: 4096,
      dispose: () => material.dispose(),
    });
    return () => {
      releaseViewportResource(resourceKeys.material);
    };
  }, [material, resourceKeys.material, resourceOwner]);

  const {
    effectiveNodeMask,
    boundaryCandidateNodes,
    filteredCandidateNodes,
    sampledNodes,
  } = useFemArrowSamplingResource({
    activeNodeMask,
    arrowDensity,
    boundaryFaceIndices,
    meshData,
    samplingMode,
    visible,
  });

  // Report sampled count to parent for ArrowRenderState refinement.
  useEffect(() => {
    if (!visible || !meshData.fieldData) {
      onSampledCount?.(undefined);
      return;
    }
    onSampledCount?.(sampledNodes.length);
  }, [meshData.fieldData, onSampledCount, sampledNodes.length, visible]);

  // Geometry payload: positions / quaternions / scales.
  // Does NOT depend on colorMode/monoColor/field — style changes don't recompute these.
  const { count, positions, quaternions, scales } = useMemo(
    () => buildFemArrowGeometryPayload({
      arrowTemplateScale,
      center,
      lengthMode,
      lengthScale,
      meshData,
      sampledNodes,
      thickness,
      visible,
    }),
    [
      arrowTemplateScale,
      center,
      lengthMode,
      lengthScale,
      meshData,
      sampledNodes,
      thickness,
      visible,
    ],
  );

  // Color payload: only recomputed when style or sampling changes.
  const colors = useMemo(
    () => buildFemArrowColorPayload({
      colorMode,
      field,
      meshData,
      monoColor,
      sampledNodes,
      visible,
    }),
    [colorMode, field, meshData, monoColor, sampledNodes, visible],
  );
  const capacity = useStableFemArrowCapacity(count);
  const instanceColorAttribute = useMemo(() => {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    return attribute;
  }, [capacity]);
  useEffect(() => {
    trackViewportResource({
      key: resourceKeys.instanceBuffers,
      owner: resourceOwner,
      label: "FEM arrow instance buffers",
      resource: instanceColorAttribute,
      estimatedBytes: capacity * (16 + 3) * Float32Array.BYTES_PER_ELEMENT,
      dispose: () => {},
    });
    return () => {
      releaseViewportResource(resourceKeys.instanceBuffers);
    };
  }, [capacity, instanceColorAttribute, resourceKeys.instanceBuffers, resourceOwner]);

  useFemArrowInstanceBufferUpload({
    colors,
    count,
    instanceColorAttribute,
    meshRef,
    positions,
    quaternions,
    renderOrder: glyphPolicy.renderOrder,
    scheduleInvalidate,
    scales,
  });

  if (!visible || count === 0) {
    if (
      visible &&
      count === 0 &&
      effectiveNodeMask &&
      FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
      FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace
    ) {
      writeFrontendDiagnosticConsole("debug", "[FemArrows] zero sampled nodes", {
        boundaryCandidateCount: boundaryCandidateNodes.length,
        filteredCandidateCount: filteredCandidateNodes.length,
        hasFieldData: Boolean(meshData.fieldData),
        quantityDomain: meshData.quantityDomain,
        maskKind: maskKind(effectiveNodeMask),
      });
    }
    return null;
  }

  return (
    <instancedMesh
      ref={meshRef}
      args={[templateGeometry!, material, capacity]}
      frustumCulled={false}
      renderOrder={glyphPolicy.renderOrder}
    >
      <primitive attach="instanceColor" object={instanceColorAttribute} />
    </instancedMesh>
  );
}
