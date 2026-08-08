import type { ExplorerNode, ExplorerNodeStatus } from "../explorerTypes";

/**
 * The API graph is deliberately consumed as a small structural contract here.
 * Constitutive family payloads remain in their own resources; the Explorer only
 * needs identity, scope, dependency and activation metadata to place a node.
 */
export interface PhysicsGraphTreeObject {
  id: string;
  label?: string;
}

export interface PhysicsGraphTreeInput {
  graph?: unknown | null;
  objects?: readonly PhysicsGraphTreeObject[];
}

interface PhysicsGraphTreeScope {
  kind: string;
  object_id?: string;
  object_ids?: readonly string[];
  region_id?: string;
  interface_id?: string;
  side_a?: { object_id?: string; region_id?: string };
  side_b?: { object_id?: string; region_id?: string };
  reason?: string;
}

interface PhysicsGraphTreeModule {
  id: string;
  kind: string;
  label?: string;
  name?: string;
  applies_to?: readonly PhysicsGraphTreeScope[];
  scopes?: readonly PhysicsGraphTreeScope[];
  scope?: PhysicsGraphTreeScope | null;
  depends_on?: readonly string[];
  activation?: string;
  capability?: string;
  authored_state?: string;
  family_payload?: Record<string, unknown>;
}

interface PhysicsGraphTreeGraph {
  schema_version: string;
  modules: readonly PhysicsGraphTreeModule[];
  edges: readonly Record<string, unknown>[];
}

type ScopePlacement =
  | { kind: "global" }
  | { kind: "object"; objectId: string; regionId?: string }
  | { kind: "cross-object"; objectIds: readonly string[] }
  | { kind: "unresolved"; reason?: string };

interface GroupedPhysicsModule {
  module: PhysicsGraphTreeModule;
  placement: ScopePlacement;
}

const DEPENDENT_KINDS = new Set([
  "spin_transport",
  "spin_interface",
  "spin_torque",
  "oersted_field",
]);

const SCOPE_KIND_ALIASES: Record<string, ScopePlacement["kind"]> = {
  cross_object: "cross-object",
  cross_object_interface: "cross-object",
  global: "global",
  interface: "cross-object",
  object: "object",
  region: "object",
  unresolved: "unresolved",
};

export function buildPhysicsGraphTree({
  graph: input,
  objects = [],
}: PhysicsGraphTreeInput): ExplorerNode[] {
  const graph = normalizeGraph(input);
  if (!graph || graph.modules.length === 0) return [];

  // A graph without a current source is a valid empty electrical setup.  It
  // must not manufacture dependent spin/Oersted rows from stale family data.
  const hasCurrentSource = graph.modules.some(
    (module) => module.kind === "current_transport",
  );
  const modules = graph.modules
    .filter((module) => hasCurrentSource || !DEPENDENT_KINDS.has(module.kind))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (modules.length === 0) return [];

  const grouped = new Map<
    string,
    { placement: ScopePlacement; modules: GroupedPhysicsModule[] }
  >();
  for (const module of modules) {
    const placement = placementFor(module);
    const resolvedPlacement = placement.kind === "object" &&
      objects.length > 0 &&
      !objects.some((object) => object.id === placement.objectId)
      ? { kind: "unresolved" as const, reason: `object '${placement.objectId}' is absent` }
      : placement;
    const key = scopeKey(resolvedPlacement);
    const existing = grouped.get(key);
    if (existing) {
      existing.modules.push({ module, placement: resolvedPlacement });
    } else {
      grouped.set(key, {
        modules: [{ module, placement: resolvedPlacement }],
        placement: resolvedPlacement,
      });
    }
  }

  return [...grouped.values()]
    .sort((left, right) => compareScope(left.placement, right.placement, objects))
    .map(({ placement, modules: scopedModules }) =>
      buildScopeNode(placement, scopedModules, objects),
    );
}

/** Return only the object-local branch; buildModelTree embeds this below the object. */
export function buildPhysicsGraphObjectNode(
  graph: unknown | null | undefined,
  object: PhysicsGraphTreeObject,
): ExplorerNode | null {
  const node = buildPhysicsGraphTree({ graph, objects: [object] }).find(
    (candidate) =>
      candidate.kind === "object.physics.scope" && candidate.objectId === object.id,
  );
  if (!node) return null;
  return {
    ...node,
    parentId: `model:object:${object.id}`,
  };
}

