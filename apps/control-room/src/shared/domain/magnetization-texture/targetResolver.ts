import type {
  MagnetizationTextureTarget,
  MagnetizationTextureTargetInput,
} from "./types";

const REGION_TEXTURE_KINDS = new Set([
  "object.region.texture",
  "object.region-magnetic-texture",
  "ribbon.magnetization-texture.assign-uniform",
  "ribbon.magnetization-texture.assign-random-seeded",
  "ribbon.magnetization-texture.assign-vortex",
]);

export function resolveMagnetizationTextureTarget(
  input: MagnetizationTextureTargetInput,
): MagnetizationTextureTarget | null {
  const objectId = normalizeId(input.objectId);
  if (!objectId) return null;

  const regionId = normalizeId(input.regionId);
  if (regionId && REGION_TEXTURE_KINDS.has(input.kind ?? "")) {
    return { kind: "region", objectId, regionId };
  }

  return { kind: "object", objectId };
}

export function sameMagnetizationTextureTarget(
  left: MagnetizationTextureTarget | null,
  right: MagnetizationTextureTarget | null,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "object" && right.kind === "object") {
    return left.objectId === right.objectId;
  }
  if (left.kind === "region" && right.kind === "region") {
    return left.objectId === right.objectId && left.regionId === right.regionId;
  }
  return false;
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
