import type { CommandId } from "@/kernel/commands/commandTypes";

export type ExplorerTabId =
  | "model"
  | "resources"
  | "results"
  | "jobs"
  | "diagnostics";

type ExplorerNodeKind =
  | "session.root"
  | "universe.root"
  | "objects.root"
  | "object.root"
  | "object.geometry"
  | "object.material"
  | "object.physics"
  | "object.regions"
  | "object.region-magnetic-texture"
  | "object.magnetic-parameters"
  | "object.magnetic-texture"
  | "object.mesh"
  | "object.visualization"
  | "airbox.mesh"
  | "airbox.visualization"
  | "mesh.root"
  | "mesh.shared-domain"
  | "mesh.builds"
  | "mesh.quality"
  | "mesh.size-fields"
  | "mesh.regions"
  | "study.root"
  | "study.stage.action"
  | "study.stage.eigenmodes"
  | "study.stage.relax"
  | "study.stage.run"
  | "results.root"
  | "results.field_quantity"
  | "resources.root"
  | "resources.field"
  | "resources.mesh"
  | "jobs.root"
  | "jobs.command"
  | "diagnostics.root"
  | "diagnostics.resource";

export type ExplorerNodeStatus =
  | "ready"
  | "primitive-only"
  | "mesh-stale"
  | "mesh-building"
  | "mesh-ready"
  | "mesh-failed"
  | "validation-blocked"
  | "stale"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "skipped"
  | "cancelled"
  | "failed"
  | "degraded"
  | "warning"
  | "unsupported";

export type ExplorerIconToken =
  | "activity"
  | "box"
  | "braces"
  | "circle"
  | "database"
  | "file"
  | "folder"
  | "gauge"
  | "layers"
  | "magnet"
  | "mesh"
  | "play"
  | "settings"
  | "shield"
  | "sparkles"
  | "triangle"
  | "wave";

export interface ExplorerNode {
  id: string;
  kind: ExplorerNodeKind;
  label: string;
  parentId: string | null;
  badge?: string;
  children?: ExplorerNode[];
  contextCommands?: CommandId[];
  icon?: ExplorerIconToken;
  objectId?: string;
  regionId?: string;
  resourceRef?: string;
  stageId?: string;
  stageIndex?: number;
  status?: ExplorerNodeStatus;
}

export interface ModelTreeObjectSnapshot {
  id: string;
  label: string;
  geometryKind?: string | null;
  magnetization?: string | null;
  magnetizationKind?: string | null;
  magnetizationLabel?: string | null;
  material?: string | null;
  materialLabel?: string | null;
  materialPropertyKeys?: readonly string[];
  meshStatus?: ExplorerNodeStatus;
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
  region?: string | null;
  regionId?: string | null;
  regionMagnetization?: string | null;
  regionMagnetizationKind?: string | null;
  regionMagnetizationLabel?: string | null;
  textureTransformAvailable?: boolean;
}

export interface ModelTreeMaterialSnapshot {
  id: string;
  label: string;
  propertyKeys: readonly string[];
}

export interface ModelTreePhysicsInteractionSnapshot {
  enabledCount: number;
  id: string;
  label: string;
  objectCount: number;
}

export interface ModelTreeSnapshot {
  materials?: readonly ModelTreeMaterialSnapshot[];
  mesh?: ModelTreeMeshSnapshot | null;
  universe?: {
    id: string;
    label: string;
    size?: readonly [number, number, number] | null;
  } | null;
  objects?: readonly ModelTreeObjectSnapshot[];
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
  study?: ModelTreeStudySnapshot | null;
}

interface ModelTreeStudySnapshot {
  demagRealization?: string | null;
  externalField?: readonly [number, number, number] | null;
  requestedBackend?: string | null;
  requestedDevice?: string | null;
  requestedMode?: string | null;
  requestedPrecision?: string | null;
  stages: readonly ModelTreeStudyStageSnapshot[];
}

export interface ModelTreeStudyStageSnapshot {
  artifactName?: string | null;
  energyTolerance?: string | number | null;
  index: number;
  kind: string;
  maxSteps?: string | number | null;
  stageId?: string | null;
  status?: ExplorerNodeStatus | null;
  torqueTolerance?: string | number | null;
  untilSeconds?: string | number | null;
}

export interface ModelTreeMeshSnapshot {
  activeBuildStatus?: string | null;
  buildRevision?: number | string | null;
  domainMeshMode?: string | null;
  generationId?: string | null;
  lastError?: string | null;
  meshName?: string | null;
  meshRevision?: number | string | null;
  objectSegmentCount?: number | null;
  partCount?: number | null;
  qualityStatus?: string | null;
  realizedSizeFieldCount?: number | null;
  regionCount?: number | null;
}
