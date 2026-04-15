import type { MaterializedStageMapEntry } from "./types";

export type ExecutionStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface ExecutionMapEntryStatus {
  nodeId: string;
  nodeLabel: string;
  status: ExecutionStatus;
  progress: number;
  children: ExecutionMapEntryStatus[];
}

function normalizeStageStatus(status: string | undefined): ExecutionStatus | "completed" {
  if (status === "running" || status === "paused") return "running";
  if (status === "failed" || status === "error") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "done") return "done";
  if (status === "completed") return "completed";
  return "pending";
}

function statusFromIndexes(
  indexes: number[],
  stageStatuses: string[],
): { status: ExecutionStatus; progress: number } {
  if (indexes.length === 0) return { status: "skipped", progress: 100 };
  const statuses = indexes.map((index) => normalizeStageStatus(stageStatuses[index]));
  const completed = statuses.filter((status) => status === "completed" || status === "done").length;
  const skipped = statuses.filter((status) => status === "skipped").length;
  const running = statuses.some((status) => status === "running");
  const failed = statuses.some((status) => status === "failed");
  const terminal = completed + skipped;

  if (failed) {
    return { status: "failed", progress: (terminal / indexes.length) * 100 };
  }
  if (running) {
    return { status: "running", progress: (terminal / indexes.length) * 100 };
  }
  if (completed === indexes.length) return { status: "done", progress: 100 };
  if (skipped === indexes.length) return { status: "skipped", progress: 100 };
  if (terminal > 0) return { status: "running", progress: (terminal / indexes.length) * 100 };
  return { status: "pending", progress: 0 };
}

export function buildExecutionMapStatus(
  map: MaterializedStageMapEntry[],
  stageStatuses: string[],
): ExecutionMapEntryStatus[] {
  return map.map((entry) => {
    const base = statusFromIndexes(entry.stageIndexes, stageStatuses);
    return {
      nodeId: entry.nodeId,
      nodeLabel: entry.nodeLabel,
      status: base.status,
      progress: base.progress,
      children: buildExecutionMapStatus(
        entry.childEntries ?? [],
        stageStatuses,
      ),
    };
  });
}