function normalizeGraph(value: unknown): PhysicsGraphTreeGraph | null {
  if (!isRecord(value) || value.schema_version !== "physics_graph.v1") return null;
  if (!Array.isArray(value.modules) || !Array.isArray(value.edges)) return null;
  const modules = value.modules.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !candidate.id) return [];
    if (typeof candidate.kind !== "string" || !candidate.kind) return [];
    const scopes = normalizeScopes(candidate.applies_to ?? candidate.scopes);
    const scope = isRecord(candidate.scope) ? normalizeScope(candidate.scope) : null;
    const familyPayload = isRecord(candidate.family_payload)
      ? candidate.family_payload
      : undefined;
    return [{
      id: candidate.id,
      kind: candidate.kind,
      ...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      ...(scopes.length > 0 ? { applies_to: scopes } : {}),
      ...(scope ? { scope } : {}),
      ...(Array.isArray(candidate.depends_on)
        ? {
            depends_on: candidate.depends_on.filter(
              (dependency): dependency is string => typeof dependency === "string",
            ),
          }
        : {}),
      ...(typeof candidate.activation === "string" ? { activation: candidate.activation } : {}),
      ...(typeof candidate.capability === "string" ? { capability: candidate.capability } : {}),
      ...(typeof candidate.authored_state === "string"
        ? { authored_state: candidate.authored_state }
        : {}),
      ...(familyPayload ? { family_payload: familyPayload } : {}),
    } satisfies PhysicsGraphTreeModule];
  });
  return {
    schema_version: value.schema_version,
    modules,
    edges: value.edges.filter(isRecord),
  };
}

function normalizeScopes(value: unknown): PhysicsGraphTreeScope[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.kind !== "string") return [];
    return [normalizeScope(candidate)];
  });
}

