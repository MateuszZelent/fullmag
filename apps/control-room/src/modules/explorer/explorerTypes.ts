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
  | "object.mesh"
  | "object.visualization"
  | "object.initial_state"
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
  material?: string | null;
  meshStatus?: ExplorerNodeStatus;
}

export interface ModelTreeSnapshot {
  universe?: {
    id: string;
    label: string;
    size?: readonly [number, number, number] | null;
  } | null;
  objects?: readonly ModelTreeObjectSnapshot[];
}
