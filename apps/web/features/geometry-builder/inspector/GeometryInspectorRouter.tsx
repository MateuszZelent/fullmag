"use client";

/**
 * P3 — Geometry Inspector Router
 *
 * Routes to the correct inspector panel based on the current builder
 * selection state:
 *   none      → BuilderOverviewInspector
 *   universe  → BuilderUniverseInspector
 *   primitive → BuilderPrimitiveInspector
 *
 * This is the single entry point wired into BuildRightInspector when
 * the geometry builder is active.
 */

import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import BuilderOverviewInspector from "./BuilderOverviewInspector";
import BuilderUniverseInspector from "./BuilderUniverseInspector";
import BuilderPrimitiveInspector from "./BuilderPrimitiveInspector";

export default function GeometryInspectorRouter() {
  const selection = useGeometryBuilderStore((s) => s.builderSelection);

  if (selection.type === "universe") {
    return <BuilderUniverseInspector />;
  }

  if (selection.type === "primitive") {
    return <BuilderPrimitiveInspector primitiveId={selection.id} />;
  }

  // type === "none" → overview
  return <BuilderOverviewInspector />;
}
