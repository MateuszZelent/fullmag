"use client";

import { memo, useMemo } from "react";
import { useSessionRuntimeStore } from "@/features/session-runtime/store/useSessionRuntimeStore";
import { cn } from "@/lib/utils";

/**
 * Production-safe compact status badges for the control room.
 *
 * Shows key data-plane info inline: solver status/step, mesh generation,
 * field staleness, and chart history coverage.
 *
 * See: FE-005 in fullmag-fem-regression-p6-frontend-hardening.mdx
 */
export const DataPlaneStatusBadges = memo(function DataPlaneStatusBadges() {
  const liveState = useSessionRuntimeStore((s) => s.liveState);
  const stepUpdateV2 = useSessionRuntimeStore((s) => s.stepUpdateV2);
  const femMesh = useSessionRuntimeStore((s) => s.femMesh);
  const isFemBackend = useSessionRuntimeStore((s) => s.isFemBackend);
  const connection = useSessionRuntimeStore((s) => s.connection);
  const scalarRows = useSessionRuntimeStore((s) => s.scalarRows);

  const badges = useMemo(() => {
    const b: Badge[] = [];

    // Connection
    if (connection !== "connected") {
      b.push({ label: connection, variant: connection === "connecting" ? "warn" : "error" });
    }

    // Solver step
    const step = stepUpdateV2?.diagnostics?.step ?? liveState?.step;
    const finished = stepUpdateV2?.finished ?? liveState?.finished;
    if (step != null) {
      b.push({
        label: `step ${step}`,
        variant: finished ? "muted" : "default",
      });
    }

    // Backend type
    b.push({ label: isFemBackend ? "FEM" : "FDM", variant: "muted" });

    // FEM mesh generation
    if (isFemBackend && femMesh) {
      const genId = femMesh.generation_id ?? femMesh.mesh_id;
      if (genId) {
        b.push({ label: `mesh ${genId.slice(0, 6)}`, variant: "muted" });
      }
    }

    // Chart rows
    if (scalarRows.length > 0) {
      b.push({ label: `${scalarRows.length} rows`, variant: "muted" });
    }

    // Finished
    if (finished) {
      b.push({ label: "finished", variant: "default" });
    }

    return b;
  }, [connection, liveState, stepUpdateV2, femMesh, isFemBackend, scalarRows.length]);

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {badges.map((badge, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center rounded-md px-1.5 py-0.5 text-[0.6rem] font-medium leading-none",
            badge.variant === "error" && "bg-destructive/15 text-destructive",
            badge.variant === "warn" && "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
            badge.variant === "default" && "bg-primary/10 text-primary",
            badge.variant === "muted" && "bg-muted text-muted-foreground",
          )}
        >
          {badge.label}
        </span>
      ))}
    </div>
  );
});

interface Badge {
  label: string;
  variant: "default" | "muted" | "warn" | "error";
}
