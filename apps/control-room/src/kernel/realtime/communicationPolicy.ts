export interface RealtimeCommunicationPolicy {
  diagnosticsSummaryMs: number;
  errorRetryMs: number;
  fieldSamplePublishMs: number;
  lifecycleCoalesceMs: number;
  scalarTelemetryPublishMs: number;
  statusRefreshMs: number;
  tableRowsMinRefetchMs: number;
  wsHeartbeatMs: number;
  wsReconnectMs: number;
  wsReplayCapacity: number;
}

const DEFAULT_REALTIME_COMMUNICATION_POLICY: RealtimeCommunicationPolicy = {
  diagnosticsSummaryMs: 5_000,
  errorRetryMs: 1_000,
  fieldSamplePublishMs: 2_000,
  lifecycleCoalesceMs: 0,
  scalarTelemetryPublishMs: 200,
  statusRefreshMs: 5_000,
  tableRowsMinRefetchMs: 1_000,
  wsHeartbeatMs: 15_000,
  wsReconnectMs: 5_000,
  wsReplayCapacity: 512,
};

let currentPolicy = DEFAULT_REALTIME_COMMUNICATION_POLICY;

export function realtimeCommunicationPolicy(): RealtimeCommunicationPolicy {
  return currentPolicy;
}

export function updateRealtimeCommunicationPolicy(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  currentPolicy = {
    diagnosticsSummaryMs: positiveNumber(
      record.diagnostics_summary_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.diagnosticsSummaryMs,
    ),
    errorRetryMs: positiveNumber(
      record.error_retry_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.errorRetryMs,
    ),
    fieldSamplePublishMs: positiveNumber(
      record.field_sample_publish_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.fieldSamplePublishMs,
    ),
    lifecycleCoalesceMs: nonNegativeNumber(
      record.lifecycle_coalesce_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.lifecycleCoalesceMs,
    ),
    scalarTelemetryPublishMs: positiveNumber(
      record.scalar_telemetry_publish_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.scalarTelemetryPublishMs,
    ),
    statusRefreshMs: positiveNumber(
      record.status_refresh_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.statusRefreshMs,
    ),
    tableRowsMinRefetchMs: positiveNumber(
      record.table_rows_min_refetch_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.tableRowsMinRefetchMs,
    ),
    wsHeartbeatMs: positiveNumber(
      record.ws_heartbeat_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.wsHeartbeatMs,
    ),
    wsReconnectMs: positiveNumber(
      record.ws_reconnect_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.wsReconnectMs,
    ),
    wsReplayCapacity: positiveNumber(
      record.ws_replay_capacity,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.wsReplayCapacity,
    ),
  };
}

export function tableRowsMinRefetchIntervalMs(): number {
  return realtimeCommunicationPolicy().tableRowsMinRefetchMs;
}

export function fieldVectorMinRefetchIntervalMs(): number {
  return realtimeCommunicationPolicy().fieldSamplePublishMs;
}

export function scalarTelemetryIntervalMs(): number {
  return realtimeCommunicationPolicy().scalarTelemetryPublishMs;
}

export function diagnosticsSummaryIntervalMs(): number {
  return realtimeCommunicationPolicy().diagnosticsSummaryMs;
}

export function statusRefreshIntervalMs(): number {
  return realtimeCommunicationPolicy().statusRefreshMs;
}

export function errorRetryDelayMs(): number {
  return realtimeCommunicationPolicy().errorRetryMs;
}

export function realtimeReconnectDelayMs(): number {
  return realtimeCommunicationPolicy().wsReconnectMs;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}
