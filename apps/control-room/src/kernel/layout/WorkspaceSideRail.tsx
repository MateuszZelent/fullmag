"use client";

import {
  Activity,
  Box,
  Database,
  FileCheck,
  GitBranch,
  Gauge,
  History,
  LayoutGrid,
  Move3d,
  PanelRight,
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
  useInspectorTabs,
} from "@/modules/inspector/public";
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
  const inspectorTab = useInspectorActiveTab();
  const inspectorTabs = useInspectorTabs();
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
        return { active, icon, id, label, onSelect: choose(active, () => setExplorerActiveTab(id)) };
      })
    : inspectorTabs.length > 0
      ? inspectorTabs.map(({ id, label }) => {
          const active = inspectorTab === id;
          return {
            active,
            icon: INSPECTOR_TAB_ICONS[id] ?? SlidersHorizontal,
            id,
            label,
            onSelect: choose(active, () => setInspectorActiveTab(id)),
          };
        })
      : [{ active: true, icon: PanelRight, id: "inspector", label: "Inspector", onSelect: choose(true, () => undefined) }];

  return (
    <nav
      aria-label={side === "left" ? "Model builder panels" : "Inspector panels"}
      className="fm-side-rail"
      data-open={open}
      data-side={side}
    >
      {items.map(({ active, icon: Icon, id, label, onSelect }) => (
        <button
          aria-label={label}
          aria-pressed={open && active}
          className="fm-side-rail__item"
          data-rail-item={id}
          key={id}
          title={label}
          type="button"
          onClick={onSelect}
        >
          <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
        </button>
      ))}
    </nav>
  );
}
