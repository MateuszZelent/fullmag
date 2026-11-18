type Projection = "perspective" | "orthographic";
type ProjectionPatch = (patch: { projection: Projection }) => void;
interface ProjectionOwner { token: symbol; projection: Projection; patch: ProjectionPatch }
let activeOwner: ProjectionOwner | null = null;

/** Commands target the mounted camera owner; no historical camera is written through the live registry. */
export function registerViewport3DProjectionOwner(projection: Projection, patch: ProjectionPatch) {
  const owner: ProjectionOwner = { token: Symbol("3d-camera-projection"), projection, patch };
  activeOwner = owner;
  return () => { if (activeOwner?.token === owner.token) activeOwner = null; };
}
export function getViewport3DProjection() { return activeOwner?.projection ?? null; }
export function hasViewport3DProjectionOwner() { return activeOwner !== null; }
export function toggleRegisteredViewport3DProjection(): boolean {
  if (!activeOwner) return false;
  const owner = activeOwner;
  const previous = owner.projection;
  owner.projection = previous === "perspective" ? "orthographic" : "perspective";
  try { owner.patch({ projection: owner.projection }); }
  catch (error) { owner.projection = previous; throw error; }
  return true;
}
