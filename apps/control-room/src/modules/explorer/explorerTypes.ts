import type { CommandId } from "@/kernel/commands/commandTypes";

export type ExplorerTabId =
  | "model"
  | "resources"
  | "results"
  | "jobs"
  | "diagnostics";

export type ExplorerNodeKind =
  | "session.root"
  | "universe.root"
  | "objects.root"
  | "object.root"
  | "object.geometry"
  | "object.material"
  | "object.physics"
  | "object.mesh"
  | "object.visualization"
  | "airbox.mesh"
  | "airbox.visualization"
  | "materials.root"
  | "material.entry"
  | "physics.root"
  | "physics.interaction"
  | "mesh.root"
  | "study.root"
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
  | "running"
  | "failed"
  | "degraded"
  | "unsupported";

export type ExplorerIconToken =
  | "activity"
  | "box"
  | "braces"
  | "circle"
  | "database"
  | "file"
  | "folder"
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
  resourceRef?: string;
  status?: ExplorerNodeStatus;
}

export interface ModelTreeObjectSnapshot {
  id: string;
  label: string;
  geometryKind?: string | null;
  magnetization?: string | null;
  material?: string | null;
  meshStatus?: ExplorerNodeStatus;
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
  universe?: {
    id: string;
    label: string;
    size?: readonly [number, number, number] | null;
  } | null;
  objects?: readonly ModelTreeObjectSnapshot[];
  physicsInteractions?: readonly ModelTreePhysicsInteractionSnapshot[];
}
