import type {
  FemLiveMesh,
  MagnetizationAsset,
  SceneDocument,
  SceneObject,
  TextureTransform3D,
  Transform3D,
} from "@/lib/session/types";
import { normalizeMagnetizationAsset } from "@/lib/session/magnetizationCanonical";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

export interface AuthoredMagnetizationPreview {
  vectors: Float64Array;
  revision: string;
  objectId: string;
  presetKind: string;
}

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const n = norm(v);
  return n > 1e-30 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function rotateByQuat(point: Vec3, quat: Quat): Vec3 {
  const qvec: Vec3 = [quat[0], quat[1], quat[2]];
  const uv = cross(qvec, point);
  const uuv = cross(qvec, uv);
  return [
    point[0] + 2 * (quat[3] * uv[0] + uuv[0]),
    point[1] + 2 * (quat[3] * uv[1] + uuv[1]),
    point[2] + 2 * (quat[3] * uv[2] + uuv[2]),
  ];
}

function normalizedInverseQuat(quat: Quat): Quat {
  const q: Quat = [-quat[0], -quat[1], -quat[2], quat[3]];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-30 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [0, 0, 0, 1];
}

function inverseObjectTransform(point: Vec3, transform: Transform3D): Vec3 {
  const pivot = transform.pivot;
  let p: Vec3 = [
    point[0] - transform.translation[0] - pivot[0],
    point[1] - transform.translation[1] - pivot[1],
    point[2] - transform.translation[2] - pivot[2],
  ];
  p = rotateByQuat(p, normalizedInverseQuat(transform.rotation_quat));
  return [
    p[0] / (Math.abs(transform.scale[0]) > 1e-30 ? transform.scale[0] : 1) + pivot[0],
    p[1] / (Math.abs(transform.scale[1]) > 1e-30 ? transform.scale[1] : 1) + pivot[1],
    p[2] / (Math.abs(transform.scale[2]) > 1e-30 ? transform.scale[2] : 1) + pivot[2],
  ];
}

function inverseTextureTransform(point: Vec3, transform: TextureTransform3D): Vec3 {
  const pivot = transform.pivot;
  let p: Vec3 = [
    point[0] - transform.translation[0] - pivot[0],
    point[1] - transform.translation[1] - pivot[1],
    point[2] - transform.translation[2] - pivot[2],
  ];
  p = rotateByQuat(p, normalizedInverseQuat(transform.rotation_quat));
  return [
    p[0] / (Math.abs(transform.scale[0]) > 1e-30 ? transform.scale[0] : 1) + pivot[0],
    p[1] / (Math.abs(transform.scale[1]) > 1e-30 ? transform.scale[1] : 1) + pivot[1],
    p[2] / (Math.abs(transform.scale[2]) > 1e-30 ? transform.scale[2] : 1) + pivot[2],
  ];
}

function planeCoords(point: Vec3, plane: string): Vec3 {
  if (plane === "xz") return [point[0], point[2], point[1]];
  if (plane === "yz") return [point[1], point[2], point[0]];
  return [point[0], point[1], point[2]];
}

function planeVecToWorld(mu: number, mv: number, mn: number, plane: string): Vec3 {
  if (plane === "xz") return [mu, mn, mv];
  if (plane === "yz") return [mn, mu, mv];
  return [mu, mv, mn];
}

