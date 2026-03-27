"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { currentLiveApiClient } from "./liveApiClient";

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
  magnetization: number[] | null;
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
  m: number[] | null;
  h_ex: number[] | null;
  h_demag: number[] | null;
  h_ext: number[] | null;
  h_eff: number[] | null;
  grid: [number, number, number] | null;
}

export interface PreviewState {
  config_revision: number;
  spatial_kind: "grid" | "mesh";
  quantity: string;
  unit: string;
  component: string;
  layer: number;
  all_layers: boolean;
  type: string;
  vector_field_values: number[] | null;
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

function flattenField(raw: any): number[] | null {
  if (!raw || !Array.isArray(raw.values)) {
    return null;
  }
  return raw.values.flatMap((vector: number[]) => vector);
}

function fieldGrid(raw: any): [number, number, number] | null {
  const grid = raw?.layout?.grid_cells;
  if (!Array.isArray(grid) || grid.length !== 3) {
    return null;
  }
  return [Number(grid[0]), Number(grid[1]), Number(grid[2])];
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
        magnetization: rawLive.latest_step?.magnetization ?? null,
        finished: Boolean(rawLive.latest_step?.finished),
      }
    : null;

  return {
    session: raw.session,
    run: raw.run ?? null,
    live_state: liveState,
    metadata: raw.metadata ?? null,
    scalar_rows: Array.isArray(raw.scalar_rows) ? raw.scalar_rows : [],
    engine_log: Array.isArray(raw.engine_log)
      ? raw.engine_log.map((entry: any) => ({
          timestamp_unix_ms: Number(entry?.timestamp_unix_ms ?? 0),
          level: String(entry?.level ?? "info"),
          message: String(entry?.message ?? ""),
        }))
      : [],
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
    preview_config: rawPreviewConfig
      ? {
          revision: Number(rawPreviewConfig.revision ?? 0),
          quantity: String(rawPreviewConfig.quantity ?? "m"),
          component: String(rawPreviewConfig.component ?? "3D"),
          layer: Number(rawPreviewConfig.layer ?? 0),
          all_layers: Boolean(rawPreviewConfig.all_layers),
          x_chosen_size: Number(rawPreviewConfig.x_chosen_size ?? 0),
          y_chosen_size: Number(rawPreviewConfig.y_chosen_size ?? 0),
          auto_scale_enabled: Boolean(rawPreviewConfig.auto_scale_enabled ?? true),
          max_points: Number(rawPreviewConfig.max_points ?? 0),
        }
      : null,
    preview: rawPreview
      ? {
          config_revision: Number(rawPreview.config_revision ?? 0),
          spatial_kind: rawPreview.spatial_kind === "mesh" ? "mesh" : "grid",
          quantity: rawPreview.quantity ?? "",
          unit: rawPreview.unit ?? "",
          component: rawPreview.component ?? "3D",
          layer: Number(rawPreview.layer ?? 0),
          all_layers: Boolean(rawPreview.all_layers),
          type: rawPreview.type ?? "3D",
          vector_field_values: Array.isArray(rawPreview.vector_field_values)
            ? rawPreview.vector_field_values.flatMap((vector: number[]) => vector)
            : null,
          scalar_field: Array.isArray(rawPreview.scalar_field)
            ? rawPreview.scalar_field
                .filter((point: unknown) => Array.isArray(point) && point.length >= 3)
                .map((point: number[]) => [Number(point[0]), Number(point[1]), Number(point[2])] as [number, number, number])
            : [],
          min: Number(rawPreview.min ?? 0),
          max: Number(rawPreview.max ?? 0),
          n_comp: Number(rawPreview.n_comp ?? 0),
          max_points: Number(rawPreview.max_points ?? 0),
          data_points_count: Number(rawPreview.data_points_count ?? 0),
          x_possible_sizes: Array.isArray(rawPreview.x_possible_sizes)
            ? rawPreview.x_possible_sizes.map(Number)
            : [],
          y_possible_sizes: Array.isArray(rawPreview.y_possible_sizes)
            ? rawPreview.y_possible_sizes.map(Number)
            : [],
          x_chosen_size: Number(rawPreview.x_chosen_size ?? 0),
          y_chosen_size: Number(rawPreview.y_chosen_size ?? 0),
          applied_x_chosen_size: Number(rawPreview.applied_x_chosen_size ?? 0),
          applied_y_chosen_size: Number(rawPreview.applied_y_chosen_size ?? 0),
          applied_layer_stride: Number(rawPreview.applied_layer_stride ?? 1),
          auto_scale_enabled: Boolean(rawPreview.auto_scale_enabled),
          auto_downscaled: Boolean(rawPreview.auto_downscaled),
          auto_downscale_message: rawPreview.auto_downscale_message ?? null,
          preview_grid: Array.isArray(rawPreview.preview_grid) && rawPreview.preview_grid.length === 3
            ? [
                Number(rawPreview.preview_grid[0]),
                Number(rawPreview.preview_grid[1]),
                Number(rawPreview.preview_grid[2]),
              ]
            : [0, 0, 0],
          fem_mesh: rawPreview.fem_mesh ?? null,
          original_node_count:
            rawPreview.original_node_count != null ? Number(rawPreview.original_node_count) : null,
          original_face_count:
            rawPreview.original_face_count != null ? Number(rawPreview.original_face_count) : null,
        }
      : null,
  };
}

export function useCurrentLiveStream(): UseSessionStreamResult {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(false);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        if (nextState.live_state?.finished) {
          finishedRef.current = true;
        }
        setState((prevState) => {
          if (!nextState.fem_mesh && prevState?.fem_mesh) {
            nextState.fem_mesh = prevState.fem_mesh;
          }
          return nextState;
        });
      })
      .catch((bootstrapError) => {
        if (unmountedRef.current) {
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
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (unmountedRef.current || wsRef.current !== ws) {
        return;
      }
      try {
        const raw = JSON.parse(event.data);
        setState((prevState) => {
          const nextState = normalizeSessionState(raw);
          if (!nextState.fem_mesh && prevState?.fem_mesh) {
            nextState.fem_mesh = prevState.fem_mesh;
          }
          if (nextState.live_state?.finished) {
            finishedRef.current = true;
          }
          return nextState;
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

      disconnectTimerRef.current = setTimeout(() => {
        disconnectTimerRef.current = null;
        setConnection("disconnected");
      }, 2000);

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (wsRef.current === ws) {
          setConnection("connecting");
          connect();
        }
      }, 1500);
    };
  }, []);

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
