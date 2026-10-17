"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComputeNodePolicyUpdateRequest } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import {
  usePlatformCapabilitiesResource,
  usePlatformComputeNodesResource,
} from "@/kernel/resources/runtimeExplorerResources";
import { useCpuTelemetryResource, useGpuTelemetryResource } from "@/kernel/resources/studyRuntimeResources";

import { probeCompute } from "./computeProbe";
import {
  computeFromTelemetry,
  describeRuntimeLanes,
  isTelemetrySampleStale,
  isTelemetrySampleStaleByAge,
} from "./computeTelemetry";
import {
  parseComputeNodePolicyResource,
  summarizeComputeNodeInventory,
} from "./computeNodeInventory";
import type { ComputeProbeController, ComputeProbeState } from "./types";

export const COMPUTE_POLL_MS = 5000;

function monotonicNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

interface ResourceReceipt<TData> {
  readonly data: TData | null;
  readonly receivedAt: number;
}

function resourceReceipt<TData>(data: TData | null): ResourceReceipt<TData> {
  return {
    data,
    receivedAt: data == null ? 0 : monotonicNow(),
  };
}

function elapsedSinceResourceReceipt<TData>(
  receipt: ResourceReceipt<TData>,
  data: TData | null,
  now: number | undefined,
): number {
  if (receipt.data !== data || receipt.data == null || now === undefined) return 0;
  return Math.max(0, now - receipt.receivedAt);
}

