"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface UseSessionStreamResult {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8080";

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
  };
}

export function useSessionStream(sessionId: string): UseSessionStreamResult {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  // Set to true once the session emits a finished=true state — stops reconnect loop.
  const finishedRef = useRef(false);
  // Debounce timer for "disconnected" — avoids "Offline" flash on transient drops.
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const url = `${API_BASE}/v1/sessions/${sessionId}/events`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      // Cancel any pending "disconnected" flash and go straight to connected.
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
          // Mark as permanently finished so we stop reconnecting.
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
        // Run is done — server closed the stream intentionally. Stay disconnected.
        setConnection("disconnected");
        return;
      }

      // Debounce: only show "Offline" if the reconnect doesn't succeed quickly.
      // This prevents "Live → Offline → Live" flicker on transient drops.
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
  }, [sessionId]);

  useEffect(() => {
    connect();
    return () => {
      const es = esRef.current;
      if (es) {
        es.close();
        esRef.current = null;
      }
      if (disconnectTimerRef.current !== null) {
        clearTimeout(disconnectTimerRef.current);
      }
    };
  }, [connect]);

  return { state, connection, error };
}
