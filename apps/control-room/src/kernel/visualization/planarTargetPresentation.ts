import type { VisualizationStateResource } from "../api/apiTypes";
import {
  type VisualizationTargetRef,
  visualizationStateScopeIdForTarget,
} from "./ObjectVisualizationController";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarTargetOverride = NonNullable<Planar["target_overrides"]>[number];
type PlanarWireframeStyle = Planar["wireframe_style"];
const NO_TARGET_REASON =
  "The selected item has no canonical visualization target.";
const UNSUPPORTED_TARGET_REASON =
  "Planar wireframe overrides support only Airbox, objects, and mesh parts.";
const DORMANT_TARGET_REASON =
  "The selected target is absent from the current visualization registry; its saved planar override is dormant.";
const REGISTRY_UNAVAILABLE_REASON =
  "Visualization target registry is unavailable.";

export function planarTargetPresentationReason(
  target: VisualizationTargetRef | null,
  registry: VisualizationStateResource["targets"] | null | undefined,
): string | undefined {
  if (!target) {
    return NO_TARGET_REASON;
  }
  if (
    target.kind !== "airbox" &&
    target.kind !== "object" &&
    target.kind !== "part"
  ) {
    return UNSUPPORTED_TARGET_REASON;
  }
  if (!registry) return REGISTRY_UNAVAILABLE_REASON;
  const scopeId = visualizationStateScopeIdForTarget(target);
  const registryEntries = [
    registry.airbox,
    ...registry.objects,
    ...registry.parts,
  ];
  if (!registryEntries.some(
    (entry) =>
      entry.scope === target.kind &&
      entry.scope_id === scopeId,
  )) {
    return DORMANT_TARGET_REASON;
  }
  return undefined;
}

export function findPlanarTargetWireframeOverride(
  overrides: readonly PlanarTargetOverride[] | null | undefined,
  target: VisualizationTargetRef,
): PlanarTargetOverride | undefined {
  if (
    target.kind !== "airbox" &&
    target.kind !== "object" &&
    target.kind !== "part"
  ) return undefined;
  const scopeId = visualizationStateScopeIdForTarget(target);
  return (overrides ?? []).find(
    (entry) =>
      entry.scope === target.kind && entry.scope_id === scopeId,
  );
}

export function resolvePlanarTargetWireframeStyle(
  fallback: PlanarWireframeStyle,
  overrides: readonly PlanarTargetOverride[] | null | undefined,
  target: VisualizationTargetRef,
): PlanarWireframeStyle {
  return (
    findPlanarTargetWireframeOverride(overrides, target)?.wireframe_style ??
    fallback
  );
}
