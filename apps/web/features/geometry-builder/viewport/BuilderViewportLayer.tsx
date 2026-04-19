"use client";

/**
 * P4 — Builder Viewport Layer
 *
 * Renders geometry builder primitives as wireframe proxies in the R3F viewport.
 * Wires the selected primitive to the TransformGizmoLayer for direct manipulation.
 */

import { useMemo, useCallback } from "react";
import * as THREE from "three";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import { TransformGizmoLayer } from "@/components/preview/transform/TransformGizmoLayer";
import type { PrimitiveNode, Vec3 } from "../model/types";

// ── Geometry factories ────────────────────────────────────────

function boxGeometry(size: Vec3): THREE.BufferGeometry {
  return new THREE.BoxGeometry(size[0], size[2], size[1]); // Y↔Z swap
}

function cylinderGeometry(radius: number, height: number, axis: "x" | "y" | "z"): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, height, 32);
  // CylinderGeometry default is along Y (which is Z in our convention)
  if (axis === "x") {
    geo.rotateZ(Math.PI / 2);
  } else if (axis === "y") {
    geo.rotateX(Math.PI / 2);
  }
  // axis === "z" → default (Three.js Y = physical Z)
  return geo;
}

function sphereGeometry(radius: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(radius, 32, 24);
}

function diskGeometry(radius: number, thickness: number, axis: "x" | "y" | "z"): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, thickness, 32);
  if (axis === "x") {
    geo.rotateZ(Math.PI / 2);
  } else if (axis === "y") {
    geo.rotateX(Math.PI / 2);
  }
  return geo;
}

function triangularPrismGeometry(
  base: number,
  triHeight: number,
  depth: number,
  axis: "x" | "y" | "z",
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-base / 2, 0);
  shape.lineTo(base / 2, 0);
  shape.lineTo(0, triHeight);
  shape.closePath();

  const extrudeSettings = { depth, bevelEnabled: false };
  const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geo.translate(0, 0, -depth / 2);

  // Apply axis rotation
  if (axis === "x") {
    geo.rotateY(Math.PI / 2);
  } else if (axis === "y") {
    // Triangle along Y → rotate to align with physical Y (Three.js Z)
    geo.rotateX(-Math.PI / 2);
  }
  // axis === "z" → default alignment

  return geo;
}

function geometryForPrimitive(node: PrimitiveNode): THREE.BufferGeometry {
  switch (node.params.kind) {
    case "box":
      return boxGeometry(node.params.data.size);
    case "cylinder":
      return cylinderGeometry(
        node.params.data.radius,
        node.params.data.height,
        node.params.data.axis,
      );
    case "sphere":
      return sphereGeometry(node.params.data.radius);
    case "disk":
      return diskGeometry(
        node.params.data.radius,
        node.params.data.thickness,
        node.params.data.axis,
      );
    case "triangular_prism":
      return triangularPrismGeometry(
        node.params.data.base,
        node.params.data.triangleHeight,
        node.params.data.depth,
        node.params.data.axis,
      );
  }
}

// ── Colors ────────────────────────────────────────────────────

const COLOR_DEFAULT = new THREE.Color(0x5af29c);
const COLOR_SELECTED = new THREE.Color(0x6cb8ff);
const COLOR_DISABLED = new THREE.Color(0x555555);
const COLOR_ERROR = new THREE.Color(0xff5555);
const EDGE_COLOR = new THREE.Color(0x888888);

// ── Primitive Mesh ────────────────────────────────────────────

