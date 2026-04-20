"use client";

import { CacheStats } from "./CacheStats";
import { RequestLog } from "./RequestLog";

export function DiagnosticPanel() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <CacheStats />
      <RequestLog />
    </div>
  );
}
