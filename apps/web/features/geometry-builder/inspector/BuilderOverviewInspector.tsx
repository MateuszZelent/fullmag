"use client";

/**
 * P3 — Geometry Builder Overview Inspector
 *
 * Shown when no primitive is selected in the builder.
 * Displays quick-create buttons, builder status, and keyboard shortcuts.
 */

import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Keyboard,
  Info,
} from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { PrimitiveKind } from "../model/types";

const QUICK_CREATE: Array<{
  kind: PrimitiveKind;
  label: string;
  icon: React.ReactNode;
  color: string;
}> = [
  { kind: "box", label: "Box", icon: <Box size={18} />, color: "text-emerald-400" },
  { kind: "cylinder", label: "Cylinder", icon: <Cylinder size={18} />, color: "text-cyan-400" },
  { kind: "sphere", label: "Sphere", icon: <Circle size={18} />, color: "text-violet-400" },
  { kind: "disk", label: "Disk", icon: <Disc size={18} />, color: "text-sky-400" },
  { kind: "triangular_prism", label: "Triangle", icon: <Triangle size={18} />, color: "text-amber-400" },
];

const SHORTCUTS = [
  { key: "Q", action: "Camera mode" },
  { key: "W", action: "Move tool" },
  { key: "E", action: "Rotate tool" },
  { key: "R", action: "Scale tool" },
  { key: "F", action: "Focus selected" },
  { key: "Shift+F", action: "Frame all" },
  { key: "G", action: "Toggle snap" },
  { key: "Del", action: "Delete selected" },
  { key: "Ctrl+D", action: "Duplicate" },
  { key: "Esc", action: "Cancel manipulation" },
  { key: "Ctrl+Z", action: "Undo" },
  { key: "Ctrl+Shift+Z", action: "Redo" },
];

export default function BuilderOverviewInspector() {
  const addPrimitive = useGeometryBuilderStore((s) => s.addPrimitive);
  const primitiveCount = useGeometryBuilderStore((s) => s.getAllPrimitives().length);
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const isRunBlocked = useGeometryBuilderStore((s) => s.isRunBlocked());
  const runBlockedReason = useGeometryBuilderStore((s) => s.getRunBlockedReason());

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      {/* ── Quick Create ─────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Create Primitive
        </h3>
        <div className="grid grid-cols-2 gap-1.5">
          {QUICK_CREATE.map(({ kind, label, icon, color }) => (
            <button
              key={kind}
              type="button"
              className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-muted/50 hover:bg-muted border border-border/50 hover:border-border transition-colors"
              onClick={() => addPrimitive(kind)}
            >
              <span className={color}>{icon}</span>
              <span className="text-xs text-foreground">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Status ───────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Builder Status
        </h3>
        <div className="text-xs text-muted-foreground space-y-1.5">
          <div className="flex items-center justify-between">
            <span>Primitives</span>
            <span className="font-mono">{primitiveCount}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Geometry</span>
            <span className={dirty.geometryDraftDirty ? "text-amber-400" : "text-emerald-400"}>
              {dirty.geometryDraftDirty ? "⚠ modified" : "✓ clean"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Mesh</span>
            <span className={dirty.meshDirty ? "text-amber-400" : "text-emerald-400"}>
              {dirty.meshDirty ? "⚠ out of date" : "✓ current"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>Solver</span>
            <span className={isRunBlocked ? "text-red-400" : "text-emerald-400"}>
              {isRunBlocked ? "✗ blocked" : "✓ ready"}
            </span>
          </div>
          {runBlockedReason && (
            <div className="flex items-start gap-1.5 text-[10px] text-amber-400 mt-1">
              <Info size={12} className="shrink-0 mt-0.5" />
              <span>{runBlockedReason}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Shortcuts ────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1 flex items-center gap-1.5">
          <Keyboard size={12} />
          Shortcuts
        </h3>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
          {SHORTCUTS.map(({ key, action }) => (
            <div key={key} className="flex items-center gap-2">
              <kbd className="inline-flex items-center px-1.5 py-0.5 rounded bg-muted font-mono text-[9px] text-muted-foreground border border-border/50">
                {key}
              </kbd>
              <span className="text-muted-foreground">{action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
