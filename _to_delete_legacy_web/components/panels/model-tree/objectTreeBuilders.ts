import type {
  MeshWorkspaceManifestRegionState,
  ScriptBuilderGeometryEntry,
  ScriptBuilderMagnetizationEntry,
} from "@/lib/session/types";
import {
  ensureObjectPhysicsStack,
  magneticInteractionLabel,
} from "@/lib/session/magneticPhysics";
import { buildGeometryBuilderTreeNodes } from "@/features/geometry-builder/tree/builderTreeNodes";
import type {
  BuilderSelectionTarget,
  DirtyState,
  GeometryGraphDocument,
  PrimitiveNode,
} from "@/features/geometry-builder/model/types";
import type { NodeStatus, TreeNodeData } from "./types";

function fmtCompact(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}

function fmtLength(value: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(value)) return "—";
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(2)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(2)} µm`;
  return `${(value * 1e9).toFixed(1)} nm`;
}

function fmtVec(value: [number, number, number] | null | undefined): string {
  if (!value) return "—";
  return value.map((component) => fmtLength(component)).join(" · ");
}

function hasNonZeroVec(value: [number, number, number] | null | undefined): boolean {
  return Boolean(value && value.some((component) => Math.abs(component) > 0));
}

export function buildUniverseChildren(opts: {
  universeDeclaredSize?: [number, number, number] | null;
  universeEffectiveSize?: [number, number, number] | null;
  universeCenter?: [number, number, number] | null;
  universePadding?: [number, number, number] | null;
  universeRole?: string | null;
  domainMeshMode?: string | null;
  airPartElementCount?: number | null;
  airPartNodeCount?: number | null;
  meshStatus?: NodeStatus;
  meshElements?: number;
  meshNodes?: number;
  meshFeOrder?: number | null;
}): TreeNodeData[] {
  const children: TreeNodeData[] = [];
  const effectiveSize = opts.universeEffectiveSize ?? null;
  const declaredSize = opts.universeDeclaredSize ?? null;
  children.push({
    id: "universe-domain-frame",
    label: "Domain Frame",
    icon: "📐",
    status: "ready",
    children: [
      effectiveSize
        ? {
            id: "universe-effective-size",
            label: `Effective extent: ${fmtVec(effectiveSize)}`,
            icon: "📏",
          }
        : null,
      declaredSize
        ? {
            id: "universe-size",
            label: `Declared size: ${fmtVec(declaredSize)}`,
            icon: "◫",
          }
        : null,
      opts.universeCenter
        ? {
            id: "universe-center",
            label: `Center: ${fmtVec(opts.universeCenter)}`,
            icon: "⌖",
          }
        : null,
      hasNonZeroVec(opts.universePadding)
        ? {
            id: "universe-padding",
            label: `Padding: ${fmtVec(opts.universePadding)}`,
            icon: "↔",
          }
        : null,
      opts.universeRole
        ? {
            id: "universe-role",
            label: opts.universeRole,
            icon: "⚙",
          }
        : null,
    ].filter(Boolean) as TreeNodeData[],
  });
  if (opts.domainMeshMode === "shared_domain_mesh_with_air") {
    children.push({
      id: "universe-airbox",
      label: "Airbox",
      icon: "🌐",
      status: "ready",
      badge:
        opts.airPartElementCount != null
          ? `${opts.airPartElementCount.toLocaleString()} el`
          : (opts.airPartNodeCount != null ? `${opts.airPartNodeCount.toLocaleString()} nodes` : undefined),
      children: [
        {
          id: "universe-airbox-mesh",
          label: "Sizing",
          icon: "◫",
        },
      ],
    });
  }
  children.push({
    id: "universe-boundary",
    label: "Outer Boundary",
    icon: "🔲",
    status: "ready",
  });
  if (opts.domainMeshMode !== "shared_domain_mesh_with_air") {
    children.push({
      id: "universe-mesh",
      label: "Domain Mesh",
      icon: "◫",
      badge: opts.meshElements
        ? `${opts.meshElements.toLocaleString()} el`
        : opts.meshNodes
          ? `${opts.meshNodes.toLocaleString()} nodes`
          : "—",
      status: opts.meshStatus ?? "pending",
      children: [
        { id: "universe-mesh-view", label: "Inspector", icon: "👁" },
        {
          id: "universe-mesh-size",
          label: opts.meshFeOrder != null ? `Size · P${opts.meshFeOrder}` : "Size",
          icon: "📏",
        },
        { id: "universe-mesh-statistics", label: "Statistics", icon: "bar-chart-3" },
        { id: "universe-mesh-quality", label: "Quality", icon: "📊" },
        { id: "universe-mesh-pipeline", label: "Pipeline", icon: "🧭" },
      ],
    });
  }
  return children;
}

const GEOMETRY_ICONS: Record<string, string> = {
  Box: "◻",
  Cylinder: "⬡",
  Ellipsoid: "⬭",
  Ellipse: "◯",
  ImportedGeometry: "📦",
  Difference: "✂",
  Union: "∪",
  Intersection: "∩",
};

export function buildObjectNode(objectNode: {
  id: string;
  objectId?: string;
  name: string;
  label: string;
  geometry: ScriptBuilderGeometryEntry;
  meshDirty?: boolean;
  tree: {
    geometry: string;
    material: string;
    region: string;
    mesh: string;
  };
}, authoring?: {
  authoringGraph: GeometryGraphDocument | null;
  authoringDirty: DirtyState | null;
  onAuthoringSelect?: (target: BuilderSelectionTarget) => void;
}, meshManifest?: {
  regions: MeshWorkspaceManifestRegionState[];
  manifestStale: boolean;
}): TreeNodeData {
  const geo = objectNode.geometry;
  const geometryId = objectNode.tree.geometry;
  const regionId = objectNode.tree.region;
  const meshId = objectNode.tree.mesh;

  const authoringChildren = authoring?.authoringGraph && authoring.authoringDirty
    ? buildGeometryBuilderTreeNodes(
        authoring.authoringGraph,
        authoring.authoringDirty,
        authoring.onAuthoringSelect,
      ).children ?? []
    : [];
  const geometryChildren = [
    ...buildGeometryParamChildren(geometryId, geo),
    ...authoringChildren,
  ];
  const authoringMeshDirty = Boolean(
    objectNode.meshDirty ||
    authoring?.authoringDirty?.geometryDraftDirty ||
      authoring?.authoringDirty?.geometryRealizationDirty ||
      authoring?.authoringDirty?.meshDirty,
  );
  const meshNode: TreeNodeData = {
    id: meshId,
    label: "Mesh",
    icon: "◫",
    status: authoringMeshDirty ? "stale" : (geo.mesh?.mode === "custom" ? "ready" : "pending"),
    badge:
      authoringMeshDirty
        ? "Mesh out of date"
        :
      geo.mesh?.mode === "custom"
        ? (geo.mesh.order ? `override · P${geo.mesh.order}` : "override")
        : "inherits",
    children: [
      ...(authoringMeshDirty
        ? [{ id: `${meshId}-authoring-dirty`, label: "Build mesh before compute", icon: "alert-triangle", status: "blocked" as const }]
        : []),
      {
        id: `${meshId}-mode`,
        label:
          geo.mesh?.mode === "custom"
            ? "Mode: local override"
            : "Mode: inherit shared object defaults",
        icon: "⇆",
      },
      {
        id: `${meshId}-hmax`,
        label:
          geo.mesh?.mode === "custom" && geo.mesh.hmax
            ? `Maximum element size: ${geo.mesh.hmax}`
            : "Maximum element size from object defaults",
        icon: "📏",
      },
      ...(geo.mesh?.mode === "custom" && geo.mesh.source
        ? [{ id: `${meshId}-source`, label: geo.mesh.source, icon: "📄" } satisfies TreeNodeData]
        : []),
    ],
  };

  return {
    id: objectNode.id,
    label: objectNode.label,
    icon: GEOMETRY_ICONS[geo.geometry_kind] ?? "📦",
    badge: geo.geometry_kind,
    status: "ready",
    defaultOpen: true,
    children: [
      {
        id: geometryId,
        label: "Geometry",
        icon: "🔷",
        status: "ready",
        defaultOpen: authoringChildren.length > 0,
        children: geometryChildren,
      },
      buildRegionNode(geo, regionId, meshManifest),
      buildMagneticParametersNode(geo, objectNode.name),
      {
        id: `mag-${objectNode.name}`,
        label:
          geo.magnetization.kind === "preset_texture"
            ? `Magnetic Texture — ${magnetizationLabel(geo.magnetization)}`
            : "Magnetic Texture",
        icon: "🧭",
        status: "ready",
        badge:
          geo.magnetization.kind === "preset_texture"
            ? geo.magnetization.preset_kind ?? "preset"
            : geo.magnetization.kind,
        children: [
          {
            id: `mag-${objectNode.name}-kind`,
            label: `m₀: ${magnetizationLabel(geo.magnetization)}`,
            icon: geo.magnetization.kind === "preset_texture" ? "◉" : "◢",
            status: "ready",
          },
          ...(geo.magnetization.kind === "preset_texture"
            ? [
                {
                  id: `mag-${objectNode.name}-transform`,
                  label: "Texture Transform",
                  icon: "⟳",
                  status: "ready" as const,
                  children: [
                    {
                      id: `mag-${objectNode.name}-transform-translate`,
                      label: "Translate",
                      icon: "↔",
                      status: "ready" as const,
                    },
                    {
                      id: `mag-${objectNode.name}-transform-rotate`,
                      label: "Rotate",
                      icon: "⤾",
                      status: "ready" as const,
                    },
                    {
                      id: `mag-${objectNode.name}-transform-scale`,
                      label: "Scale",
                      icon: "⬚",
                      status: "ready" as const,
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      meshNode,
    ],
  };
}

function primitiveDimensionBadge(node: PrimitiveNode): string {
  switch (node.params.kind) {
    case "box":
    case "thin_film":
    case "nanowire":
    case "wedge":
      return fmtVec(node.params.data.size);
    case "cylinder":
    case "pillar":
      return `r=${fmtLength(node.params.data.radius)} h=${fmtLength(node.params.data.height)}`;
    case "sphere":
      return `r=${fmtLength(node.params.data.radius)}`;
    case "ellipsoid":
      return fmtVec(node.params.data.radii);
    case "disk":
      return `r=${fmtLength(node.params.data.radius)} t=${fmtLength(node.params.data.thickness)}`;
    case "ring":
    case "tube":
      return `ro=${fmtLength(node.params.data.outerRadius)} ri=${fmtLength(node.params.data.innerRadius)}`;
    case "triangular_prism":
      return `b=${fmtLength(node.params.data.base)} h=${fmtLength(node.params.data.triangleHeight)}`;
    case "cone":
      return `r=${fmtLength(node.params.data.radiusBottom)} h=${fmtLength(node.params.data.height)}`;
    case "capsule":
      return `r=${fmtLength(node.params.data.radius)} h=${fmtLength(node.params.data.height)}`;
    case "polygon_prism":
      return `${node.params.data.sides} sides · r=${fmtLength(node.params.data.radius)}`;
  }
}

export function buildAuthoringPrimitiveObjectNode(
  node: PrimitiveNode,
  dirty: DirtyState,
  onSelect?: (target: BuilderSelectionTarget) => void,
): TreeNodeData {
  const objectId = `builder-prim-${node.id}`;
  const meshDirty = dirty.geometryDraftDirty || dirty.geometryRealizationDirty || dirty.meshDirty;
  const select = onSelect ? () => onSelect({ type: "primitive", id: node.id }) : undefined;
  return {
    id: objectId,
    label: node.name,
    icon: "◻",
    badge: "draft object",
    status: meshDirty ? "dirty" : "ready",
    defaultOpen: true,
    domain: "build",
    onClick: select,
    children: [
      {
        id: `${objectId}-geometry`,
        label: "Geometry",
        icon: "🔷",
        badge: primitiveDimensionBadge(node),
        status: meshDirty ? "dirty" : "ready",
        defaultOpen: true,
        onClick: select,
        children: [
          {
            id: `${objectId}/params`,
            label: "Parameters",
            icon: "settings",
            badge: primitiveDimensionBadge(node),
            onClick: select,
          },
          {
            id: `${objectId}/transform`,
            label: "Transform",
            icon: "move",
            badge: `pos: ${fmtVec(node.transform.translation)}`,
            onClick: select,
          },
        ],
      },
      {
        id: `${objectId}-mesh`,
        label: "Mesh",
        icon: "◫",
        status: meshDirty ? "stale" : "pending",
        badge: meshDirty ? "Mesh out of date" : "not built",
        children: meshDirty
          ? [
              {
                id: `${objectId}-mesh-build-required`,
                label: "Build mesh before compute",
                icon: "alert-triangle",
                status: "blocked",
              },
            ]
          : undefined,
      },
    ],
  };
}

function buildGeometryParamChildren(
  parentId: string,
  geo: ScriptBuilderGeometryEntry,
): TreeNodeData[] {
  const params = geo.geometry_params;
  const children: TreeNodeData[] = [];

  children.push({
    id: `${parentId}-kind`,
    label: geo.geometry_kind,
    icon: GEOMETRY_ICONS[geo.geometry_kind] ?? "⚙",
  });

  if (geo.geometry_kind === "Box" && Array.isArray(params.size)) {
    const [dx, dy, dz] = (params.size as number[]).map((v) => (v * 1e9).toFixed(1));
    children.push({ id: `${parentId}-size`, label: `Size: ${dx} × ${dy} × ${dz} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Cylinder") {
    const r = params.radius != null ? `r=${((params.radius as number) * 1e9).toFixed(1)}` : "";
    const h = params.height != null ? `h=${((params.height as number) * 1e9).toFixed(1)}` : "";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${r} ${h} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Ellipsoid") {
    const rx = params.rx != null ? ((params.rx as number) * 1e9).toFixed(1) : "?";
    const ry = params.ry != null ? ((params.ry as number) * 1e9).toFixed(1) : "?";
    const rz = params.rz != null ? ((params.rz as number) * 1e9).toFixed(1) : "?";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${rx} × ${ry} × ${rz} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "Ellipse") {
    const rx = params.rx != null ? ((params.rx as number) * 1e9).toFixed(1) : "?";
    const ry = params.ry != null ? ((params.ry as number) * 1e9).toFixed(1) : "?";
    const height = params.height != null ? ((params.height as number) * 1e9).toFixed(1) : "?";
    children.push({ id: `${parentId}-dim`, label: `Dimensions: ${rx} × ${ry} × ${height} nm`, icon: "📏" });
  } else if (geo.geometry_kind === "ImportedGeometry" && typeof params.source === "string") {
    const basename = (params.source as string).split("/").pop() ?? params.source;
    children.push({ id: `${parentId}-source`, label: `Source: ${basename as string}`, icon: "📄" });
    if (params.volume === "surface") {
      children.push({ id: `${parentId}-volume`, label: "Volume: surface", icon: "◌" });
    }
  } else if (geo.geometry_kind === "Difference") {
    children.push({ id: `${parentId}-csg`, label: "CSG difference", icon: "✂" });
  } else if (geo.geometry_kind === "Union") {
    children.push({ id: `${parentId}-csg`, label: "CSG union", icon: "∪" });
  } else if (geo.geometry_kind === "Intersection") {
    children.push({ id: `${parentId}-csg`, label: "CSG intersection", icon: "∩" });
  }

  const translation = Array.isArray(params.translation)
    ? params.translation
    : Array.isArray(params.translate)
      ? params.translate
      : null;
  if (translation && translation.some((value) => Math.abs(Number(value)) > 0)) {
    children.push({
      id: `${parentId}-translation`,
      label: `Translate: ${translation.map((value) => `${(Number(value) * 1e9).toFixed(1)} nm`).join(" · ")}`,
      icon: "↔",
    });
  }

  if (geo.bounds_min && geo.bounds_max) {
    children.push({
      id: `${parentId}-bounds`,
      label: `Bounds: ${fmtVec([
        geo.bounds_max[0] - geo.bounds_min[0],
        geo.bounds_max[1] - geo.bounds_min[1],
        geo.bounds_max[2] - geo.bounds_min[2],
      ])}`,
      icon: "⌗",
    });
  }

  return children;
}

