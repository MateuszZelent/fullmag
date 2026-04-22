"use client";

/**
 * P3 — Geometry Builder Overview Inspector
 *
 * Shown when no primitive is selected in the builder.
 * Displays quick-create buttons, builder status, build actions, and
 * keyboard shortcuts.
 */

import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Keyboard,
  Info,
  Layers,
  Grid3x3,
  Maximize2,
  AlertTriangle,
} from "lucide-react";
import { useCallback } from "react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { PrimitiveKind } from "../model/types";
import { useCommand, useModel } from "@/components/runs/control-room/context-hooks";
import { resolveFemDiscretization } from "@/src/domain/capabilities";

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
  const command = useCommand();
  const model = useModel();
  const addPrimitive = useGeometryBuilderStore((s) => s.addPrimitive);
  const primitiveCount = useGeometryBuilderStore((s) => s.getAllPrimitives().length);
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const isRunBlocked = useGeometryBuilderStore((s) => s.isRunBlocked());
  const runBlockedReason = useGeometryBuilderStore((s) => s.getRunBlockedReason());
  const geometryBuildBlockedReason = useGeometryBuilderStore((s) =>
    s.getGeometryBuildBlockedReason(),
  );
  const geometryRealization = useGeometryBuilderStore((s) => s.geometryRealization);
  const buildGeometry = useGeometryBuilderStore((s) => s.buildGeometry);
  const buildMesh = useGeometryBuilderStore((s) => s.buildMesh);
  const fitUniverseToObjects = useGeometryBuilderStore((s) => s.fitUniverseToObjects);
  const validateAll = useGeometryBuilderStore((s) => s.validateAll);
  const femDiscretization = resolveFemDiscretization(
    command.domainCapabilities,
    command.isFemBackend,
  );
  const meshGenerating = model.meshGenerating;

  const validations = validateAll();
  const hasOutsideBounds = validations.some((v) => v.intersectsUniverseBoundary || v.exceedsUniverse);

  // Build Geometry: enabled when geometry is dirty and store policy allows build
  const canBuildGeometry =
    (dirty.geometryDraftDirty || dirty.geometryRealizationDirty) &&
    !geometryBuildBlockedReason;
  // Build Mesh: enabled when realization is present and mesh is out of date
  const canBuildMesh =
    geometryRealization !== null &&
    dirty.meshDirty &&
    !dirty.geometryRealizationDirty &&
    !meshGenerating;
  // Fit Universe: enabled when objects cross or exceed universe bounds
  const canFitUniverse = hasOutsideBounds && primitiveCount > 0;

  const handleBuildMesh = useCallback(() => {
    buildMesh();
    if (femDiscretization) {
      void model.handleStudyDomainMeshGenerate("geometry_builder_build_mesh");
    }
  }, [buildMesh, femDiscretization, model]);

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

      {/* ── Build Actions ─────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
          Build
        </h3>
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={!canBuildGeometry}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/30"
            onClick={buildGeometry}
          >
            <Layers size={13} />
            Build Geometry
            {dirty.geometryDraftDirty && (
              <span className="ml-auto text-[9px] font-normal text-emerald-400/70">● modified</span>
            )}
          </button>

          <button
            type="button"
            disabled={!canBuildMesh}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 border border-cyan-500/30"
            onClick={handleBuildMesh}
          >
            <Grid3x3 size={13} />
            {meshGenerating ? "Queueing Mesh Build…" : "Build Mesh"}
            {dirty.meshDirty && geometryRealization && (
              <span className="ml-auto text-[9px] font-normal text-cyan-400/70">● out of date</span>
            )}
          </button>

          {canFitUniverse && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 border border-amber-500/30"
              onClick={() => fitUniverseToObjects()}
            >
              <Maximize2 size={13} />
              Fit Universe
              <span className="ml-auto text-[9px] font-normal text-amber-400/70">
                {validations.filter((v) => v.intersectsUniverseBoundary || v.exceedsUniverse).length} outside
              </span>
            </button>
          )}
        </div>

        {/* Build status messages */}
        {!canBuildGeometry && !dirty.geometryDraftDirty && !dirty.geometryRealizationDirty && (
          <p className="text-[10px] text-muted-foreground">
            {geometryRealization ? "Geometry is up to date." : "Geometry not built. Click Build Geometry first."}
          </p>
        )}
        {geometryBuildBlockedReason && (
          <div className="flex items-start gap-1.5 text-[10px] text-red-400">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{geometryBuildBlockedReason}</span>
          </div>
        )}
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
