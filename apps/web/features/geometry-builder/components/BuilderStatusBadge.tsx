"use client";

/**
 * P6 — Builder Status Badge
 *
 * Compact status indicator for the geometry builder that can be
 * placed in the status bar or ribbon.
 */

import { AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";

export function BuilderStatusBadge() {
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const isRunBlocked = useGeometryBuilderStore((s) => s.isRunBlocked());
  const reason = useGeometryBuilderStore((s) => s.getRunBlockedReason());

  if (!builderActive) return null;

  const isDirty = dirty.geometryDraftDirty || dirty.geometryRealizationDirty || dirty.meshDirty;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-medium rounded"
      title={reason ?? "Builder ready"}
    >
      {isRunBlocked ? (
        <>
          <AlertTriangle size={10} className="text-amber-400" />
          <span className="text-amber-400">Builder: blocked</span>
        </>
      ) : isDirty ? (
        <>
          <Loader2 size={10} className="text-sky-400 animate-spin" />
          <span className="text-sky-400">Builder: modified</span>
        </>
      ) : (
        <>
          <CheckCircle size={10} className="text-emerald-400" />
          <span className="text-emerald-400">Builder: ready</span>
        </>
      )}
    </div>
  );
}
