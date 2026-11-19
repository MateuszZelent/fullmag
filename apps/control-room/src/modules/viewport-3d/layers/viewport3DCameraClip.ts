import type { Viewport3DBounds } from "../viewport3dRenderModel";

type Point3 = Readonly<{ x: number; y: number; z: number }>;

/** Depth range in scene units, independent of FOV and the hypothetical fit. */
export function resolveViewport3DCameraDepthRange(
  bounds: Viewport3DBounds | null,
  position: Point3,
  forward: Point3,
  focusDistance: number,
): { near: number; far: number } {
  const radius = bounds && Number.isFinite(bounds.radius) && bounds.radius > 0
    ? bounds.radius : 1e-6;
  const forwardLength = Math.hypot(forward.x, forward.y, forward.z);
  const distance = Number.isFinite(focusDistance) && focusDistance > 0
    ? focusDistance : radius;
  const centerDepth = bounds && forwardLength > 0 && Number.isFinite(forwardLength)
    ? ((bounds.center[0] - position.x) * forward.x
      + (bounds.center[1] - position.y) * forward.y
      + (bounds.center[2] - position.z) * forward.z) / forwardLength
    : distance;
  const depth = Number.isFinite(centerDepth) ? centerDepth : distance;
  // A target far behind the model must not push near through the model. Inside
  // the sphere, its centre can lie on (or behind) the eye plane during a pan;
  // that projected centre depth is not a usable scale for visible surfaces.
  const referenceDepth = Math.min(distance, depth > radius ? depth : radius);
  const frontDepth = depth - radius;
  // A scene/universe bounding sphere may contain the eye while every visible
  // surface is far ahead. Its intersection with the eye plane is not evidence
  // of a surface at 1 pm. Reserve 0.1% of the viewing distance for near clipping;
  // a positive conservative front depth still caps this for close geometry.
  // All floors scale with the view, so nanometres and metres behave alike.
  const near = Math.max(
    Number.MIN_VALUE,
    Math.min(referenceDepth / 1_000, frontDepth > 0 ? frontDepth / 2 : Infinity),
  );
  // Four radii also include the bounds frame, ticks and nearby glyphs. Do not
  // retain a 1 mm floor in a nanometre scene, or use the camera target as far:
  // both waste the linear depth precision of the orthographic projection.
  const far = Math.max(depth + radius * 4, radius * 4, near * 100);
  return { near, far };
}
