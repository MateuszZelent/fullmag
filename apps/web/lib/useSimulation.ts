"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface StepStats {
  step: number;
  time: number;
  dt: number;
  e_ex: number;
  max_dm_dt: number;
  max_h_eff: number;
  wall_time_ns: number;
}

export interface StepUpdate {
  stats: StepStats;
  grid: [number, number, number];
  magnetization?: number[];
  finished: boolean;
}

export type SimStatus = "idle" | "connecting" | "running" | "completed" | "error";

export interface SimulationState {
  status: SimStatus;
  steps: StepStats[];
  grid: [number, number, number];
  magnetization: Float64Array | null;
  error: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export function useSimulation() {
  const [state, setState] = useState<SimulationState>({
    status: "idle",
    steps: [],
    grid: [0, 0, 0],
    magnetization: null,
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const stepsRef = useRef<StepStats[]>([]);

  const connect = useCallback(() => {
    const wsUrl = API_BASE.replace(/^http/, "ws") + "/ws/live";
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    setState((prev) => ({ ...prev, status: "connecting" }));

    ws.onopen = () => {
      setState((prev) => ({ ...prev, status: "running" }));
    };

    ws.onmessage = (event) => {
      try {
        const update: StepUpdate = JSON.parse(event.data);
        stepsRef.current = [...stepsRef.current, update.stats];

        setState((prev) => ({
          ...prev,
          status: update.finished ? "completed" : "running",
          steps: stepsRef.current,
          grid: update.grid,
          magnetization: update.magnetization
            ? new Float64Array(update.magnetization)
            : prev.magnetization,
        }));
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      setState((prev) => ({ ...prev, status: "error", error: "WebSocket error" }));
    };

    ws.onclose = () => {
      setState((prev) => {
        if (prev.status === "running") {
          return { ...prev, status: "completed" };
        }
        return prev;
      });
    };
  }, []);

  const startRun = useCallback(
    async (problemIR: object, untilSeconds: number) => {
      stepsRef.current = [];
      setState({
        status: "connecting",
        steps: [],
        grid: [0, 0, 0],
        magnetization: null,
        error: null,
      });

      // Connect WS first, then POST the run
      connect();

      try {
        const res = await fetch(`${API_BASE}/v1/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            problem: problemIR,
            until_seconds: untilSeconds,
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          setState((prev) => ({ ...prev, status: "error", error: err }));
        }
      } catch (e) {
        setState((prev) => ({
          ...prev,
          status: "error",
          error: String(e),
        }));
      }
    },
    [connect]
  );

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  return { ...state, startRun, disconnect };
}
