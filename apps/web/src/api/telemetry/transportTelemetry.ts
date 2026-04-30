/**
 * Transport-layer telemetry: decode worker, field-vector inflight, and resource cache.
 *
 * Metrics:
 *   viewport.fieldVectorCache.bytes        — bytes held in the field-vector resource cache
 *   viewport.fieldVectorCache.entries      — number of cache entries
 *   viewport.fieldVectorInflight.count     — in-progress field-vector fetches
 *   viewport.decodeWorker.pending          — requests queued in the decode worker
 *   viewport.decodeWorker.transferredBytes — total ArrayBuffer bytes sent to the worker via transfer list
 */

import { getLiveSessionClient } from "../client/LiveSessionClient";
import { getDecodeWorkerStats } from "../codecs/decodeOffThread";
import { getFieldVectorInflightCount } from "../../hooks/resources/useFieldVector";

export interface TransportTelemetry {
  fieldVectorCache: {
    bytes: number;
    entries: number;
    maxBytes: number;
    utilization: number;
  };
  fieldVectorInflight: {
    count: number;
  };
  decodeWorker: {
    pending: number;
    totalTransferredBytes: number;
  };
}

/**
 * Snapshot of current transport-layer telemetry.
 * Safe to call at any time from any context (no React dependency).
 */
export function getTransportTelemetry(): TransportTelemetry {
  const cacheStats = getLiveSessionClient().getCache().getCacheStats();
  const workerStats = getDecodeWorkerStats();

  return {
    fieldVectorCache: {
      bytes: cacheStats.totalBytes,
      entries: cacheStats.entryCount,
      maxBytes: cacheStats.maxBytes,
      utilization: cacheStats.utilization,
    },
    fieldVectorInflight: {
      count: getFieldVectorInflightCount(),
    },
    decodeWorker: {
      pending: workerStats.pendingCount,
      totalTransferredBytes: workerStats.totalTransferredBytes,
    },
  };
}
