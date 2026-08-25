import type { SimulationPreparationResource } from "../api/apiTypes";

const MAX_PREPARATION_LOG_ENTRIES = 200;

export function serializeSimulationPreparationDiagnostics(
  snapshot: SimulationPreparationResource,
): string {
  const projection = {
    active_stage_id: snapshot.active_stage_id ?? null,
    completed_at_unix_ms: snapshot.completed_at_unix_ms ?? null,
    failure: snapshot.failure
      ? {
          diagnostics_correlation_id:
            snapshot.failure.diagnostics_correlation_id ?? null,
          detail: snapshot.failure.detail ?? null,
          error_code: snapshot.failure.error_code,
          stage_id: snapshot.failure.stage_id,
          summary: snapshot.failure.summary,
        }
      : null,
    log_tail: snapshot.log_tail
      .slice(-MAX_PREPARATION_LOG_ENTRIES)
      .map((entry) => ({
        level: entry.level,
        message: entry.message,
        stage_id: entry.stage_id,
        timestamp_unix_ms: entry.timestamp_unix_ms,
      })),
    preparation_id: snapshot.preparation_id,
    requested_execution: copyExecutionSummary(snapshot.requested_execution),
    resolved_execution: snapshot.resolved_execution
      ? copyExecutionSummary(snapshot.resolved_execution)
      : null,
    revision: snapshot.revision,
    stages: snapshot.stages.map((stage) => ({
      clock_adjustment: stage.clock_adjustment
        ? {
            backward_delta_ms: stage.clock_adjustment.backward_delta_ms,
            observed_at_unix_ms: stage.clock_adjustment.observed_at_unix_ms,
            stage_started_at_unix_ms:
              stage.clock_adjustment.stage_started_at_unix_ms,
          }
        : null,
      completed_at_unix_ms: stage.completed_at_unix_ms ?? null,
      detail: stage.detail,
      duration_ms: stage.duration_ms ?? null,
      id: stage.id,
      label: stage.label,
      progress_label: stage.progress_label ?? null,
      progress_percent: stage.progress_percent ?? null,
      started_at_unix_ms: stage.started_at_unix_ms ?? null,
      status: stage.status,
    })),
    started_at_unix_ms: snapshot.started_at_unix_ms,
    status: snapshot.status,
  };
  return JSON.stringify(projection, null, 2);
}

function copyExecutionSummary(
  summary: SimulationPreparationResource["requested_execution"],
) {
  return {
    backend: summary.backend ?? null,
    device: summary.device ?? null,
    engine_id: summary.engine_id ?? null,
    mode: summary.mode ?? null,
    precision: summary.precision ?? null,
    runtime_family: summary.runtime_family ?? null,
    worker: summary.worker ?? null,
  };
}
