import type { GeometryRealizationResource, SceneResource } from "@/kernel/api/apiTypes";
import { buildAuthoredCpwGeometry, buildAuthoredMicrostripGeometry } from "@/shared/domain/geometry/authoredMicrostripGeometry";
import { calculateAntennaPlacement, type PlacementVector } from "@/shared/domain/geometry/antennaPlacement";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Canonical object geometry is unavailable.");
  return value as Record<string, unknown>;
}

function vector(value: unknown): PlacementVector {
  if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    throw new Error("Canonical world bounds and translations require three finite SI components.");
  }
  return [value[0], value[1], value[2]];
}

export function antennaPlacementTargets(scene: SceneResource | null, antennaId: string) {
  return (scene?.objects ?? []).filter((object) => object.id !== antennaId && Boolean(object.magnetization_ref));
}

/** A vertical AABB clearance, not a minimum Euclidean surface distance or a solver result. */
export function resolveAntennaPlacement(
  scene: SceneResource,
  realization: GeometryRealizationResource,
  antennaId: string,
  targetId: string,
  side: "above" | "below",
  gapM: number,
) {
  if (typeof scene.revision !== "number" || !Number.isSafeInteger(scene.revision) || scene.revision < 0 || realization.source_scene_revision !== scene.revision) {
    throw new Error("Geometry bounds do not belong to the current scene revision. Refresh before placing the antenna.");
  }
  const antenna = scene.objects?.find((object) => object.id === antennaId);
  const target = antennaPlacementTargets(scene, antennaId).find((object) => object.id === targetId);
  if (!antenna || !target) throw new Error("Select an existing magnetic target by object ID.");
  if (antenna.locked) throw new Error("The antenna is locked.");
  const geometry = record(antenna.geometry);
  if (geometry.geometry_kind !== "MicrostripAntennaLayout" && geometry.geometry_kind !== "CPWAntennaLayout") throw new Error("Placement requires a canonical 3D MicrostripAntennaLayout or CPWAntennaLayout.");
  const transform = record(antenna.transform ?? {});
  const rotation = transform.rotation_quat ?? [0, 0, 0, 1];
  const scale = vector(transform.scale ?? [1, 1, 1]);
  // ProblemIR 0.3 public capture supports outer translation only. Never reset an authored transform.
  if (!Array.isArray(rotation) || rotation.length !== 4 || rotation.some((value, axis) => value !== [0, 0, 0, 1][axis]) || scale.some((value) => value !== 1)) {
    throw new Error("Outer Rotate/Scale cannot round-trip through ProblemIR 0.3. Placement preserves them and is unavailable for this object.");
  }
  const targetTransform = record(target.transform ?? {});
  if (vector(targetTransform.pivot ?? [0, 0, 0]).some((value) => value !== 0)) {
    throw new Error("Nonzero target pivot has no canonical bounds contract.");
  }
  const bodies = (realization.bodies ?? []).filter((body) => body.object_id === targetId);
  if (!bodies.length || bodies.some((body) => body.status !== "ready" && body.status !== "hidden")) {
    throw new Error("Current target bounds are unavailable; imported or unresolved geometry cannot be guessed.");
  }
  const targetMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const targetMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies) {
    const min = vector(body.bounds_min), max = vector(body.bounds_max);
    if (min.some((value, axis) => value >= max[axis])) throw new Error("Target bounds are degenerate or unordered.");
    for (let axis = 0; axis < 3; axis++) {
      targetMin[axis] = Math.min(targetMin[axis], min[axis]);
      targetMax[axis] = Math.max(targetMax[axis], max[axis]);
    }
  }
  const preview = geometry.geometry_kind === "CPWAntennaLayout"
    ? buildAuthoredCpwGeometry(geometry.geometry_params, transform)
    : buildAuthoredMicrostripGeometry(geometry.geometry_params, transform);
  return calculateAntennaPlacement(
    { min: preview.boundsMin, max: preview.boundsMax },
    { min: targetMin, max: targetMax },
    vector(transform.translation ?? [0, 0, 0]), side, gapM,
  );
}
