import {
  Box3,
  Matrix4,
  Quaternion,
  Ray,
  Sphere,
  Vector3,
  type Object3D,
} from "three";

import type { RegionOverlayModel } from "./regionOverlayModel";

export interface PickedRegionOverlay {
  objectId: string;
  regionId: string;
}

interface IntersectionLike {
  object?: Object3D | null;
}

interface EventLike {
  intersections?: readonly IntersectionLike[] | null;
}

const REGION_OVERLAY_NAME_PREFIX = "region-overlay:";

function objectHasRegionOverlayAncestor(object: Object3D | null | undefined): boolean {
  let current: Object3D | null | undefined = object;
  while (current) {
    if (current.name.startsWith(REGION_OVERLAY_NAME_PREFIX)) return true;
    current = current.parent;
  }
  return false;
}

export function eventIntersectsRegionOverlay(event: EventLike): boolean {
  return Boolean(
    event.intersections?.some((intersection) =>
      objectHasRegionOverlayAncestor(intersection.object),
    ),
  );
}

export function pickRegionOverlayFromRay(
  ray: Ray,
  models: readonly RegionOverlayModel[],
): PickedRegionOverlay | null {
  let best:
    | {
        distance: number;
        selection: PickedRegionOverlay;
      }
    | null = null;

  for (const model of models) {
    const hit = intersectRegionOverlayModel(ray, model);
    if (hit === null) continue;
    if (!best || hit.distance < best.distance) {
      best = {
        distance: hit.distance,
        selection: { objectId: model.objectId, regionId: model.regionId },
      };
    }
  }

  return best?.selection ?? null;
}

function intersectRegionOverlayModel(
  ray: Ray,
  model: RegionOverlayModel,
): { distance: number } | null {
  const ownerMatrix = new Matrix4().compose(
    new Vector3(...model.transform.position),
    new Quaternion(...model.transform.quaternion),
    new Vector3(...model.transform.scale),
  );

  if (model.kind === "sphere") {
    return intersectSphereRegion(ray, ownerMatrix, model.center, model.radius);
  }

  const shapeMatrix = ownerMatrix.clone().multiply(
    new Matrix4().makeTranslation(...model.center),
  );

  if (model.kind === "box") {
    return intersectBoxRegion(ray, shapeMatrix, model.size);
  }

  const target = new Vector3(...model.axis).normalize();
  shapeMatrix.multiply(
    new Matrix4().makeRotationFromQuaternion(
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), target),
    ),
  );
  return intersectCylinderRegion(ray, shapeMatrix, model.radius, model.height);
}

function intersectSphereRegion(
  ray: Ray,
  ownerMatrix: Matrix4,
  center: readonly [number, number, number],
  radius: number,
): { distance: number } | null {
  const inverse = ownerMatrix.clone().invert();
  const localRay = ray.clone().applyMatrix4(inverse);
  const localHit = localRay.intersectSphere(
    new Sphere(new Vector3(...center), radius),
    new Vector3(),
  );
  if (!localHit) return null;
  return worldHitDistance(ray, localHit.applyMatrix4(ownerMatrix));
}

function intersectBoxRegion(
  ray: Ray,
  shapeMatrix: Matrix4,
  size: readonly [number, number, number],
): { distance: number } | null {
  const inverse = shapeMatrix.clone().invert();
  const localRay = ray.clone().applyMatrix4(inverse);
  const localHit = localRay.intersectBox(
    new Box3(
      new Vector3(-size[0] / 2, -size[1] / 2, -size[2] / 2),
      new Vector3(size[0] / 2, size[1] / 2, size[2] / 2),
    ),
    new Vector3(),
  );
  if (!localHit) return null;
  return worldHitDistance(ray, localHit.applyMatrix4(shapeMatrix));
}

function intersectCylinderRegion(
  ray: Ray,
  shapeMatrix: Matrix4,
  radius: number,
  height: number,
): { distance: number } | null {
  const inverse = shapeMatrix.clone().invert();
  const localRay = ray.clone().applyMatrix4(inverse);
  const dx = localRay.direction.x;
  const dz = localRay.direction.z;
  const ox = localRay.origin.x;
  const oz = localRay.origin.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - radius * radius;
  const discriminant = b * b - 4 * a * c;
  const halfHeight = height / 2;
  const candidates: number[] = [];
  if (a > 0 && discriminant >= 0) {
    const sqrt = Math.sqrt(discriminant);
    candidates.push(
      ...[(-b - sqrt) / (2 * a), (-b + sqrt) / (2 * a)].filter(
        (value) => value >= 0,
      ),
    );
  }

  if (Math.abs(localRay.direction.y) > 1e-12) {
    for (const capY of [-halfHeight, halfHeight]) {
      const distance = (capY - localRay.origin.y) / localRay.direction.y;
      if (distance < 0) continue;
      const x = localRay.origin.x + localRay.direction.x * distance;
      const z = localRay.origin.z + localRay.direction.z * distance;
      if (x * x + z * z <= radius * radius) candidates.push(distance);
    }
  }

  for (const distance of candidates.sort((left, right) => left - right)) {
    const y = localRay.origin.y + localRay.direction.y * distance;
    if (y < -halfHeight || y > halfHeight) continue;
    const localHit = localRay.at(distance, new Vector3());
    return worldHitDistance(ray, localHit.applyMatrix4(shapeMatrix));
  }

  return null;
}

function worldHitDistance(
  ray: Ray,
  worldHit: Vector3,
): { distance: number } | null {
  const distance = ray.origin.distanceTo(worldHit);
  return Number.isFinite(distance) && distance >= 0 ? { distance } : null;
}