/** One owner for the rail, settings, templates and project compatibility checks. */
export function useComputeProbe(): ComputeProbeController {
  const { api } = useKernel();
  const cpu = useCpuTelemetryResource();
  const gpu = useGpuTelemetryResource();
  const capabilities = usePlatformCapabilitiesResource();
  const nodeInventoryResource = usePlatformComputeNodesResource();
  const nodeInventoryData = nodeInventoryResource.data;
  const nodeInventoryStatus = nodeInventoryResource.status;
  const nodeInventoryRefreshError = nodeInventoryResource.refreshError;
  const [freshnessNow, setFreshnessNow] = useState<number | undefined>(undefined);
  const [resourceClockNow, setResourceClockNow] = useState<number | undefined>(undefined);
  // `collected_at` belongs to the server's wall clock. Anchor each response
  // by data identity in the browser's monotonic clock, without extending the
  // shared resource result or introducing another cache. The timestamp is a
  // read performed only when the resource identity changes.
  const nodeInventoryReceipt = useMemo(
    () => resourceReceipt(nodeInventoryData),
    [nodeInventoryData],
  );
  const nodeInventoryElapsedMs = elapsedSinceResourceReceipt(
    nodeInventoryReceipt,
    nodeInventoryData,
    resourceClockNow,
  );
  const cpuTelemetryReceipt = useMemo(
    () => resourceReceipt(cpu.data),
    [cpu.data],
  );
  const gpuTelemetryReceipt = useMemo(
    () => resourceReceipt(gpu.data),
    [gpu.data],
  );
  const cpuTelemetryElapsedMs = elapsedSinceResourceReceipt(
    cpuTelemetryReceipt,
    cpu.data,
    resourceClockNow,
  );
  const gpuTelemetryElapsedMs = elapsedSinceResourceReceipt(
    gpuTelemetryReceipt,
    gpu.data,
    resourceClockNow,
  );
  const nodeInventory = useMemo(
    () => summarizeComputeNodeInventory({
      data: nodeInventoryData,
      status: nodeInventoryStatus,
      refreshError: nodeInventoryRefreshError,
    }, nodeInventoryElapsedMs),
    [nodeInventoryData, nodeInventoryElapsedMs, nodeInventoryRefreshError, nodeInventoryStatus],
  );
  const [desktop, setDesktop] = useState<ComputeProbeState>(undefined);
  const [desktopRefreshing, setDesktopRefreshing] = useState(false);
  const [desktopFailed, setDesktopFailed] = useState(false);
  const [desktopRefreshId, setDesktopRefreshId] = useState(0);
  const operatorCapability = useRef<string | null>(null);
  const [canEditNodePolicy, setCanEditNodePolicy] = useState(false);
  const needsDesktop = cpu.status === "error" && gpu.status === "error" && !cpu.data && !gpu.data;

  useEffect(() => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    let cancelled = false;
    void invoke<unknown>("local_compute_operator_capability").then((value) => {
      if (cancelled) return;
      if (typeof value === "string" && /^[0-9a-f]{32}$/.test(value)) {
        operatorCapability.current = value;
        setCanEditNodePolicy(true);
      }
    }).catch(() => {
      if (!cancelled) {
        operatorCapability.current = null;
        setCanEditNodePolicy(false);
      }
    });
    return () => {
      cancelled = true;
      operatorCapability.current = null;
    };
  }, []);

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
  const { refetch: refetchNodeInventory } = nodeInventoryResource;
  const updateNodePolicy = useCallback(async (
    nodeId: string,
    expectedRevision: number,
    request: ComputeNodePolicyUpdateRequest,
  ) => {
    const capability = operatorCapability.current;
    if (!capability) throw new Error("Policy changes are available only in the local Fullmag desktop app.");
    const policy = await api.platform.updateComputeNodePolicy(nodeId, request, {
      operatorCapability: capability,
      expectedRevision,
    });
    refetchNodeInventory();
    const parsed = parseComputeNodePolicyResource(policy);
    if (!parsed) throw new Error("The API returned an invalid compute-node policy.");
    return parsed;
  }, [api, refetchNodeInventory]);
  const refresh = useCallback(() => {
    setFreshnessNow(Date.now());
    setResourceClockNow(monotonicNow());
    refetchCpu();
    refetchGpu();
    refetchCapabilities();
    refetchNodeInventory();
    setDesktopRefreshId((id) => id + 1);
  }, [refetchCpu, refetchGpu, refetchCapabilities, refetchNodeInventory]);

  // Sampling owns no extra cache or transport. Hidden windows do not request samples.
  useEffect(() => {
    const sample = () => {
      if (document.hidden) return;
      setFreshnessNow(Date.now());
      setResourceClockNow(monotonicNow());
      if (cpu.data?.status === "available" && cpu.status === "ready") refetchCpu();
      if (gpu.data?.status === "available" && gpu.status === "ready") refetchGpu();
      refetchNodeInventory();
    };
    const timer = setInterval(sample, COMPUTE_POLL_MS);
    document.addEventListener("visibilitychange", sample);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sample);
    };
  }, [
    cpu.data?.status,
    cpu.status,
    gpu.data?.status,
    gpu.status,
    refetchCpu,
    refetchGpu,
    refetchNodeInventory,
  ]);

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
  const staleByAge = usingDesktop
    ? freshnessNow !== undefined && [desktop?.sampledAt].some((timestamp) =>
      isTelemetrySampleStale(timestamp, freshnessNow))
    : [
        cpu.data?.status === "available"
          ? { elapsedMs: cpuTelemetryElapsedMs, timestamp: cpu.data.sample_time_unix_ms }
          : undefined,
        gpu.data?.status === "available"
          ? { elapsedMs: gpuTelemetryElapsedMs, timestamp: gpu.data.sample_time_unix_ms }
          : undefined,
      ].some((sample) => sample !== undefined &&
        isTelemetrySampleStaleByAge(sample.elapsedMs, sample.timestamp));
  const stale = staleByAge ||
    observedResources.some((resource) => resource.data &&
      (resource.status === "error" || resource.refreshError)) || (usingDesktop && desktopFailed);
  const failed = observedResources.some((resource) => resource.status === "error" || resource.refreshError) ||
    (usingDesktop && desktopFailed);
  return {
    compute,
    nodeInventory,
    canEditNodePolicy,
    refreshing: (needsDesktop && desktopRefreshing) ||
      nodeInventoryResource.status === "loading" ||
      (nodeInventoryResource.status === "stale" && !nodeInventoryResource.refreshError) ||
      resources.some((resource) =>
        resource.status === "loading" || (resource.status === "stale" && !resource.refreshError)),
    stale,
    error: failed
      ? stale
        ? "Could not refresh the host readings. Showing the last received data."
        : "Some host readings could not be retrieved. Refresh to try again."
      : null,
    refresh,
    updateNodePolicy,
  };
}