function buildRegionNode(
  geo: ScriptBuilderGeometryEntry,
  regionId: string,
  meshManifest?: {
    regions: MeshWorkspaceManifestRegionState[];
    manifestStale: boolean;
  },
): TreeNodeData {
  const regionName = geo.region_name?.trim() || geo.name;
  const manifestRegions = meshManifest?.regions ?? [];
  return {
    id: regionId,
    label: "Regions",
    icon: "▣",
    status: meshManifest?.manifestStale ? "warning" : "ready",
    badge:
      manifestRegions.length > 0
        ? `${manifestRegions.length} mapped`
        : undefined,
    children: [
      {
        id: `${regionId}-item`,
        label: regionName,
        icon: "◫",
        status: meshManifest?.manifestStale ? "warning" : "ready",
        children: [
          ...(meshManifest?.manifestStale
            ? [
                {
                  id: `${regionId}-stale`,
                  label: "Mesh region mapping is stale",
                  icon: "alert-triangle",
                  status: "warning" as const,
                },
              ]
            : []),
          ...manifestRegions.flatMap((region) => [
            {
              id: `${regionId}-${region.region_id}-material`,
              label: `Material: ${region.material_ref}`,
              icon: "layers",
              status: "ready" as const,
            },
            {
              id: `${regionId}-${region.region_id}-mesh-parts`,
              label:
                region.mesh_part_ids.length > 0
                  ? `Mesh parts: ${region.mesh_part_ids.join(", ")}`
                  : "Mesh parts: none",
              icon: "grid-3x3",
              status: region.mesh_part_ids.length > 0 ? "ready" as const : "pending" as const,
            },
            {
              id: `${regionId}-${region.region_id}-elements`,
              label:
                region.element_count != null
                  ? `${region.element_count.toLocaleString()} elements`
                  : "Elements: unknown",
              icon: "hash",
              status: region.element_count != null ? "ready" as const : "pending" as const,
            },
          ]),
        ],
      },
    ],
  };
}

