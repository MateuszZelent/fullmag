export interface MeshPipelinePhase {
  detail: string;
  durationMs: number | null;
  id: string;
  label: string;
  progressLabel: string | null;
  progressPercent: number | null;
  status: string;
}

export type MeshPipelineTone = "danger" | "neutral" | "success" | "warning";

const ACTIVE_STATUSES = new Set([
  "active",
  "building",
  "generating",
  "pending",
  "queued",
  "running",
  "started",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function phaseFromRecord(
  value: unknown,
  fallbackId: string,
): MeshPipelinePhase | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = nonEmptyString(record.id) ?? nonEmptyString(record.phase) ?? fallbackId;
  const status = nonEmptyString(record.status) ?? "unknown";
  const label =
    nonEmptyString(record.label) ??
    nonEmptyString(record.name) ??
    titleFromId(id);
  const detail =
    nonEmptyString(record.detail) ??
    nonEmptyString(record.message) ??
    "";
  const progressPercent =
    percent(record.progress_percent) ??
    percent(record.progressPercent) ??
    percent(record.percent);
  const progressLabel =
    nonEmptyString(record.progress_label) ??
    nonEmptyString(record.progressLabel) ??
    null;
  const durationMs =
    nonNegativeInteger(record.duration_ms) ??
    nonNegativeInteger(record.durationMs);

  if (id === fallbackId && status === "unknown" && detail.length === 0) {
    return null;
  }

  return { detail, durationMs, id, label, progressLabel, progressPercent, status };
}

export function normalizeMeshPipelineStatus(value: unknown): MeshPipelinePhase[] {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => phaseFromRecord(entry, `phase-${index + 1}`))
      .filter((phase): phase is MeshPipelinePhase => phase !== null);
  }

  const phase = phaseFromRecord(value, "active");
  return phase ? [phase] : [];
}

export function resolveMeshBuildStatusLabel(
  activeBuild: Record<string, unknown> | null,
  phases: readonly MeshPipelinePhase[],
): string {
  const activeStatus = nonEmptyString(activeBuild?.status);
  if (activeStatus) return activeStatus;

  const activePhase = phases.find((phase) =>
    ACTIVE_STATUSES.has(phase.status.toLowerCase()),
  );
  if (activePhase) return `${activePhase.label}: ${activePhase.status}`;

  return phases.length > 0 ? "available" : "idle";
}

export function meshPipelineStatusTone(status: string): MeshPipelineTone {
  const lower = status.toLowerCase();
  if (lower.includes("failed") || lower.includes("error")) return "danger";
  if (
    lower.includes("ready") ||
    lower.includes("completed") ||
    lower.includes("done") ||
    lower.includes("success")
  ) {
    return "success";
  }
  if (lower === "idle" || lower === "not built" || lower === "available") {
    return "neutral";
  }
  return "warning";
}

export function meshPipelineStatusIsActive(status: string | null | undefined): boolean {
  const lower = status?.toLowerCase() ?? "";
  return [...ACTIVE_STATUSES].some((activeStatus) => lower.includes(activeStatus));
}
