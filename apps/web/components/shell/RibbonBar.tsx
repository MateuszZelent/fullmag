"use client";

import {
  FileText, Play, Pause, Square, Box, Columns2, Grid3X3,
  PanelRight, Camera, Download, BarChart3,
  Shapes, FlaskConical, Hexagon, Cog, Eye,
} from "lucide-react";
import {
  Tooltip, TooltipTrigger, TooltipContent, TooltipProvider,
} from "@/components/ui/tooltip";
import s from "./shell.module.css";

/* ── Types ──────────────────────────────────────── */

interface RibbonAction {
  id: string;
  icon: React.ReactNode;
  label: string;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
  action?: () => void;
}

interface RibbonGroup {
  id: string;
  title: string;
  actions: RibbonAction[];
}

interface RibbonBarProps {
  viewMode?: string;
  isFemBackend?: boolean;
  solverRunning?: boolean;
  sidebarVisible?: boolean;
  onViewChange?: (mode: string) => void;
  onSidebarToggle?: () => void;
  onSimAction?: (action: string) => void;
  onExport?: () => void;
}

function buildGroups(props: RibbonBarProps): RibbonGroup[] {
  return [
    {
      id: "script",
      title: "Script",
      actions: [
        { id: "open", icon: <FileText size={20} />, label: "Open", tooltip: "Open script file", shortcut: "Ctrl+O" },
        { id: "run", icon: <Play size={20} />, label: "Run", tooltip: "Run simulation", shortcut: "F5", accent: true, action: () => props.onSimAction?.("run") },
      ],
    },
    {
      id: "model",
      title: "Model",
      actions: [
        { id: "geometry", icon: <Shapes size={20} />, label: "Geometry", tooltip: "Define geometry" },
        { id: "material", icon: <FlaskConical size={20} />, label: "Material", tooltip: "Material properties" },
        { id: "mesh", icon: <Hexagon size={20} />, label: "Mesh", tooltip: "Mesh controls", active: props.viewMode === "Mesh", disabled: !props.isFemBackend, action: () => props.onViewChange?.("Mesh") },
      ],
    },
    {
      id: "solver",
      title: "Solver",
      actions: [
        { id: "configure", icon: <Cog size={20} />, label: "Setup", tooltip: "Solver configuration" },
        { id: "solve", icon: <Play size={20} />, label: "Solve", tooltip: "Start solver", accent: true, action: () => props.onSimAction?.("run") },
        { id: "pause", icon: <Pause size={20} />, label: "Pause", tooltip: "Pause solver", disabled: !props.solverRunning, action: () => props.onSimAction?.("pause") },
        { id: "stop", icon: <Square size={20} />, label: "Stop", tooltip: "Stop solver", disabled: !props.solverRunning, action: () => props.onSimAction?.("stop") },
      ],
    },
    {
      id: "results",
      title: "Results",
      actions: [
        { id: "plot", icon: <BarChart3 size={20} />, label: "Plot", tooltip: "Open scalar plot" },
        { id: "snapshot", icon: <Camera size={20} />, label: "Capture", tooltip: "Take snapshot" },
        { id: "exportvtk", icon: <Download size={20} />, label: "Export", tooltip: "Export VTK", action: props.onExport },
      ],
    },
    {
      id: "view",
      title: "View",
      actions: [
        { id: "3d", icon: <Box size={20} />, label: "3D", tooltip: "3D view", shortcut: "1", active: props.viewMode === "3D", action: () => props.onViewChange?.("3D") },
        { id: "2d", icon: <Columns2 size={20} />, label: "2D", tooltip: "2D view", shortcut: "2", active: props.viewMode === "2D", action: () => props.onViewChange?.("2D") },
        { id: "mesh-view", icon: <Grid3X3 size={20} />, label: "Mesh", tooltip: "Mesh view", shortcut: "3", active: props.viewMode === "Mesh", disabled: !props.isFemBackend, action: () => props.onViewChange?.("Mesh") },
        { id: "sidebar", icon: <PanelRight size={20} />, label: "Panel", tooltip: "Toggle sidebar", shortcut: "Ctrl+B", active: props.sidebarVisible, action: props.onSidebarToggle },
        { id: "eye", icon: <Eye size={20} />, label: "Focus", tooltip: "Focus mode" },
      ],
    },
  ];
}

/* ── Component ──────────────────────────────────── */

export default function RibbonBar(props: RibbonBarProps) {
  const groups = buildGroups(props);

  return (
    <TooltipProvider delayDuration={200}>
      <div className={s.ribbonBar}>
        {groups.map((group, gi) => (
          <div key={group.id} className={s.ribbonGroup}>
            {gi > 0 && <div className={s.ribbonSep} />}
            <div className={s.ribbonGroupInner}>
              <div className={s.ribbonActions}>
                {group.actions.map((action) => (
                  <Tooltip key={action.id}>
                    <TooltipTrigger asChild>
                      <button
                        className={s.ribbonBtn}
                        data-active={action.active ?? false}
                        data-accent={action.accent ?? false}
                        disabled={action.disabled}
                        onClick={action.action}
                      >
                        <span className={s.ribbonIcon}>{action.icon}</span>
                        <span className={s.ribbonLabel}>{action.label}</span>
                      </button>
                    </TooltipTrigger>
                    {action.tooltip && (
                      <TooltipContent side="bottom" className={s.ribbonTooltip}>
                        <span className={s.ribbonTooltipText}>{action.tooltip}</span>
                        {action.shortcut && (
                          <kbd className={s.ribbonTooltipKbd}>{action.shortcut}</kbd>
                        )}
                      </TooltipContent>
                    )}
                  </Tooltip>
                ))}
              </div>
              <span className={s.ribbonGroupTitle}>{group.title}</span>
            </div>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
