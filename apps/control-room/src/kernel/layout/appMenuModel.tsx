import {
  BookOpen,
  Box,
  Braces,
  Command,
  Cpu,
  FileCode2,
  FilePlus2,
  Gauge,
  HelpCircle,
  Info,
  LayoutDashboard,
  ListChecks,
  Pause,
  Play,
  Redo2,
  Save,
  Search,
  Settings,
  SkipForward,
  Square,
  TerminalSquare,
  Undo2,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";

export interface AppMenuNode {
  disabled?: boolean;
  icon?: ReactNode;
  id: string;
  label: string;
  shortcut?: string;
  children?: AppMenuNode[];
}

export interface HeaderQuickAction {
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
}

export const APP_DROPDOWN_ITEMS: AppMenuNode[] = [
  { id: "workspace.preferences", label: "Preferences", icon: <Settings size={14} /> },
  { id: "workspace.docs", label: "Physics Documentation", icon: <BookOpen size={14} /> },
  { id: "workspace.about", label: "About Fullmag", icon: <Info size={14} /> },
];

export const MAIN_MENUS: AppMenuNode[] = [
  {
    id: "file",
    label: "File",
    children: [
      { id: "workspace.new-problem", label: "New Problem", icon: <FilePlus2 size={14} />, shortcut: "Ctrl+N" },
      { id: "study.import-state", label: "Import .fms State", icon: <Upload size={14} />, shortcut: "Ctrl+O" },
      { id: "workspace.save-sync", label: "Save / Sync", icon: <Save size={14} />, shortcut: "Ctrl+S" },
      { id: "workspace.export-python", label: "Export Python DSL", icon: <FileCode2 size={14} /> },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    children: [
      { id: "workspace.undo", label: "Undo", icon: <Undo2 size={14} />, shortcut: "Ctrl+Z" },
      { id: "workspace.redo", label: "Redo", icon: <Redo2 size={14} />, shortcut: "Ctrl+Y" },
      { id: "workspace.command-palette", label: "Command Palette", icon: <Command size={14} />, shortcut: "Ctrl+Shift+P" },
    ],
  },
  {
    id: "view",
    label: "View",
    children: [
      { id: "workspace.view-3d", label: "3D Workspace", icon: <Box size={14} />, shortcut: "1" },
      { id: "workspace.view-2d", label: "2D Slice Workspace", icon: <LayoutDashboard size={14} />, shortcut: "2" },
      {
        id: "panels",
        label: "Panels",
        children: [
          { id: "panels:explorer:toggle", label: "Explorer" },
          { id: "panels:inspector:toggle", label: "Inspector" },
          { id: "panels:footer:toggle", label: "Bottom Dock" },
        ],
      },
      { id: "workspace.visualization-settings", label: "Visualization Settings" },
    ],
  },
  {
    id: "simulation",
    label: "Simulation",
    children: [
      { id: "study.run", label: "Compute Study", icon: <Play size={14} />, shortcut: "F5" },
      { id: "study.pause", label: "Pause", icon: <Pause size={14} /> },
      { id: "study.resume", label: "Resume", icon: <Play size={14} /> },
      { id: "study.stop", label: "Stop", icon: <Square size={14} /> },
      { id: "study.skip", label: "Skip Stage", icon: <SkipForward size={14} /> },
      {
        id: "execution",
        label: "Execution Target",
        icon: <Cpu size={14} />,
        children: [
          { id: "execution.fdm-cpu", label: "FDM CPU" },
          { id: "execution.fdm-gpu", label: "FDM GPU" },
          { id: "execution.fem-cpu", label: "FEM CPU" },
        ],
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    children: [
      { id: "workspace.diagnostics", label: "Diagnostics", icon: <Gauge size={14} /> },
      { id: "workspace.api-console", label: "API Console", icon: <TerminalSquare size={14} /> },
      { id: "workspace.script-view", label: "Script View", icon: <Braces size={14} /> },
      { id: "tools.registry-inspector", label: "Visualization Registry", icon: <ListChecks size={14} /> },
    ],
  },
  {
    id: "help",
    label: "Help",
    children: [
      { id: "workspace.search-docs", label: "Search Docs", icon: <Search size={14} /> },
      { id: "workspace.reference", label: "Reference", icon: <BookOpen size={14} /> },
      { id: "workspace.about-help", label: "About", icon: <HelpCircle size={14} /> },
    ],
  },
];

export const QUICK_ACTIONS: HeaderQuickAction[] = [
  { id: "workspace.save-sync", label: "Save / Sync", icon: <Save size={14} /> },
  { id: "workspace.undo", label: "Undo", icon: <Undo2 size={14} /> },
  { id: "workspace.redo", label: "Redo", icon: <Redo2 size={14} /> },
];

export const RUN_CONTROLS: HeaderQuickAction[] = [
  { id: "study.run", label: "Compute Study", icon: <Play size={12} fill="currentColor" /> },
  { id: "study.pause", label: "Pause", icon: <Pause size={12} fill="currentColor" /> },
  { id: "study.stop", label: "Stop", icon: <Square size={12} fill="currentColor" /> },
  { id: "study.skip", label: "Skip", icon: <SkipForward size={12} /> },
];
