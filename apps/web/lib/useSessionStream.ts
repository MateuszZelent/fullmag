"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiHttpError, currentLiveApiClient } from "./liveApiClient";

export interface SessionManifest {
  session_id: string;
  run_id: string;
  status: string;
  interactive_session_requested: boolean;
  script_path: string;
  problem_name: string;
  requested_backend: string;
  execution_mode: string;
  precision: string;
  artifact_dir: string;
  started_at_unix_ms: number;
  finished_at_unix_ms: number;
  plan_summary?: Record<string, unknown>;
}

export interface RunManifest {
  run_id: string;
  session_id: string;
  status: string;
  total_steps: number;
  final_time: number | null;
  final_e_ex: number | null;
  final_e_demag: number | null;
  final_e_ext: number | null;
  final_e_total: number | null;
  artifact_dir: string;
}

export interface LiveState {
  status: string;
  updated_at_unix_ms: number;
  step: number;
  time: number;
  dt: number;
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_total: number;
  max_dm_dt: number;
  max_h_eff: number;
  max_h_demag: number;
  wall_time_ns: number;
  grid: [number, number, number];
  preview_grid: [number, number, number] | null;
  preview_data_points_count: number | null;
  preview_max_points: number | null;
  preview_auto_downscaled: boolean;
  preview_auto_downscale_message: string | null;
  fem_mesh: FemLiveMesh | null;
  magnetization: Float64Array | null;
  finished: boolean;
}

export interface FemLiveMesh {
  nodes: [number, number, number][];
  elements: [number, number, number, number][];
  boundary_faces: [number, number, number][];
}

export interface ScalarRow {
  step: number;
  time: number;
  solver_dt: number;
  mx: number;
  my: number;
  mz: number;
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_total: number;
  max_dm_dt: number;
  max_h_eff: number;
  max_h_demag: number;
}

export interface EngineLogEntry {
  timestamp_unix_ms: number;
  level: string;
  message: string;
}

export interface QuantityDescriptor {
  id: string;
  label: string;
  kind: string;
  unit: string;
  location: string;
  available: boolean;
}

export interface ArtifactEntry {
  path: string;
  kind: string;
}

export interface LatestFields {
  m: Float64Array | null;
  h_ex: Float64Array | null;
  h_demag: Float64Array | null;
  h_ext: Float64Array | null;
  h_eff: Float64Array | null;
  grid: [number, number, number] | null;
}

export interface PreviewState {
  config_revision: number;
  source_step: number;
  source_time: number;
  spatial_kind: "grid" | "mesh";
  quantity: string;
  unit: string;
  component: string;
  layer: number;
  all_layers: boolean;
  type: string;
  vector_field_values: Float64Array | null;
  scalar_field: [number, number, number][];
  min: number;
  max: number;
  n_comp: number;
  max_points: number;
  data_points_count: number;
  x_possible_sizes: number[];
  y_possible_sizes: number[];
  x_chosen_size: number;
  y_chosen_size: number;
  applied_x_chosen_size: number;
  applied_y_chosen_size: number;
  applied_layer_stride: number;
  auto_scale_enabled: boolean;
  auto_downscaled: boolean;
  auto_downscale_message: string | null;
  preview_grid: [number, number, number];
  fem_mesh: FemLiveMesh | null;
  original_node_count: number | null;
  original_face_count: number | null;
}

export interface PreviewConfig {
  revision: number;
  quantity: string;
  component: string;
  layer: number;
  all_layers: boolean;
  every_n: number;
  x_chosen_size: number;
  y_chosen_size: number;
  auto_scale_enabled: boolean;
  max_points: number;
}

