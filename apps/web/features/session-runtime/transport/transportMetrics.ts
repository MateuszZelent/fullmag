/**
 * Transport metrics for session-runtime diagnostics.
 *
 * Tracks polling connection health, latency, and throughput.
 */

export interface TransportMetrics {
  connectionAttempts: number;
  successfulConnections: number;
  disconnects: number;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  messagesReceived: number;
  bytesReceived: number;
  averageLatencyMs: number | null;
  peakLatencyMs: number | null;
}

let metrics: TransportMetrics = {
  connectionAttempts: 0,
  successfulConnections: 0,
  disconnects: 0,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  messagesReceived: 0,
  bytesReceived: 0,
  averageLatencyMs: null,
  peakLatencyMs: null,
};

let latencySamples: number[] = [];

export function recordConnectionAttempt(): void {
  metrics.connectionAttempts += 1;
}

export function recordConnectionSuccess(): void {
  metrics.successfulConnections += 1;
  metrics.lastConnectedAt = Date.now();
}

export function recordDisconnect(): void {
  metrics.disconnects += 1;
  metrics.lastDisconnectedAt = Date.now();
}

export function recordMessage(bytes: number, latencyMs?: number): void {
  metrics.messagesReceived += 1;
  metrics.bytesReceived += bytes;
  if (latencyMs !== undefined) {
    latencySamples.push(latencyMs);
    if (latencySamples.length > 1000) {
      latencySamples = latencySamples.slice(-500);
    }
    const sum = latencySamples.reduce((a, b) => a + b, 0);
    metrics.averageLatencyMs = sum / latencySamples.length;
    metrics.peakLatencyMs = Math.max(metrics.peakLatencyMs ?? 0, latencyMs);
  }
}

export function getTransportMetrics(): Readonly<TransportMetrics> {
  return { ...metrics };
}

export function resetTransportMetrics(): void {
  metrics = {
    connectionAttempts: 0,
    successfulConnections: 0,
    disconnects: 0,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    messagesReceived: 0,
    bytesReceived: 0,
    averageLatencyMs: null,
    peakLatencyMs: null,
  };
  latencySamples = [];
}
