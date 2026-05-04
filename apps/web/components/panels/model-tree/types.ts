export type NodeStatus =
  | "ready"
  | "active"
  | "pending"
  | "dirty"
  | "stale"
  | "blocked"
  | "warning"
  | "error"
  | "completed"
  | "running"
  | "failed"
  | "skipped";

export type NodeDomain = "build" | "study" | "analyze" | "results";

export interface TreeNodeData {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  status?: NodeStatus;
  defaultOpen?: boolean;
  domain?: NodeDomain;
  children?: TreeNodeData[];
  onClick?: () => void;
}
