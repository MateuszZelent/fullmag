"use client";

import React from "react";
import { cn } from "@/lib/utils";
import type { ContextualTabId } from "@/features/shell/registry/ribbonRegistry";

/* ── Types ───────────────────────────────────────── */

export interface ContextualRibbonTab {
  id: ContextualTabId;
  label: string;
}

export interface RibbonTabStripProps {
  visibleTabs: string[];
  activeTab: string;
  onTabClick: (tab: string) => void;
  contextualTabs: ContextualRibbonTab[];
  activeContextualTabId: string | null;
  onContextualTabClick: (tabId: ContextualTabId) => void;
  meshGenerating?: boolean;
  meshConfigDirty?: boolean;
}

/* ── Component ───────────────────────────────────── */

export function RibbonTabStrip({
  visibleTabs,
  activeTab,
  onTabClick,
  contextualTabs,
  activeContextualTabId,
  onContextualTabClick,
  meshGenerating,
  meshConfigDirty,
}: RibbonTabStripProps) {
  return (
    <div className="flex items-end px-2 pt-1.5 gap-0.5 border-b border-border/30 bg-card/40">
      {visibleTabs.map((tab) => {
        const isActive = String(tab) === String(activeTab);
        return (
          <button
            key={tab}
            type="button"
            onClick={() => onTabClick(tab)}
            className={cn(
              "relative px-3.5 py-1.5 text-[0.75rem] font-medium uppercase tracking-wide transition-colors cursor-pointer rounded-t-sm",
              isActive
                ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-primary after:rounded-t"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            {tab}
          </button>
        );
      })}

      {contextualTabs.length > 0 ? (
        <div className="ml-auto mb-1 flex items-center gap-1 pl-4">
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Context
          </span>
          {contextualTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={cn(
                "rounded border px-2 py-0.5 text-[0.63rem] font-medium uppercase tracking-wide transition-colors",
                activeContextualTabId === tab.id
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border/50 bg-card/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => onContextualTabClick(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === "Mesh" && (
        <div
          className={cn(
            "mb-1 flex items-center gap-2 pl-4",
            contextualTabs.length > 0 ? "border-l border-border/40 ml-1" : "ml-auto",
          )}
        >
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Mesh Status
          </span>
          <span
            className={cn(
              "rounded border px-2 py-0.5 text-[0.68rem] font-medium",
              meshGenerating
                ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
                : meshConfigDirty
                  ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                  : "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
            )}
          >
            {meshGenerating ? "Building" : meshConfigDirty ? "Out of date" : "Up to date"}
          </span>
          <span className="text-[0.68rem] text-muted-foreground">
            {meshGenerating
              ? "Live meshing progress."
              : meshConfigDirty
                ? "Viewport shows the last built mesh."
                : "Viewport reflects the latest built mesh."}
          </span>
        </div>
      )}
    </div>
  );
}