function buildMagneticParametersNode(
  geo: ScriptBuilderGeometryEntry,
  objectName: string,
): TreeNodeData {
  const mat = geo.material;
  const stack = ensureObjectPhysicsStack(geo.physics_stack, geo.material.Dind);

  const children: TreeNodeData[] = [
    {
      id: `physobj-${objectName}-ms`,
      label: mat.Ms != null ? `Ms = ${fmtCompact(mat.Ms)} A/m` : "Ms (saturation)",
      icon: "𝑀",
      status: mat.Ms != null ? "ready" : "pending",
    },
    {
      id: `physobj-${objectName}-aex`,
      label: mat.Aex != null ? `A = ${mat.Aex.toExponential(1)} J/m` : "A (exchange)",
      icon: "𝐴",
      status: mat.Aex != null ? "ready" : "pending",
    },
    {
      id: `physobj-${objectName}-alpha`,
      label: `α = ${mat.alpha}`,
      icon: "α",
      status: "ready",
    },
  ];

  if (mat.Dind != null) {
    children.push({
      id: `physobj-${objectName}-dind`,
      label: `Dind = ${mat.Dind.toExponential(1)} J/m²`,
      icon: "𝐷",
      status: "ready",
    });
  }

  children.push(
    ...stack.map((entry): TreeNodeData => {
      if (entry.kind === "interfacial_dmi") {
        const dind = Number(entry.params?.dind ?? geo.material.Dind ?? 0);
        return {
          id: `physobj-${objectName}-interfacial_dmi`,
          label:
            dind !== 0
              ? `Interfacial DMI · D = ${dind.toExponential(2)} J/m²`
              : "Interfacial DMI",
          icon: "𝐷",
          status: entry.enabled ? "ready" : "pending",
          badge: entry.enabled ? undefined : "disabled",
        };
      }
      if (entry.kind === "uniaxial_anisotropy") {
        const ku1 = Number(entry.params?.ku1 ?? 0);
        return {
          id: `physobj-${objectName}-uniaxial_anisotropy`,
          label:
            ku1 !== 0
              ? `Uniaxial Ku · ${ku1.toExponential(2)} J/m³`
              : "Uniaxial Ku",
          icon: "K",
          status: entry.enabled ? "ready" : "pending",
          badge: entry.enabled ? undefined : "disabled",
        };
      }
      return {
        id: `physobj-${objectName}-${entry.kind}`,
        label: magneticInteractionLabel(entry.kind),
        icon: entry.kind === "exchange" ? "↔" : "🧲",
        status: entry.enabled ? "ready" : "pending",
        badge: entry.enabled ? undefined : "disabled",
      };
    }),
  );

  const optionalCount = stack.filter(
    (entry) => entry.kind !== "exchange" && entry.kind !== "demag",
  ).length;

  return {
    id: `physobj-${objectName}`,
    label: "Magnetic Parameters",
    icon: "🧲",
    status: mat.Ms != null ? "ready" : "pending",
    badge: optionalCount > 0 ? `+${optionalCount}` : "core",
    children,
  };
}

function magnetizationLabel(
  mag: ScriptBuilderMagnetizationEntry,
): string {
  if (mag.kind === "preset_texture") {
    if (mag.preset_kind === "uniform") {
      const direction = Array.isArray(mag.preset_params?.direction)
        ? mag.preset_params.direction
        : mag.value;
      if (Array.isArray(direction) && direction.length >= 3) {
        return `(${direction.slice(0, 3).map((v) => Number(v).toFixed(2)).join(", ")})`;
      }
    }
    if (mag.preset_kind === "random" || mag.preset_kind === "random_seeded") {
      const seed =
        typeof mag.preset_params?.seed === "number"
          ? mag.preset_params.seed
          : mag.seed;
      return seed != null ? `random(seed=${seed})` : "random";
    }
    return mag.ui_label ?? mag.preset_kind ?? "preset_texture";
  }
  if (mag.kind === "sampled" && mag.source_path) {
    const basename = mag.source_path.split("/").pop() ?? mag.source_path;
    return basename;
  }
  return mag.kind;
}