function BuilderPrimitiveMesh({
  node,
  isSelected,
  onClick,
}: {
  node: PrimitiveNode;
  isSelected: boolean;
  onClick: () => void;
}) {
  const geometry = useMemo(() => geometryForPrimitive(node), [node.params]);

  // Physical coords → Three.js scene: swap Y ↔ Z
  const position = useMemo(
    (): [number, number, number] => [
      node.transform.translation[0],
      node.transform.translation[2], // Z → Y
      node.transform.translation[1], // Y → Z
    ],
    [node.transform.translation],
  );

  const scale = useMemo(
    (): [number, number, number] => [
      node.transform.scale[0],
      node.transform.scale[2],
      node.transform.scale[1],
    ],
    [node.transform.scale],
  );

  const color = !node.enabled
    ? COLOR_DISABLED
    : isSelected
      ? COLOR_SELECTED
      : COLOR_DEFAULT;

  if (!node.visible) return null;

  return (
    <group position={position} scale={scale}>
      {/* Solid semi-transparent fill */}
      <mesh geometry={geometry} onClick={(e) => { e.stopPropagation(); onClick(); }}>
        <meshStandardMaterial
          color={color}
          transparent
          opacity={isSelected ? 0.35 : 0.15}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Wireframe edges */}
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={isSelected ? COLOR_SELECTED : EDGE_COLOR} linewidth={1} />
      </lineSegments>
    </group>
  );
}

// ── Universe Wireframe ────────────────────────────────────────

function UniverseWireframe() {
  const universe = useGeometryBuilderStore((s) => s.graph.universe);

  const geometry = useMemo(() => {
    const [sx, sy, sz] = universe.size;
    // Swap Y↔Z for Three.js
    return new THREE.BoxGeometry(sx, sz, sy);
  }, [universe.size]);

  const position = useMemo(
    (): [number, number, number] => [
      universe.origin[0],
      universe.origin[2],
      universe.origin[1],
    ],
    [universe.origin],
  );

  if (!universe.visibility) return null;

  return (
    <group position={position}>
      <lineSegments>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={0x44ccff} linewidth={1} transparent opacity={0.4} />
      </lineSegments>
    </group>
  );
}

// ── Main Layer ────────────────────────────────────────────────

export function BuilderViewportLayer() {
  const builderEnabled = useGeometryBuilderStore((s) => s.builderMode.active);
  const primitives = useGeometryBuilderStore((s) => s.getAllPrimitives());
  const selectedId = useGeometryBuilderStore((s) => s.builderSelection?.primitiveId ?? null);
  const selectBuilderTarget = useGeometryBuilderStore((s) => s.selectBuilderTarget);
  const setPrimitiveTransform = useGeometryBuilderStore((s) => s.setPrimitiveTransform);
  const selectedNode = useGeometryBuilderStore((s) =>
    selectedId ? s.getPrimitive(selectedId) : null,
  );

  const handleGizmoTranslate = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (!selectedNode) return;
      // Reverse Y↔Z swap: scene (dx, dy, dz) → physical (dx, dz, dy)
      const [px, py, pz] = selectedNode.transform.translation;
      setPrimitiveTransform(selectedNode.id, {
        ...selectedNode.transform,
        translation: [px + dx, py + dz, pz + dy],
      });
    },
    [selectedNode, setPrimitiveTransform],
  );

  if (!builderEnabled) return null;

  const gizmoActive = selectedNode !== null && !selectedNode.locked;

  return (
    <group>
      <UniverseWireframe />
      {primitives.map((node) => {
        const isSelected = node.id === selectedId;
        if (isSelected && gizmoActive) {
          // Wrap selected primitive in gizmo
          return (
            <TransformGizmoLayer
              key={node.id}
              active
              onTranslate={handleGizmoTranslate}
            >
              <BuilderPrimitiveMesh
                node={node}
                isSelected
                onClick={() => selectBuilderTarget({ kind: "primitive", primitiveId: node.id })}
              />
            </TransformGizmoLayer>
          );
        }
        return (
          <BuilderPrimitiveMesh
            key={node.id}
            node={node}
            isSelected={false}
            onClick={() => selectBuilderTarget({ kind: "primitive", primitiveId: node.id })}
          />
        );
      })}
    </group>
  );
}