export interface SessionState {
  session: SessionManifest;
  run: RunManifest | null;
  live_state: LiveState | null;
  metadata: Record<string, unknown> | null;
  scalar_rows: ScalarRow[];
  engine_log: EngineLogEntry[];
  quantities: QuantityDescriptor[];
  fem_mesh: FemLiveMesh | null;
  latest_fields: LatestFields;
  artifacts: ArtifactEntry[];
  preview_config: PreviewConfig | null;
  preview: PreviewState | null;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface UseSessionStreamResult {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
}

interface SnapshotCurrentLiveEvent {
  kind: "snapshot";
  state: unknown;
}

interface PreviewCurrentLiveEvent {
  kind: "preview";
  session_id: string;
  preview_config: unknown;
  preview?: unknown;
}

function currentSessionHint(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get("session");
  return value && value.trim().length > 0 ? value.trim() : null;
}

function lastScalarStep(rows: ScalarRow[]): number {
  return rows.length > 0 ? rows[rows.length - 1]?.step ?? -1 : -1;
}

function lastLogTimestamp(entries: EngineLogEntry[]): number {
  return entries.length > 0 ? entries[entries.length - 1]?.timestamp_unix_ms ?? -1 : -1;
}

function previewSequence(preview: PreviewState | null): [number, number, number] {
  if (!preview) return [-1, -1, -1];
  return [preview.config_revision, preview.source_step, preview.source_time];
}

function compareLexicographic(
  lhs: [number, number, number],
  rhs: [number, number, number],
): number {
  for (let i = 0; i < lhs.length; i += 1) {
    if (lhs[i] > rhs[i]) return 1;
    if (lhs[i] < rhs[i]) return -1;
  }
  return 0;
}

function mergeSessionState(prev: SessionState | null, next: SessionState): SessionState {
  if (!prev) {
    return next;
  }
  if (prev.session.session_id !== next.session.session_id) {
    return next;
  }

  const merged: SessionState = { ...next };

  if (!merged.fem_mesh && prev.fem_mesh) {
    merged.fem_mesh = prev.fem_mesh;
  }

  const prevLiveTs = prev.live_state?.updated_at_unix_ms ?? -1;
  const nextLiveTs = next.live_state?.updated_at_unix_ms ?? -1;
  const prevLiveStep = prev.live_state?.step ?? -1;
  const nextLiveStep = next.live_state?.step ?? -1;
  const liveRegressed =
    prev.live_state != null &&
    (
      next.live_state == null ||
      nextLiveTs < prevLiveTs ||
      (nextLiveTs === prevLiveTs && nextLiveStep < prevLiveStep)
    );

  if (liveRegressed) {
    merged.live_state = prev.live_state;
    merged.latest_fields = prev.latest_fields;
    if (prev.fem_mesh) {
      merged.fem_mesh = prev.fem_mesh;
    }
  }

  const prevRunSteps = prev.run?.total_steps ?? -1;
  const nextRunSteps = next.run?.total_steps ?? -1;
  if (prev.run && next.run && nextRunSteps < prevRunSteps) {
    merged.run = prev.run;
  }

  if (
    prev.preview_config &&
    (
      !next.preview_config ||
      next.preview_config.revision < prev.preview_config.revision
    )
  ) {
    merged.preview_config = prev.preview_config;
  }

  const previewOrdering = compareLexicographic(
    previewSequence(next.preview),
    previewSequence(prev.preview),
  );
  const previewRegressed = prev.preview != null && previewOrdering < 0;
  const previewUnchanged = prev.preview != null && previewOrdering === 0;
  if (previewRegressed || previewUnchanged) {
    merged.preview = prev.preview;
  }

  const prevScalarStep = lastScalarStep(prev.scalar_rows);
  const nextScalarStep = lastScalarStep(next.scalar_rows);
  if (nextScalarStep < prevScalarStep) {
    merged.scalar_rows = prev.scalar_rows;
  } else if (next.scalar_rows.length === prev.scalar_rows.length) {
    merged.scalar_rows = prev.scalar_rows;
  }

  const prevLogTs = lastLogTimestamp(prev.engine_log);
  const nextLogTs = lastLogTimestamp(next.engine_log);
  if (nextLogTs < prevLogTs) {
    merged.engine_log = prev.engine_log;
  } else if (next.engine_log.length === prev.engine_log.length) {
    merged.engine_log = prev.engine_log;
  }

  return merged;
}

function flattenField(raw: any): Float64Array | null {
  if (!raw || !Array.isArray(raw.values)) {
    return null;
  }
  const source = raw.values;
  const flattened = new Float64Array(source.length * 3);
  let offset = 0;
  for (const vector of source) {
    flattened[offset] = Number(Array.isArray(vector) ? vector[0] ?? 0 : 0);
    flattened[offset + 1] = Number(Array.isArray(vector) ? vector[1] ?? 0 : 0);
    flattened[offset + 2] = Number(Array.isArray(vector) ? vector[2] ?? 0 : 0);
    offset += 3;
  }
  return flattened;
}

function toFloat64Array(raw: unknown): Float64Array | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const values = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    values[i] = Number(raw[i] ?? 0);
  }
  return values;
}

