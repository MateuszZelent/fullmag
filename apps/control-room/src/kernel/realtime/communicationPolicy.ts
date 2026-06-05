export interface RealtimeCommunicationPolicy {
  diagnosticsEnabled: boolean;
  diagnosticsSummaryMs: number;
  errorRetryMs: number;
  fieldSamplesEnabled: boolean;
  fieldSamplePublishMs: number;
  heartbeatEnabled: boolean;
  lifecycleEventsEnabled: boolean;
  lifecycleCoalesceMs: number;
  resourceBatchChangedEnabled: boolean;
  scalarSampleEnabled: boolean;
  scalarTableRowsEnabled: boolean;
  scalarTelemetryPublishMs: number;
  statusRefreshMs: number;
  tableRowsMinRefetchMs: number;
  visualizationClientAcksEnabled: boolean;
  wsHeartbeatMs: number;
  wsReconnectMs: number;
  wsReplayCapacity: number;
}

const DEFAULT_REALTIME_COMMUNICATION_POLICY: RealtimeCommunicationPolicy = {
  diagnosticsEnabled: true,
  diagnosticsSummaryMs: 5_000,
  errorRetryMs: 1_000,
  fieldSamplesEnabled: true,
  fieldSamplePublishMs: 2_000,
  heartbeatEnabled: true,
  lifecycleEventsEnabled: true,
  lifecycleCoalesceMs: 250,
  resourceBatchChangedEnabled: true,
  scalarSampleEnabled: true,
  scalarTableRowsEnabled: true,
  scalarTelemetryPublishMs: 200,
  statusRefreshMs: 5_000,
  tableRowsMinRefetchMs: 1_000,
  visualizationClientAcksEnabled: true,
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
    diagnosticsEnabled: booleanValue(
      record.diagnostics_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.diagnosticsEnabled,
    ),
    diagnosticsSummaryMs: positiveNumber(
      record.diagnostics_summary_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.diagnosticsSummaryMs,
    ),
    errorRetryMs: positiveNumber(
      record.error_retry_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.errorRetryMs,
    ),
    fieldSamplesEnabled: booleanValue(
      record.field_samples_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.fieldSamplesEnabled,
    ),
    fieldSamplePublishMs: positiveNumber(
      record.field_sample_publish_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.fieldSamplePublishMs,
    ),
    heartbeatEnabled: booleanValue(
      record.heartbeat_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.heartbeatEnabled,
    ),
    lifecycleEventsEnabled: booleanValue(
      record.lifecycle_events_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.lifecycleEventsEnabled,
    ),
    lifecycleCoalesceMs: nonNegativeNumber(
      record.lifecycle_coalesce_ms,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.lifecycleCoalesceMs,
    ),
    resourceBatchChangedEnabled: booleanValue(
      record.resource_batch_changed_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.resourceBatchChangedEnabled,
    ),
    scalarSampleEnabled: booleanValue(
      record.scalar_sample_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.scalarSampleEnabled,
    ),
    scalarTableRowsEnabled: booleanValue(
      record.scalar_table_rows_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.scalarTableRowsEnabled,
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
    visualizationClientAcksEnabled: booleanValue(
      record.visualization_client_acks_enabled,
      DEFAULT_REALTIME_COMMUNICATION_POLICY.visualizationClientAcksEnabled,
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

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
