/**
 * Run entity – shared types.
 */
export interface RunEntity {
  id: string;
  projectId: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  backend: string;
  startedAt: number | null;
  completedAt: number | null;
}
