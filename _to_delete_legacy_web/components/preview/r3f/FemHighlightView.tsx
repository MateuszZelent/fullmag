import React, { useMemo, useEffect, useId } from "react";
import * as THREE from "three";
import type { FemMeshData } from "../fem/femMeshTypes";
import {
  estimateThreeBufferGeometryBytes,
  releaseViewportResource,
  trackViewportResource,
} from "@/lib/debug/viewportResourceManager";

interface FemHighlightViewProps {
  meshData: FemMeshData;
  selectedFaces: number[];
  center: THREE.Vector3;
}

export function FemHighlightView({ meshData, selectedFaces, center }: FemHighlightViewProps) {
  const resourceOwner = `FemHighlightView:${useId()}`;
  const resourceKey = `${resourceOwner}:geometry`;
  const geometry = useMemo(() => {
    if (selectedFaces.length === 0) return null;

    const { nodes, boundaryFaces } = meshData;
    const indices: number[] = [];
    selectedFaces.forEach((fIdx) => {
      const base = fIdx * 3;
      if (base + 2 < boundaryFaces.length) {
        indices.push(boundaryFaces[base], boundaryFaces[base + 1], boundaryFaces[base + 2]);
      }
    });

    if (indices.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) positions[i] = nodes[i];
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geom.translate(-center.x, -center.y, -center.z);

    return geom;
  }, [selectedFaces, meshData, center]);

  useEffect(() => {
    if (!geometry) {
      releaseViewportResource(resourceKey);
      return;
    }
    trackViewportResource({
      key: resourceKey,
      owner: resourceOwner,
      label: "FEM highlight geometry",
      resource: geometry,
      estimatedBytes: estimateThreeBufferGeometryBytes(geometry),
      dispose: () => geometry.dispose(),
    });
    return () => {
      releaseViewportResource(resourceKey);
    };
  }, [geometry, resourceKey, resourceOwner]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} renderOrder={20}>
      <meshPhongMaterial
        color={0x63b3ed}
        emissive={0x3182ce}
        emissiveIntensity={0.5}
        side={THREE.DoubleSide}
        transparent
        opacity={0.6}
        depthTest
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
      />
    </mesh>
  );
}
