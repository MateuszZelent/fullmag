import type { Object3D } from "three";

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
