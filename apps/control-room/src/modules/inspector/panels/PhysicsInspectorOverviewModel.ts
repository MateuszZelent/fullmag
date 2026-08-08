export type PhysicsInspectorScopeKind =
  | "global"
  | "object"
  | "region"
  | "interface"
  | "cross_object"
  | "unresolved";

export type PhysicsInspectorStatus =
  | "active"
  | "configured"
  | "inactive"
  | "blocked"
  | "unsupported"
  | "unresolved"
  | "absent";

export interface PhysicsInspectorScope {
  kind: PhysicsInspectorScopeKind;
  label: string;
  objectId?: string | null;
  regionId?: string | null;
  sideA?: string | null;
  sideB?: string | null;
  stableRef: string;
}

export interface PhysicsInspectorSource {
  id: string;
  kind: string;
  path?: string | null;
  status: PhysicsInspectorStatus;
}

export interface PhysicsInspectorDependency {
  requiredSourceIds: readonly string[];
  reason?: string | null;
  status: PhysicsInspectorStatus;
}

export interface PhysicsInspectorExecution {
  capability?: string | null;
  graphRevision?: number | string | null;
  requestedLane?: string | null;
  resolvedLane?: string | null;
  sceneRevision?: number | string | null;
}

export interface PhysicsInspectorValue {
  label: string;
  unit?: string;
  value: string | number;
}

export interface PhysicsInspectorOverviewModel {
  dependency: PhysicsInspectorDependency;
  execution: PhysicsInspectorExecution;
  family: string;
  source: PhysicsInspectorSource;
  status: PhysicsInspectorStatus;
  statusReason?: string | null;
  scope: PhysicsInspectorScope;
  values: readonly PhysicsInspectorValue[];
}

export interface PhysicsInspectorOverviewInput
  extends Partial<Omit<PhysicsInspectorOverviewModel, "family" | "scope" | "source">> {
  family: string;
  scope?: Partial<PhysicsInspectorScope> & Pick<PhysicsInspectorScope, "kind">;
  source?: Partial<PhysicsInspectorSource> & Pick<PhysicsInspectorSource, "id" | "kind">;
}

const SCOPE_LABELS: Record<PhysicsInspectorScopeKind, string> = {
  cross_object: "Cross-object",
  global: "Global",
  interface: "Interface",
  object: "Object",
  region: "Region",
  unresolved: "Unresolved",
};

const STATUS_LABELS: Record<PhysicsInspectorStatus, string> = {
  absent: "Absent",
  active: "Active",
  blocked: "Blocked",
  configured: "Configured",
  inactive: "Inactive",
  unresolved: "Unresolved",
  unsupported: "Unsupported",
};

export function physicsInspectorScopeLabel(kind: PhysicsInspectorScopeKind): string {
  return SCOPE_LABELS[kind];
}

export function physicsInspectorStatusLabel(status: PhysicsInspectorStatus): string {
  return STATUS_LABELS[status];
}

export function buildPhysicsInspectorOverviewModel(
  input: PhysicsInspectorOverviewInput,
): PhysicsInspectorOverviewModel {
  const scopeKind = input.scope?.kind ?? "global";
  const source = input.source ?? { id: "none", kind: input.family };
  const status = input.status ?? source.status ?? "active";
  const scope: PhysicsInspectorScope = {
    kind: scopeKind,
    label: input.scope?.label ?? physicsInspectorScopeLabel(scopeKind),
    objectId: input.scope?.objectId ?? null,
    regionId: input.scope?.regionId ?? null,
    sideA: input.scope?.sideA ?? null,
    sideB: input.scope?.sideB ?? null,
    stableRef: input.scope?.stableRef ?? `${scopeKind}:unresolved`,
  };
  const normalizedSource: PhysicsInspectorSource = {
    id: source.id,
    kind: source.kind,
    path: source.path ?? null,
    status: source.status ?? status,
  };
  const dependency: PhysicsInspectorDependency = {
    requiredSourceIds: input.dependency?.requiredSourceIds ?? [],
    reason: input.dependency?.reason ?? null,
    status: input.dependency?.status ?? (status === "active" ? "active" : status),
  };
  return {
    dependency,
    execution: input.execution ?? {},
    family: input.family,
    scope,
    source: normalizedSource,
    status,
    statusReason: input.statusReason ?? null,
    values: input.values ?? [],
  };
}

export function physicsInspectorMetrics(
  model: PhysicsInspectorOverviewModel,
): readonly [
  { label: string; value: string; tone?: "danger" | "degraded" | "neutral" | "stale" | "success" | "warning" },
  { label: string; value: string; tone?: "danger" | "degraded" | "neutral" | "stale" | "success" | "warning" },
  { label: string; value: string; tone?: "danger" | "degraded" | "neutral" | "stale" | "success" | "warning" },
  { label: string; value: string; tone?: "danger" | "degraded" | "neutral" | "stale" | "success" | "warning" },
] {
  const lane = model.execution.resolvedLane ?? model.execution.requestedLane ?? "Unresolved";
  const statusTone = model.status === "active"
    ? "success"
    : model.status === "inactive" || model.status === "absent" || model.status === "configured"
      ? "neutral"
      : "warning";
  return [
    { label: "Scope", value: model.scope.label },
    { label: "Source", value: model.source.id },
    { label: "Lane", value: lane, tone: model.execution.resolvedLane ? "success" : "warning" },
    { label: "Status", value: physicsInspectorStatusLabel(model.status), tone: statusTone },
  ];
}