function normalizeVectorFieldValues(raw: unknown): Float64Array | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.length === 0) {
    return new Float64Array(0);
  }
  if (Array.isArray(raw[0])) {
    const source = raw as unknown[];
    const flattened = new Float64Array(source.length * 3);
    let offset = 0;
    for (const vector of source) {
      flattened[offset] = Number(Array.isArray(vector) ? vector[0] ?? 0 : 0);
      flattened[offset + 1] = Number(Array.isArray(vector) ? vector[1] ?? 0 : 0);
      flattened[offset + 2] = Number(Array.isArray(vector) ? vector[2] ?? 0 : 0);
      offset += 3;
    }
    return flattened;
  }
  return toFloat64Array(raw);
}

function fieldGrid(raw: any): [number, number, number] | null {
  const grid = raw?.layout?.grid_cells;
  if (!Array.isArray(grid) || grid.length !== 3) {
    return null;
  }
  return [Number(grid[0]), Number(grid[1]), Number(grid[2])];
}

function normalizePreviewConfig(raw: any): PreviewConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    revision: Number(raw.revision ?? 0),
    quantity: String(raw.quantity ?? "m"),
    component: String(raw.component ?? "3D"),
    layer: Number(raw.layer ?? 0),
    all_layers: Boolean(raw.all_layers),
    every_n: Number(raw.every_n ?? 10),
    x_chosen_size: Number(raw.x_chosen_size ?? 0),
    y_chosen_size: Number(raw.y_chosen_size ?? 0),
    auto_scale_enabled: Boolean(raw.auto_scale_enabled ?? true),
    max_points: Number(raw.max_points ?? 0),
  };
}

function normalizePreviewState(raw: any): PreviewState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    config_revision: Number(raw.config_revision ?? 0),
    source_step: Number(raw.source_step ?? 0),
    source_time: Number(raw.source_time ?? 0),
    spatial_kind: raw.spatial_kind === "mesh" ? "mesh" : "grid",
    quantity: raw.quantity ?? "",
    unit: raw.unit ?? "",
    component: raw.component ?? "3D",
    layer: Number(raw.layer ?? 0),
    all_layers: Boolean(raw.all_layers),
    type: raw.type ?? "3D",
    vector_field_values: normalizeVectorFieldValues(raw.vector_field_values),
    scalar_field: Array.isArray(raw.scalar_field)
      ? raw.scalar_field
          .filter((point: unknown) => Array.isArray(point) && point.length >= 3)
          .map(
            (point: number[]) =>
              [Number(point[0]), Number(point[1]), Number(point[2])] as [
                number,
                number,
                number,
              ],
          )
      : [],
    min: Number(raw.min ?? 0),
    max: Number(raw.max ?? 0),
    n_comp: Number(raw.n_comp ?? 0),
    max_points: Number(raw.max_points ?? 0),
    data_points_count: Number(raw.data_points_count ?? 0),
    x_possible_sizes: Array.isArray(raw.x_possible_sizes)
      ? raw.x_possible_sizes.map(Number)
      : [],
    y_possible_sizes: Array.isArray(raw.y_possible_sizes)
      ? raw.y_possible_sizes.map(Number)
      : [],
    x_chosen_size: Number(raw.x_chosen_size ?? 0),
    y_chosen_size: Number(raw.y_chosen_size ?? 0),
    applied_x_chosen_size: Number(raw.applied_x_chosen_size ?? 0),
    applied_y_chosen_size: Number(raw.applied_y_chosen_size ?? 0),
    applied_layer_stride: Number(raw.applied_layer_stride ?? 1),
    auto_scale_enabled: Boolean(raw.auto_scale_enabled),
    auto_downscaled: Boolean(raw.auto_downscaled),
    auto_downscale_message: raw.auto_downscale_message ?? null,
    preview_grid:
      Array.isArray(raw.preview_grid) && raw.preview_grid.length === 3
        ? [
            Number(raw.preview_grid[0]),
            Number(raw.preview_grid[1]),
            Number(raw.preview_grid[2]),
          ]
        : [0, 0, 0],
    fem_mesh: raw.fem_mesh ?? null,
    original_node_count:
      raw.original_node_count != null ? Number(raw.original_node_count) : null,
    original_face_count:
      raw.original_face_count != null ? Number(raw.original_face_count) : null,
  };
}

