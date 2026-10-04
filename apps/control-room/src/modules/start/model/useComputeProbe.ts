"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { usePlatformCapabilitiesResource } from "@/kernel/resources/runtimeExplorerResources";
import { useCpuTelemetryResource, useGpuTelemetryResource } from "@/kernel/resources/studyRuntimeResources";

import { probeCompute } from "./computeProbe";
import { computeFromTelemetry, describeRuntimeLanes } from "./computeTelemetry";
import type { ComputeProbeController, ComputeProbeState } from "./types";

export const COMPUTE_POLL_MS = 5000;

/** One owner for the rail, settings, templates and project compatibility checks. */
export function useComputeProbe(): ComputeProbeController {
  const cpu = useCpuTelemetryResource();
  const gpu = useGpuTelemetryResource();
  const capabilities = usePlatformCapabilitiesResource();
  const [desktop, setDesktop] = useState<ComputeProbeState>(undefined);
  const [desktopRefreshing, setDesktopRefreshing] = useState(false);
  const [desktopFailed, setDesktopFailed] = useState(false);
  const [desktopRefreshId, setDesktopRefreshId] = useState(0);
  const needsDesktop = cpu.status === "error" && gpu.status === "error" && !cpu.data && !gpu.data;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) {
        timer = setTimeout(() => void tick(), COMPUTE_POLL_MS);
        return;
      }
      setDesktopRefreshing(true);
      try {
        const next = await probeCompute();
        if (cancelled) return;
        setDesktop((previous) => next ? { ...next, sampledAt: Date.now() } : previous ?? null);
        setDesktopFailed(!next);
        if (next) timer = setTimeout(() => void tick(), COMPUTE_POLL_MS);
      } finally {
        if (!cancelled) setDesktopRefreshing(false);
      }
    };
    if (needsDesktop) void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [needsDesktop, desktopRefreshId]);

  const { refetch: refetchCpu } = cpu;
  const { refetch: refetchGpu } = gpu;
  const { refetch: refetchCapabilities } = capabilities;
  const refresh = useCallback(() => {
    refetchCpu();
    refetchGpu();
    refetchCapabilities();
    setDesktopRefreshId((id) => id + 1);
  }, [refetchCpu, refetchGpu, refetchCapabilities]);

  // Sampling owns no extra cache or transport. Hidden windows do not request samples.
  useEffect(() => {
    const sample = () => {
      if (document.hidden) return;
      if (cpu.data?.status === "available" && cpu.status === "ready") refetchCpu();
      if (gpu.data?.status === "available" && gpu.status === "ready") refetchGpu();
    };
    const timer = setInterval(sample, COMPUTE_POLL_MS);
    document.addEventListener("visibilitychange", sample);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sample);
    };
  }, [cpu.data?.status, cpu.status, gpu.data?.status, gpu.status, refetchCpu, refetchGpu]);

  const compute = useMemo<ComputeProbeState>(() => {
    if (!gpu.data && gpu.status === "loading" && !desktop) return undefined;
    const runtime = computeFromTelemetry(cpu.data, gpu.data, capabilities.data);
    if (runtime) return runtime;
    if (desktop) return {
      ...desktop,
      source: "desktop",
      gpuProbeStatus: "ready",
      cpuProbeStatus: "ready",
      runtimeLanes: describeRuntimeLanes(capabilities.data),
    };
    if (cpu.status === "loading" || gpu.status === "loading" ||
      (needsDesktop && desktop === undefined)) return undefined;
    return null;
  }, [cpu.data, cpu.status, gpu.data, gpu.status, capabilities.data, desktop, needsDesktop]);

  const resources = [cpu, gpu, capabilities];
  const usingDesktop = needsDesktop && Boolean(desktop);
  const observedResources = usingDesktop ? [capabilities] : resources;
  const stale = observedResources.some((resource) => resource.data &&
    (resource.status === "error" || resource.refreshError)) || (usingDesktop && desktopFailed);
  const failed = observedResources.some((resource) => resource.status === "error" || resource.refreshError) ||
    (usingDesktop && desktopFailed);
  return {
    compute,
    refreshing: (needsDesktop && desktopRefreshing) || resources.some((resource) =>
      resource.status === "loading" || (resource.status === "stale" && !resource.refreshError)),
    stale,
    error: failed
      ? stale
        ? "Could not refresh the host readings. Showing the last received data."
        : "Some host readings could not be retrieved. Refresh to try again."
      : null,
    refresh,
  };
}