function normalizeScope(value: Record<string, unknown>): PhysicsGraphTreeScope {
  return {
    kind: value.kind as string,
    ...(typeof value.object_id === "string" ? { object_id: value.object_id } : {}),
    ...(Array.isArray(value.object_ids)
      ? { object_ids: value.object_ids.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(typeof value.region_id === "string" ? { region_id: value.region_id } : {}),
    ...(typeof value.interface_id === "string" ? { interface_id: value.interface_id } : {}),
    ...(isRecord(value.side_a)
      ? {
          side_a: {
            object_id:
              typeof value.side_a.object_id === "string"
                ? value.side_a.object_id
                : undefined,
            region_id:
              typeof value.side_a.region_id === "string"
                ? value.side_a.region_id
                : undefined,
          },
        }
      : {}),
    ...(isRecord(value.side_b)
      ? {
          side_b: {
            object_id:
              typeof value.side_b.object_id === "string"
                ? value.side_b.object_id
                : undefined,
            region_id:
              typeof value.side_b.region_id === "string"
                ? value.side_b.region_id
                : undefined,
          },
        }
      : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function placementFor(module: PhysicsGraphTreeModule): ScopePlacement {
  const rawScopes =
    module.applies_to ?? module.scopes ?? (module.scope ? [module.scope] : []);
  if (rawScopes.length === 0) return { kind: "unresolved", reason: "module scope is absent" };

  const objectIds = new Set<string>();
  const regionIds = new Set<string>();
  let hasGlobal = false;
  let hasCrossObject = false;
  let unresolvedReason: string | undefined;
  for (const scope of rawScopes) {
    const kind = SCOPE_KIND_ALIASES[scope.kind] ?? "unresolved";
    if (kind === "global") {
      hasGlobal = true;
      continue;
    }
    if (kind === "cross-object") {
      hasCrossObject = true;
      for (const objectId of [
        ...(scope.object_ids ?? []),
        ...(scope.side_a?.object_id ? [scope.side_a.object_id] : []),
        ...(scope.side_b?.object_id ? [scope.side_b.object_id] : []),
      ]) {
        objectIds.add(objectId);
      }
      continue;
    }
    if (kind === "object") {
      if (scope.object_id) {
        objectIds.add(scope.object_id);
        if (scope.region_id) regionIds.add(scope.region_id);
      } else {
        unresolvedReason ??= "object scope has no object_id";
      }
      continue;
    }
    unresolvedReason ??= scope.reason ?? "unknown scope kind";
  }
  if (hasGlobal && !hasCrossObject && objectIds.size === 0) return { kind: "global" };
  if (objectIds.size > 1 || hasCrossObject) {
    return objectIds.size > 0
      ? { kind: "cross-object", objectIds: [...objectIds].sort() }
      : {
          kind: "unresolved",
          reason: unresolvedReason ?? "cross-object scope has no object_ids",
        };
  }
  if (objectIds.size === 1) {
    return {
      kind: "object",
      objectId: [...objectIds][0],
      ...(regionIds.size === 1 ? { regionId: [...regionIds][0] } : {}),
    };
  }
  return { kind: "unresolved", reason: unresolvedReason ?? "module scope is unresolved" };
}

function scopeKey(placement: ScopePlacement): string {
  switch (placement.kind) {
    case "global":
      return "global";
    case "object":
      return `object:${placement.objectId}`;
    case "cross-object":
      return `cross-object:${placement.objectIds.join(",")}`;
    case "unresolved":
      return "unresolved";
  }
}

function compareScope(
  left: ScopePlacement,
  right: ScopePlacement,
  objects: readonly PhysicsGraphTreeObject[],
): number {
  const order = (placement: ScopePlacement): [number, string] => {
    if (placement.kind === "global") return [0, ""];
    if (placement.kind === "object") {
      const index = objects.findIndex((object) => object.id === placement.objectId);
      return [
        1,
        `${String(index < 0 ? Number.MAX_SAFE_INTEGER : index).padStart(12, "0")}:${placement.objectId}`,
      ];
    }
    if (placement.kind === "cross-object") return [2, placement.objectIds.join(",")];
    return [3, placement.reason ?? "unknown"];
  };
  const [leftRank, leftKey] = order(left);
  const [rightRank, rightKey] = order(right);
  return leftRank - rightRank || leftKey.localeCompare(rightKey);
}

function buildScopeNode(
  placement: ScopePlacement,
  modules: readonly GroupedPhysicsModule[],
  objects: readonly PhysicsGraphTreeObject[],
): ExplorerNode {
  const { id, kind, label, objectId, parentId } = scopeNodeIdentity(placement, objects);
  return {
    id,
    kind,
    label,
    parentId,
    ...(objectId ? { objectId } : {}),
    badge: `${modules.length}`,
    icon: "activity",
    selectable: false,
    status: "ready",
    children: [...modules]
      .sort((left, right) => left.module.id.localeCompare(right.module.id))
      .map(({ module, placement: modulePlacement }) =>
        buildModuleNode(module, modulePlacement, id),
      ),
  };
}

function scopeNodeIdentity(
  placement: ScopePlacement,
  objects: readonly PhysicsGraphTreeObject[],
): {
  id: string;
  kind: ExplorerNode["kind"];
  label: string;
  objectId?: string;
  parentId: string;
} {
  if (placement.kind === "global") {
    return {
      id: "model:physics:global",
      kind: "physics.scope.global",
      label: "Global Physics",
      parentId: "model:session",
    };
  }
  if (placement.kind === "object") {
    const object = objects.find((candidate) => candidate.id === placement.objectId);
    return {
      id: `model:object:${placement.objectId}:physics`,
      kind: "object.physics.scope",
      label: `Physics · ${object?.label ?? placement.objectId}`,
      objectId: placement.objectId,
      parentId: "model:objects",
    };
  }
  if (placement.kind === "cross-object") {
    return {
      id: "model:physics:cross-object",
      kind: "physics.scope.cross-object",
      label: "Cross-object Interfaces",
      parentId: "model:session",
    };
  }
  return {
    id: "model:physics:unresolved",
    kind: "physics.scope.unresolved",
    label: "Unresolved Physics",
    parentId: "model:session",
  };
}

function buildModuleNode(
  module: PhysicsGraphTreeModule,
  placement: ScopePlacement,
  parentId: string,
): ExplorerNode {
  const activation = module.activation ?? "unresolved";
  return {
    id: `${parentId}:module:${encodeURIComponent(module.id)}`,
    kind: "physics.module",
    label: module.label ?? module.name ?? `${labelForKind(module.kind)} · ${module.id}`,
    parentId,
    badge: [activation, module.capability ?? "unknown"].join(" · "),
    icon: iconForKind(module.kind),
    physicsActivation: activation,
    physicsModuleId: module.id,
    physicsModuleKind: module.kind,
    physicsScopeKind: placement.kind,
    ...(placement.kind === "object" ? { objectId: placement.objectId } : {}),
    ...(placement.kind === "object" && placement.regionId
      ? { regionId: placement.regionId }
      : {}),
    ...(placement.kind === "cross-object"
      ? { physicsScopeObjectIds: placement.objectIds }
      : {}),
    status: statusForActivation(activation, module.capability),
    resourceRef: `physics-graph:${module.id}`,
  };
}

function statusForActivation(
  activation: string,
  capability: string | undefined,
): ExplorerNodeStatus {
  if (activation === "blocked") return "validation-blocked";
  if (activation === "unsupported" || capability === "unsupported") return "unsupported";
  if (activation === "unresolved") return "unavailable";
  if (activation === "inactive") return "degraded";
  if (capability === "semantic_only") return "ready";
  return "ready";
}

function labelForKind(kind: string): string {
  const labels: Record<string, string> = {
    current_transport: "Current Transport",
    oersted_field: "Oersted Field",
    regional_field_drive: "Field Drive",
    spin_interface: "Spin Interface",
    spin_torque: "Spin Torque",
    spin_transport: "Spin Transport",
  };
  return labels[kind] ?? kind.replaceAll("_", " ");
}

function iconForKind(kind: string): ExplorerNode["icon"] {
  if (kind === "current_transport" || kind === "spin_transport") return "activity";
  if (kind === "oersted_field" || kind === "regional_field_drive") return "wave";
  if (kind === "spin_torque") return "magnet";
  return "layers";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