function numericParam(params: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringParam(params: Record<string, unknown> | null, key: string, fallback: string): string {
  const value = params?.[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function samplePreset(asset: MagnetizationAsset, point: Vec3): Vec3 | null {
  const normalizedAsset = normalizeMagnetizationAsset(asset);
  if (normalizedAsset.kind !== "preset_texture") return null;
  const kind = normalizedAsset.preset_kind ?? "uniform";
  const params = normalizedAsset.preset_params ?? null;
  if (kind === "uniform") {
    const raw = Array.isArray(params?.direction) && params.direction.length >= 3
      ? [Number(params.direction[0]), Number(params.direction[1]), Number(params.direction[2])] as Vec3
      : [1, 0, 0] as Vec3;
    return normalize(raw);
  }
  if (kind === "random_seeded") {
    const seedBase = numericParam(params, "seed", 1);
    const x = point[0] * 1e9;
    const y = point[1] * 1e9;
    const z = point[2] * 1e9;
    const u1Raw = Math.sin(seedBase * 12.9898 + x * 78.233 + y * 37.719 + z * 11.137) * 43_758.5453;
    const u2Raw = Math.sin(seedBase * 4.1414 + x * 93.989 + y * 67.345 + z * 45.678) * 43_758.5453;
    const u1 = u1Raw - Math.floor(u1Raw);
    const u2 = u2Raw - Math.floor(u2Raw);
    const phi = u1 * 2 * Math.PI;
    const cosTheta = 2 * u2 - 1;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    return [sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta];
  }
  if (kind !== "vortex" && kind !== "antivortex") return null;
  const plane = stringParam(params, "plane", "xy");
  const p = planeCoords(point, plane);
  const phi = Math.atan2(p[1], p[0]);
  const circulationBase = numericParam(params, "circulation", 1);
  const circulation = (kind === "antivortex" ? -circulationBase : circulationBase) >= 0 ? 1 : -1;
  const polarity = numericParam(params, "core_polarity", 1) >= 0 ? 1 : -1;
  const coreRadius = Math.max(1e-30, numericParam(params, "core_radius", 1e-9));
  const r = Math.hypot(p[0], p[1]);
  const mn = polarity * Math.exp(-((r / coreRadius) ** 2));
  const mu = -circulation * Math.sin(phi);
  const mv = circulation * Math.cos(phi);
  return normalize(planeVecToWorld(mu, mv, mn, plane));
}

function meshNode(mesh: FemLiveMesh, index: number): Vec3 | null {
  const flat = mesh.topology_buffers?.nodes;
  if (flat && index * 3 + 2 < flat.length) {
    return [Number(flat[index * 3]), Number(flat[index * 3 + 1]), Number(flat[index * 3 + 2])];
  }
  const node = mesh.nodes[index];
  return node ? [Number(node[0]), Number(node[1]), Number(node[2])] : null;
}

function nodeIndicesForObject(mesh: FemLiveMesh, object: SceneObject): number[] {
  const part = (mesh.mesh_parts ?? []).find((entry) =>
    entry.role === "magnetic_object" &&
    (entry.object_id === object.id || entry.object_id === object.name || entry.geometry_id === object.id || entry.geometry_id === object.name)
  );
  if (part) {
    if (part.node_indices.length > 0) return [...part.node_indices];
    return Array.from({ length: part.node_count }, (_, index) => part.node_start + index);
  }
  const segment = (mesh.object_segments ?? []).find((entry) =>
    entry.object_id === object.id || entry.object_id === object.name || entry.geometry_id === object.id || entry.geometry_id === object.name
  );
  if (!segment) return [];
  return Array.from({ length: segment.node_count }, (_, index) => segment.node_start + index);
}

export function resolveMagneticTextureObject(
  scene: SceneDocument | null | undefined,
  selectedSidebarNodeId: string | null | undefined,
  selectedObjectId: string | null | undefined,
): SceneObject | null {
  if (!scene) return null;
  if (selectedObjectId) {
    const selected = scene.objects.find((object) => object.id === selectedObjectId || object.name === selectedObjectId);
    if (selected) return selected;
  }
  if (!selectedSidebarNodeId?.startsWith("mag-")) return null;
  return scene.objects.find((object) => {
    const candidates = [`mag-${object.name}`, `mag-${object.id}`];
    return candidates.some((candidate) =>
      selectedSidebarNodeId === candidate || selectedSidebarNodeId.startsWith(`${candidate}-`)
    );
  }) ?? null;
}

export function buildAuthoredMagnetizationPreview(args: {
  scene: SceneDocument | null | undefined;
  mesh: FemLiveMesh | null | undefined;
  selectedSidebarNodeId: string | null | undefined;
  selectedObjectId: string | null | undefined;
  activeTransformScope: "object" | "texture" | null;
  includeAllObjects?: boolean;
}): AuthoredMagnetizationPreview | null {
  const {
    scene,
    mesh,
    selectedSidebarNodeId,
    selectedObjectId,
    activeTransformScope,
    includeAllObjects = false,
  } = args;
  if (!scene || !mesh) return null;
  const nodeCount =
    mesh.node_count
    ?? (mesh.topology_buffers?.nodes ? Math.floor(mesh.topology_buffers.nodes.length / 3) : mesh.nodes.length);
  if (!nodeCount) return null;

  const selectedObject = resolveMagneticTextureObject(scene, selectedSidebarNodeId, selectedObjectId);
  const shouldUseSelectedOnly =
    Boolean(selectedObject) &&
    (includeAllObjects || activeTransformScope === "texture" || Boolean(selectedSidebarNodeId?.startsWith("mag-")));
  if (!includeAllObjects && !shouldUseSelectedOnly) return null;

  const objects = shouldUseSelectedOnly && selectedObject
    ? [selectedObject]
    : scene.objects.filter((object) => Boolean(object.magnetization_ref));
  if (!objects.length) return null;

  const vectors = new Float64Array(nodeCount * 3);
  const revisionParts: string[] = [
    "authored-magnetization",
    String(scene.revision),
    mesh.generation_id ?? mesh.mesh_id ?? "no-mesh-generation",
    String(nodeCount),
  ];
  let sampledObjects = 0;
  let primaryObjectId = selectedObject?.id ?? objects[0]?.id ?? "none";
  let primaryPresetKind = "none";

  for (const object of objects) {
    if (!object.magnetization_ref) continue;
    const asset = scene.magnetization_assets.find((entry) => entry.id === object.magnetization_ref);
    if (!asset) continue;
    const normalizedAsset = normalizeMagnetizationAsset(asset);
    if (normalizedAsset.kind !== "preset_texture") continue;
    const presetKind = normalizedAsset.preset_kind ?? "preset_texture";
    if (sampledObjects === 0) {
      primaryObjectId = object.id;
      primaryPresetKind = presetKind;
    }
    const nodeIndices = nodeIndicesForObject(mesh, object).filter((index) => index >= 0 && index < nodeCount);
    if (!nodeIndices.length) continue;
    const mappingSpace = normalizedAsset.mapping?.space === "world" ? "world" : "object";
    const projection = normalizedAsset.mapping?.projection ?? "object_local";
    for (const nodeIndex of nodeIndices) {
      const world = meshNode(mesh, nodeIndex);
      if (!world) continue;
      let point = mappingSpace === "world" ? world : inverseObjectTransform(world, object.transform);
      if (projection === "planar_xy") point = [point[0], point[1], 0];
      if (projection === "planar_xz") point = [point[0], point[2], 0];
      if (projection === "planar_yz") point = [point[1], point[2], 0];
      point = inverseTextureTransform(point, normalizedAsset.texture_transform);
      const value = samplePreset(normalizedAsset, point);
      if (!value) continue;
      vectors[nodeIndex * 3] = value[0];
      vectors[nodeIndex * 3 + 1] = value[1];
      vectors[nodeIndex * 3 + 2] = value[2];
    }
    sampledObjects += 1;
    revisionParts.push(
      object.id,
      object.magnetization_ref,
      presetKind,
      JSON.stringify(asset.preset_params ?? {}),
      JSON.stringify(asset.texture_transform),
    );
  }

  if (sampledObjects === 0) return null;

  return {
    vectors,
    objectId: primaryObjectId,
    presetKind: primaryPresetKind,
    revision: revisionParts.join(":"),
  };
}
