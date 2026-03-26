"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveApiBase, resolveApiWsBase } from "./apiBase";

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

export interface SessionState {
  session: SessionManifest;
  run: RunManifest | null;
  live_state: LiveState | null;
  metadata: Record<string, unknown> | null;
  scalar_rows: ScalarRow[];
  quantities: QuantityDescriptor[];
  fem_mesh: FemLiveMesh | null;
  latest_fields: LatestFields;
  artifacts: ArtifactEntry[];
  preview: PreviewState | null;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface UseSessionStreamResult {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
}

type LiveStreamTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "current" };

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
    preview: rawPreview
      ? {
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

function buildStreamUrls(
  target: LiveStreamTarget,
): { bootstrapUrl: string; eventsUrl?: string; wsUrl?: string } {
  const apiBase = resolveApiBase();
  if (target.kind === "current") {
    return {
      bootstrapUrl: `${apiBase}/v1/live/current/bootstrap`,
      wsUrl: `${resolveApiWsBase()}/ws/live/current`,
    };
  }
  return {
    bootstrapUrl: `${apiBase}/v1/sessions/${target.sessionId}/state`,
    eventsUrl: `${apiBase}/v1/sessions/${target.sessionId}/events`,
  };
}

export function useLiveStream(target: LiveStreamTarget): UseSessionStreamResult {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Set to true once the session emits a finished=true state — stops reconnect loop.
  const finishedRef = useRef(false);
  // Debounce timer for "disconnected" — avoids "Offline" flash on transient drops.
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetKind = target.kind;
  const targetSessionId = target.kind === "session" ? target.sessionId : null;

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const { bootstrapUrl, eventsUrl, wsUrl } =
      targetKind === "current"
        ? buildStreamUrls({ kind: "current" })
        : buildStreamUrls({ kind: "session", sessionId: targetSessionId ?? "" });

    fetch(bootstrapUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? `HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((raw) => {
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
        setError(
          bootstrapError instanceof Error ? bootstrapError.message : "Failed to load live state",
        );
      });

    if (targetKind === "current") {
      const ws = new WebSocket(wsUrl ?? `${resolveApiWsBase()}/ws/live/current`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disconnectTimerRef.current !== null) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }
        setConnection("connected");
        setError(null);
      };

      ws.onmessage = (event: MessageEvent<string>) => {
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
        ws.close();
      };

      ws.onclose = () => {
        if (finishedRef.current) {
          setConnection("disconnected");
          return;
        }
        disconnectTimerRef.current = setTimeout(() => {
          disconnectTimerRef.current = null;
          setConnection("disconnected");
        }, 2000);
        setTimeout(() => {
          if (wsRef.current === ws) {
            setConnection("connecting");
            connect();
          }
        }, 1500);
      };
      return;
    }

    const es = new EventSource(eventsUrl ?? "");
    esRef.current = es;

    es.onopen = () => {
      if (disconnectTimerRef.current !== null) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }
      setConnection("connected");
      setError(null);
    };

    es.addEventListener("session_state", (event: MessageEvent) => {
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
        console.warn("Failed to parse session_state event", parseError);
      }
    });

    es.addEventListener("session_error", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setError(data.error ?? "Unknown error");
      } catch {
        setError("Unknown session error");
      }
    });

    es.onerror = () => {
      es.close();

      if (finishedRef.current) {
        setConnection("disconnected");
        return;
      }

      disconnectTimerRef.current = setTimeout(() => {
        disconnectTimerRef.current = null;
        setConnection("disconnected");
      }, 2000);

      setTimeout(() => {
        if (esRef.current === es) {
          setConnection("connecting");
          connect();
        }
      }, 1500);
    };
  }, [targetKind, targetSessionId]);

  useEffect(() => {
    finishedRef.current = false;
    setState(null);
    setConnection("connecting");
    setError(null);
    connect();
    return () => {
      const es = esRef.current;
      if (es) {
        es.close();
        esRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        ws.close();
        wsRef.current = null;
      }
      if (disconnectTimerRef.current !== null) {
        clearTimeout(disconnectTimerRef.current);
      }
    };
  }, [connect]);

  return { state, connection, error };
}

export function useSessionStream(sessionId: string): UseSessionStreamResult {
  return useLiveStream({ kind: "session", sessionId });
}

export function useCurrentLiveStream(): UseSessionStreamResult {
  return useLiveStream({ kind: "current" });
}
