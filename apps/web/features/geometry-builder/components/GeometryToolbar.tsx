"use client";

/**
 * P3 — Geometry Viewport Toolbar
 *
 * Compact Q/W/E/R tool mode switcher rendered as a floating horizontal
 * bar over the 3D viewport when the geometry builder is active.
 *
 * The toolbar only sets `viewportTool` in the builder store; it never
 * modifies geometry directly.
 *
 * Usage (absolute positioned in a relative viewport container):
 *
 *   <div className="relative">
 *     <ThreeCanvas ... />
 *     <GeometryToolbar className="absolute bottom-4 left-1/2 -translate-x-1/2" />
 *   </div>
 */

import { Camera, Hand, Move, RotateCcw, Maximize2 } from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { GeometryViewportTool } from "../model/types";
import { cn } from "@/lib/utils";

// ── Tool definitions ──────────────────────────────────────────

interface ToolDef {
  tool: GeometryViewportTool;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
}

const TOOLS: ToolDef[] = [
  { tool: "camera", label: "Camera", shortcut: "Q", icon: <Camera size={14} /> },
  { tool: "select", label: "Select", shortcut: "S", icon: <Hand size={14} /> },
  { tool: "move", label: "Move", shortcut: "W", icon: <Move size={14} /> },
  { tool: "rotate", label: "Rotate", shortcut: "E", icon: <RotateCcw size={14} /> },
  { tool: "scale", label: "Scale", shortcut: "R", icon: <Maximize2 size={14} /> },
];

// ── Component ─────────────────────────────────────────────────

interface GeometryToolbarProps {
  className?: string;
}

export function GeometryToolbar({ className }: GeometryToolbarProps) {
  const builderActive = useGeometryBuilderStore((s) => s.builderMode.enabled);
  const currentTool = useGeometryBuilderStore((s) => s.viewportTool);
  const setViewportTool = useGeometryBuilderStore((s) => s.setViewportTool);

  if (!builderActive) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-lg border border-border/50 bg-background/90 p-1 shadow-lg backdrop-blur-sm",
        className,
      )}
      role="toolbar"
      aria-label="Geometry viewport tools"
    >
      {TOOLS.map(({ tool, label, shortcut, icon }) => {
        const active = currentTool === tool;
        return (
          <button
            key={tool}
            type="button"
            title={`${label} (${shortcut})`}
            aria-pressed={active}
            aria-label={label}
            className={cn(
              "flex h-7 min-w-[2.25rem] items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
              active
                ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
            onClick={() => setViewportTool(tool)}
          >
            {icon}
            <span className="hidden sm:inline">{shortcut}</span>
          </button>
        );
      })}
    </div>
  );
}