function mergePreviewEvent(
  prev: SessionState | null,
  raw: PreviewCurrentLiveEvent,
): SessionState | null {
  if (!prev || prev.session.session_id !== raw.session_id) {
    return prev;
  }

  let previewConfig = normalizePreviewConfig(raw.preview_config) ?? prev.preview_config;
  if (
    previewConfig &&
    prev.preview_config &&
    previewConfig.revision < prev.preview_config.revision
  ) {
    previewConfig = prev.preview_config;
  }

  let preview = normalizePreviewState(raw.preview);
  const previewOrdering = compareLexicographic(
    previewSequence(preview),
    previewSequence(prev.preview),
  );
  if (!preview || (prev.preview != null && previewOrdering <= 0)) {
    preview = prev.preview;
  }

  return {
    ...prev,
    preview_config: previewConfig,
    preview,
  };
}

function normalizeSessionState(raw: any): SessionState {
  const rawLive = raw.live_state;
  const rawLatest = raw.latest_fields ?? {};
  const rawPreview = raw.preview ?? null;
  const rawPreviewConfig = raw.preview_config ?? null;
  const fallbackGrid =
    fieldGrid(rawLatest.m) ??
    fieldGrid(rawLatest.h_ex) ??
    fieldGrid(rawLatest.h_demag) ??
    fieldGrid(rawLatest.h_ext) ??
    fieldGrid(rawLatest.h_eff);

  const liveState: LiveState | null = rawLive
    ? {
        status: rawLive.status,
        updated_at_unix_ms: rawLive.updated_at_unix_ms,
        step: rawLive.latest_step?.step ?? 0,
        time: rawLive.latest_step?.time ?? 0,
        dt: rawLive.latest_step?.dt ?? 0,
        e_ex: rawLive.latest_step?.e_ex ?? 0,
        e_demag: rawLive.latest_step?.e_demag ?? 0,
        e_ext: rawLive.latest_step?.e_ext ?? 0,
        e_total: rawLive.latest_step?.e_total ?? 0,
        max_dm_dt: rawLive.latest_step?.max_dm_dt ?? 0,
        max_h_eff: rawLive.latest_step?.max_h_eff ?? 0,
        max_h_demag: rawLive.latest_step?.max_h_demag ?? 0,
        wall_time_ns: rawLive.latest_step?.wall_time_ns ?? 0,
        grid: rawLive.latest_step?.grid ?? fallbackGrid ?? [0, 0, 0],
        preview_grid: rawLive.latest_step?.preview_grid ?? null,
        preview_data_points_count: rawLive.latest_step?.preview_data_points_count ?? null,
        preview_max_points: rawLive.latest_step?.preview_max_points ?? null,
        preview_auto_downscaled: Boolean(rawLive.latest_step?.preview_auto_downscaled),
        preview_auto_downscale_message: rawLive.latest_step?.preview_auto_downscale_message ?? null,
        fem_mesh: rawLive.latest_step?.fem_mesh ?? null,
        magnetization: toFloat64Array(rawLive.latest_step?.magnetization),
        finished: Boolean(rawLive.latest_step?.finished),
      }
    : null;

  return {
    session: raw.session,
    run: raw.run ?? null,
    live_state: liveState,
    metadata: raw.metadata ?? null,
    scalar_rows: Array.isArray(raw.scalar_rows)
      ? raw.scalar_rows.map((row: any) => ({
          step: Number(row?.step ?? 0),
          time: Number(row?.time ?? 0),
          solver_dt: Number(row?.solver_dt ?? 0),
          mx: Number(row?.mx ?? 0),
          my: Number(row?.my ?? 0),
          mz: Number(row?.mz ?? 0),
          e_ex: Number(row?.e_ex ?? 0),
          e_demag: Number(row?.e_demag ?? 0),
          e_ext: Number(row?.e_ext ?? 0),
          e_total: Number(row?.e_total ?? 0),
          max_dm_dt: Number(row?.max_dm_dt ?? 0),
          max_h_eff: Number(row?.max_h_eff ?? 0),
          max_h_demag: Number(row?.max_h_demag ?? 0),
        }))
      : [],
    engine_log: Array.isArray(raw.engine_log) ? raw.engine_log : [],
    quantities: Array.isArray(raw.quantities) ? raw.quantities : [],
    fem_mesh: raw.fem_mesh ?? raw.live_state?.latest_step?.fem_mesh ?? null,
    latest_fields: {
      m: flattenField(rawLatest.m),
      h_ex: flattenField(rawLatest.h_ex),
      h_demag: flattenField(rawLatest.h_demag),
      h_ext: flattenField(rawLatest.h_ext),
      h_eff: flattenField(rawLatest.h_eff),
      grid: fallbackGrid,
    },
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    preview_config: normalizePreviewConfig(rawPreviewConfig),
    preview: normalizePreviewState(rawPreview),
  };
}

