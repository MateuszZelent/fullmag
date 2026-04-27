"use client";

import { memo } from "react";
import {
  Box,
  ScanLine,
  BarChart3,
  Activity,
  Cpu,
  ChevronDown,
  Boxes,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useViewport } from "./context-hooks";
import type { ViewportMode } from "./shared";

/* ── Tab definition ──────────────────────────────── */

interface CenterTab {
  id: string;
  label: string;
  icon: React.ReactNode;
  mode: ViewportMode | null;   // null = future/unimplemented tab
  disabled?: boolean;
  hidden?: boolean;
}

const CENTER_TABS: CenterTab[] = [
  { id: "3d-view",      label: "3D View",    icon: <Box size={12} />,     mode: "3D" },
  { id: "2d-slice",     label: "2D Slice",   icon: <ScanLine size={12} />, mode: "2D" },
  { id: "analysis",     label: "Analysis",   icon: <BarChart3 size={12} />, mode: "Analyze" },
  { id: "charts",       label: "Charts",     icon: <Activity size={12} />, mode: null, disabled: true },
  { id: "diagnostics",  label: "Diagnostics",icon: <Cpu size={12} />,      mode: null, disabled: true },
];

function viewModeToTabId(mode: ViewportMode): string {
  switch (mode) {
    case "3D":      return "3d-view";
    case "2D":      return "2d-slice";
    case "Mesh":    return "3d-view";
    case "Analyze": return "analysis";
    default:        return "3d-view";
  }
}

/* ── Quantity selector (inline, compact) ─────────── */

interface QuantitySelectorProps {
  targets: Array<{ id: string; shortLabel: string; available: boolean }>;
  selected: string;
  onSelect: (id: string) => void;
}

function QuantitySelector({ targets, selected, onSelect }: QuantitySelectorProps) {
  if (targets.length === 0) return null;
  const current = targets.find((t) => t.id === selected) ?? targets[0];
  return (
    <div className="relative group">
      <button
        type="button"
        className="flex items-center gap-1 rounded border border-border/30 bg-background/40 px-2 py-1 text-[0.65rem] font-medium text-muted-foreground transition-colors hover:border-border/60 hover:bg-muted/40 hover:text-foreground"
      >
        <Boxes size={11} className="opacity-60" />
        <span className="max-w-[90px] truncate">{current?.shortLabel ?? selected}</span>
        <ChevronDown size={9} className="opacity-60" />
      </button>
      <div className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden min-w-[180px] rounded border border-border/50 bg-popover/95 p-1 shadow-md backdrop-blur-xl group-focus-within:pointer-events-auto group-focus-within:block">
        {targets.map((t) => (
          <button
            key={t.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
              t.id === selected ? "bg-primary/10 text-primary" : "text-muted-foreground",
            )}
            disabled={!t.available}
            onClick={() => onSelect(t.id)}
          >
            <span
              className={cn(
                "inline-flex h-1.5 w-1.5 rounded-full flex-shrink-0",
                t.available ? "bg-emerald-400" : "bg-zinc-600",
              )}
            />
            {t.shortLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── ViewportTabBar ──────────────────────────────── */

export const ViewportTabBar = memo(function ViewportTabBar() {
  const viewport = useViewport();
  const effectiveViewMode = viewport.effectiveViewMode === "Mesh" ? "3D" : viewport.effectiveViewMode;

  const activeTabId = viewModeToTabId(effectiveViewMode);

  const handleTabClick = (tab: CenterTab) => {
    if (tab.disabled || tab.mode === null) return;
    viewport.handleViewModeChange(tab.mode);
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900/80 px-3 backdrop-blur-sm">
      {/* ── Viewport mode tabs ── */}
      <div className="flex items-center gap-0.5">
        {CENTER_TABS.filter((t) => !t.hidden).map((tab) => {
          const isActive = tab.id === activeTabId && tab.mode !== null;
          return (
            <button
              key={tab.id}
              type="button"
              disabled={tab.disabled}
              onClick={() => handleTabClick(tab)}
              className={cn(
                "flex items-center gap-1.5 rounded px-2.5 py-1 text-[0.7rem] font-medium uppercase tracking-wide transition-all",
                isActive
                  ? "bg-indigo-500/10 text-indigo-300"
                  : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
                tab.disabled && "cursor-not-allowed opacity-30",
              )}
            >
              <span className={cn(isActive ? "text-indigo-400" : "text-zinc-500")}>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Quantity selector (visible in 3D and Mesh modes) ── */}
      {effectiveViewMode === "3D" &&
      viewport.quickPreviewTargets.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            Quantity
          </span>
          <QuantitySelector
            targets={viewport.quickPreviewTargets}
            selected={viewport.requestedPreviewQuantity}
            onSelect={(id) => viewport.requestPreviewQuantity(id)}
          />
        </div>
      ) : null}
    </div>
  );
});
