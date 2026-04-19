"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import { cn } from "@/lib/utils";

type IndicatorTone = "ok" | "warn" | "error";

export const DataPlaneCornerIndicator = memo(function DataPlaneCornerIndicator({
  lastDataTimestamp,
  label = "Backend refreshed",
}: {
  lastDataTimestamp?: number | null;
  label?: string;
}) {
  const connection = useSessionRuntimeStore((s) => s.connection);
  const liveState = useSessionRuntimeStore((s) => s.liveState);
  const stepUpdateV2 = useSessionRuntimeStore((s) => s.stepUpdateV2);
  const isFemBackend = useSessionRuntimeStore((s) => s.isFemBackend);
  const femMesh = useSessionRuntimeStore((s) => s.femMesh);
  const lastUpdateTimestamp = useSessionRuntimeStore((s) => s.lastUpdateTimestamp);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  const indicator = useMemo(() => {
    const step = stepUpdateV2?.diagnostics?.step ?? liveState?.step ?? null;
    const meshGen = isFemBackend ? femMesh?.generation_id ?? femMesh?.mesh_id ?? null : null;
    const effectiveTimestamp = lastDataTimestamp ?? lastUpdateTimestamp;
    const ageMs = effectiveTimestamp != null ? Math.max(0, now - effectiveTimestamp) : null;
    const ageLabel =
      ageMs == null
        ? "waiting for backend"
        : ageMs < 1000
          ? `${ageMs} ms ago`
          : `${(ageMs / 1000).toFixed(ageMs < 10_000 ? 1 : 0)} s ago`;

    if (connection === "disconnected") {
      return {
        label: "Backend offline",
        detail: step != null ? `last step ${step} • ${ageLabel}` : ageLabel,
        tone: "error" as IndicatorTone,
      };
    }
    if (connection === "connecting") {
      return {
        label: "Backend syncing",
        detail: step != null ? `step ${step} • ${ageLabel}` : ageLabel,
        tone: "warn" as IndicatorTone,
      };
    }
    const tone: IndicatorTone =
      ageMs == null
        ? "warn"
        : ageMs < 1500
          ? "ok"
          : ageMs < 5000
            ? "warn"
            : "error";
    return {
      label,
      detail:
        meshGen != null && step != null
          ? `${ageLabel} • step ${step} • mesh ${String(meshGen).slice(0, 6)}`
          : step != null
            ? `${ageLabel} • step ${step}`
            : ageLabel,
      tone,
    };
  }, [
    connection,
    femMesh?.generation_id,
    femMesh?.mesh_id,
    isFemBackend,
    label,
    lastDataTimestamp,
    lastUpdateTimestamp,
    liveState?.step,
    now,
    stepUpdateV2?.diagnostics?.step,
  ]);

  return (
    <div className="pointer-events-none rounded-full border border-border/35 bg-background/85 px-3 py-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.35)] backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            indicator.tone === "ok" && "bg-emerald-400 shadow-[0_0_10px_rgba(74,222,128,0.65)]",
            indicator.tone === "warn" && "bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.55)]",
            indicator.tone === "error" && "bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.55)]",
          )}
        />
        <div className="flex min-w-0 flex-col">
          <span className="text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-foreground">
            {indicator.label}
          </span>
          <span className="text-[0.58rem] text-muted-foreground">
            {indicator.detail}
          </span>
        </div>
      </div>
    </div>
  );
});