export function useCurrentLiveStream(): UseSessionStreamResult {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [sessionHint] = useState<string | null>(() => currentSessionHint());
  const wsRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const intentionallyClosedRef = useRef(new WeakSet<WebSocket>());

  const connect = useCallback(() => {
    const client = currentLiveApiClient();
    const previousWs = wsRef.current;
    if (previousWs) {
      intentionallyClosedRef.current.add(previousWs);
      previousWs.close();
      wsRef.current = null;
    }

    client
      .fetchBootstrap()
      .then((raw) => {
        if (unmountedRef.current) {
          return;
        }
        const nextState = normalizeSessionState(raw);
        if (sessionHint && nextState.session.session_id !== sessionHint) {
          setState(null);
          setError(null);
          return;
        }
        if (nextState.live_state?.finished) {
          finishedRef.current = true;
        }
        setState((prevState) => mergeSessionState(prevState, nextState));
      })
      .catch((bootstrapError) => {
        if (unmountedRef.current) {
          return;
        }
        if (bootstrapError instanceof ApiHttpError && bootstrapError.status === 404) {
          // Keep the last good workspace visible while the singleton live API
          // is restarting or waiting for the next snapshot. This avoids
          // remounting the entire control room and resetting 3D camera state.
          setError(null);
          return;
        }
        setError(
          bootstrapError instanceof Error ? bootstrapError.message : "Failed to load live state",
        );
      });

    const ws = client.connectWebSocket();
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current || wsRef.current !== ws) {
        return;
      }
      if (disconnectTimerRef.current !== null) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setConnection("connected");
      setError(null);
      reconnectAttemptRef.current = 0;
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (unmountedRef.current || wsRef.current !== ws) {
        return;
      }
      try {
        const raw = JSON.parse(event.data);
        setState((prevState) => {
          if (raw?.kind === "snapshot" && raw.state) {
            const nextState = normalizeSessionState((raw as SnapshotCurrentLiveEvent).state);
            if (sessionHint && nextState.session.session_id !== sessionHint) {
              return null;
            }
            if (nextState.live_state?.finished) {
              finishedRef.current = true;
            }
            return mergeSessionState(prevState, nextState);
          }

          if (raw?.kind === "preview" && typeof raw.session_id === "string") {
            return mergePreviewEvent(prevState, raw as PreviewCurrentLiveEvent);
          }

          const nextState = normalizeSessionState(raw);
          if (sessionHint && nextState.session.session_id !== sessionHint) {
            return null;
          }
          if (nextState.live_state?.finished) {
            finishedRef.current = true;
          }
          return mergeSessionState(prevState, nextState);
        });
      } catch (parseError) {
        console.warn("Failed to parse current live ws payload", parseError);
      }
    };

    ws.onerror = () => {
      if (
        unmountedRef.current ||
        wsRef.current !== ws ||
        intentionallyClosedRef.current.has(ws)
      ) {
        return;
      }
      ws.close();
    };

    ws.onclose = () => {
      if (
        unmountedRef.current ||
        wsRef.current !== ws ||
        intentionallyClosedRef.current.has(ws)
      ) {
        return;
      }

      if (finishedRef.current) {
        setConnection("disconnected");
        return;
      }

      // Preserve the last good workspace while reconnecting so viewer state
      // (camera, selections, local tool state) survives transient disconnects.
      setConnection("connecting");
      setError(null);

      disconnectTimerRef.current = setTimeout(() => {
        disconnectTimerRef.current = null;
        setConnection("disconnected");
      }, 2000);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (wsRef.current === ws) {
          reconnectAttemptRef.current += 1;
          setConnection("connecting");
          connect();
        }
      }, Math.min(1500 * Math.pow(2, reconnectAttemptRef.current), 30000));
    };
  }, [sessionHint]);

  useEffect(() => {
    unmountedRef.current = false;
    finishedRef.current = false;
    setState(null);
    setConnection("connecting");
    setError(null);
    connect();
    return () => {
      unmountedRef.current = true;
      const ws = wsRef.current;
      if (ws) {
        intentionallyClosedRef.current.add(ws);
        ws.close();
        wsRef.current = null;
      }
      if (disconnectTimerRef.current !== null) {
        clearTimeout(disconnectTimerRef.current);
      }
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [connect]);

  return { state, connection, error };
}
