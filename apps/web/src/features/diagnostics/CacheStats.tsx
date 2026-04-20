"use client";

import { useMemo } from "react";

import { readCacheStats } from "./DiagnosticStore";

export function CacheStats() {
  const stats = useMemo(() => readCacheStats(), []);

  return (
    <div className="rounded-lg border border-border/40 bg-background/70 p-3 text-xs">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Cache Stats
      </div>
      <div>Entries: {stats.entryCount}</div>
      <div>Bytes: {stats.totalBytes}</div>
      <div>Limit: {stats.maxBytes}</div>
      <div>Utilization: {(stats.utilization * 100).toFixed(1)}%</div>
    </div>
  );
}
