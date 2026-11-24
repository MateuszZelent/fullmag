"use client";

import {
  Activity,
  Box,
  Database,
  Download,
  FileCheck,
  GitBranch,
  Gauge,
  History,
  LayoutGrid,
  Move3d,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import {
  EXPLORER_TABS,
  setExplorerActiveTab,
  useExplorerStoreSelector,
} from "@/modules/explorer/public";
import {
  setInspectorActiveTab,
  useInspectorActiveTab,
  useInspectorStagedDirtyCount,
  useInspectorTabs,
} from "@/modules/inspector/public";
import {
  setViewport3DInspectorContext,
  useViewport3DInspectorContext,
} from "@/modules/viewport-3d/public";
import { useSessionErrorCount } from "../diagnostics/sessionErrorStore";
import { useKernel } from "../KernelContext";
import { useLayoutSelector } from "./useLayout";

const INSPECTOR_TAB_ICONS: Record<string, LucideIcon> = {
  data: Database,
  diagnostics: Activity,
  evidence: FileCheck,
  geometry: Box,
  history: History,
  overview: LayoutGrid,
  placement: Move3d,
  policy: ShieldCheck,
  properties: SlidersHorizontal,
  provenance: GitBranch,
  quality: Gauge,
};

interface RailItem {
  active: boolean;
  dirtyCount?: number;
  errorCount?: number;
  icon: LucideIcon;
  id: string;
  label: string;
  onSelect: () => void;
}

/**
 * Side rails (specs/frontend-v2/10 §1a): the left rail switches Model builder
 * families and the right rail switches Inspector tabs. Choosing the open item
 * again collapses its panel; any item reopens a collapsed panel.
 */
export function WorkspaceSideRail({ side }: { side: "left" | "right" }) {
  const kernel = useKernel();
  const panelVisible = useLayoutSelector((layout) => layout.panelVisible);
  const explorerTab = useExplorerStoreSelector((explorer) => explorer.activeTab);
  const sessionErrorCount = useSessionErrorCount();
  const inspectorTab = useInspectorActiveTab();
  const inspectorTabs = useInspectorTabs();
  const stagedDirtyCount = useInspectorStagedDirtyCount();
  const inspectorContext = useViewport3DInspectorContext();
  const open = side === "left" ? panelVisible.left : panelVisible.right;
  const setOpen = (visible: boolean) =>
    kernel.layout.setPanelVisible(side === "left" ? "left" : "right", visible);
  const choose = (active: boolean, select: () => void) => () => {
    if (open && active) {
      setOpen(false);
      return;
    }
    select();
    if (!open) setOpen(true);
  };

  const items: RailItem[] = side === "left"
    ? EXPLORER_TABS.map(({ icon, id, label }) => {
        const active = explorerTab === id;
        return {
          active,
          errorCount: id === "errors" && sessionErrorCount > 0 ? sessionErrorCount : undefined,
          icon,
          id,
          label,
          onSelect: choose(active, () => setExplorerActiveTab(id)),
        };
      })
    : [
        {
          active: inspectorContext === "selection",
          dirtyCount: stagedDirtyCount > 0 ? stagedDirtyCount : undefined,
          icon: Box,
          id: "selection",
          label: "Selection",
          onSelect: choose(inspectorContext === "selection", () => setViewport3DInspectorContext("selection")),
        },
        {
          active: inspectorContext === "view",
          icon: SlidersHorizontal,
          id: "view",
          label: "3D View",
          onSelect: choose(inspectorContext === "view", () => setViewport3DInspectorContext("view")),
        },
        {
          active: inspectorContext === "export",
          icon: Download,
          id: "export",
          label: "Export",
          onSelect: choose(inspectorContext === "export", () => setViewport3DInspectorContext("export")),
        },
        // The selected object's Inspector tabs follow the top-level contexts.
        ...(inspectorContext === "selection" ? inspectorTabs : []).map(({ id, label }) => {
          const active = inspectorTab === id;
          return {
            active,
            icon: INSPECTOR_TAB_ICONS[id] ?? LayoutGrid,
            id: `tab:${id}`,
            label,
            onSelect: choose(active, () => setInspectorActiveTab(id)),
          };
        }),
      ];

  return (
    <nav
      aria-label={side === "left" ? "Model builder panels" : "Inspector panels"}
      className="fm-side-rail"
      data-open={open}
      data-side={side}
    >
      {items.map(({ active, dirtyCount, errorCount, icon: Icon, id, label, onSelect }, index) => {
        const accessibleLabel = dirtyCount
          ? `${label} (${dirtyCount} unapplied ${dirtyCount === 1 ? "change" : "changes"})`
          : errorCount
            ? `${label} (${errorCount} ${errorCount === 1 ? "error" : "errors"} recorded)`
            : label;
        return (
          <button
            // The first item is where focus lands when its panel is hidden.
            data-restore-panel={index === 0 ? (side === "left" ? "panel-left" : "panel-right") : undefined}
            aria-label={accessibleLabel}
            aria-pressed={open && active}
            className="fm-side-rail__item"
            data-active={active}
            data-dirty-fields-count={dirtyCount}
            data-error-count={errorCount}
            data-rail-item={id}
            key={id}
            title={accessibleLabel}
            type="button"
            onClick={onSelect}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
            {dirtyCount ? (
              <span aria-hidden="true" className="fm-side-rail__dirty-dot" />
            ) : null}
            {errorCount ? (
              <span aria-hidden="true" className="fm-side-rail__error-badge">
                {errorCount > 99 ? "99+" : errorCount}
              </span>
            ) : null}
            <span className="sr-only">{accessibleLabel}</span>
          </button>
        );
      })}
    </nav>
  );
}
