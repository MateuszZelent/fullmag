import { useEffect, useState } from "react";
import type { GpuTelemetryResponse } from "@/src/api/types";
import type { createControlRoomApi } from "../controlRoomApi";
import { GPU_TELEMETRY_POLL_MS } from "../controlRoomUtils";

export function useGpuTelemetry(opts: {
  liveApi: ReturnType<typeof createControlRoomApi>;
  runtimeUsesGpu: boolean;
}): GpuTelemetryResponse | null {
  const { liveApi, runtimeUsesGpu } = opts;
  const [gpuTelemetry, setGpuTelemetry] = useState<GpuTelemetryResponse | null>(null);

  useEffect(() => {
    if (!runtimeUsesGpu) {
      setGpuTelemetry(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const next = await liveApi.fetchGpuTelemetry();
        if (!cancelled) {
          setGpuTelemetry(next);
        }
      } catch {
        if (!cancelled) {
          setGpuTelemetry(null);
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, GPU_TELEMETRY_POLL_MS);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [liveApi, runtimeUsesGpu]);

  return gpuTelemetry;
}
