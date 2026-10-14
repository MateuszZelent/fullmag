import type { SceneResource } from "@/kernel/api/apiTypes";

export function isAntennaVisualizationObject(scene: SceneResource | null, objectId: string | null): boolean {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  if (!object) return false;
  const hint = (object as Record<string, unknown>).visualization_hint as { role?: unknown } | null | undefined;
  if (object.role && object.role !== "magnet") return object.role === "antenna";
  return hint?.role === "antenna" || object.tags?.includes("role:antenna") === true;
}
