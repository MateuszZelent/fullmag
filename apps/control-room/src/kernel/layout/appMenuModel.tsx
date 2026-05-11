import {
  BookOpen,
  Box,
  Braces,
  Command,
  Cpu,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Gauge,
  HelpCircle,
  Info,
  LayoutDashboard,
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
  { id: "preferences", label: "Preferences", icon: <Settings size={14} /> },
  { id: "docs", label: "Physics Documentation", icon: <BookOpen size={14} /> },
  { id: "about", label: "About Fullmag", icon: <Info size={14} /> },
];

export const MAIN_MENUS: AppMenuNode[] = [
  {
    id: "file",
    label: "File",
    children: [
      { id: "new", label: "New Problem", icon: <FilePlus2 size={14} />, shortcut: "Ctrl+N" },
      { id: "open", label: "Open Project", icon: <FolderOpen size={14} />, shortcut: "Ctrl+O" },
      { id: "save", label: "Save / Sync", icon: <Save size={14} />, shortcut: "Ctrl+S" },
      { id: "export-python", label: "Export Python DSL", icon: <FileCode2 size={14} /> },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    children: [
      { id: "undo", label: "Undo", icon: <Undo2 size={14} />, shortcut: "Ctrl+Z", disabled: true },
      { id: "redo", label: "Redo", icon: <Redo2 size={14} />, shortcut: "Ctrl+Y", disabled: true },
      { id: "command-palette", label: "Command Palette", icon: <Command size={14} />, shortcut: "Ctrl+K" },
    ],
  },
  {
    id: "view",
    label: "View",
    children: [
      { id: "view-3d", label: "3D Workspace", icon: <Box size={14} />, shortcut: "1" },
      { id: "view-2d", label: "2D Slice Workspace", icon: <LayoutDashboard size={14} />, shortcut: "2" },
      {
        id: "panels",
        label: "Panels",
        children: [
          { id: "explorer", label: "Explorer" },
          { id: "inspector", label: "Inspector" },
          { id: "bottom-dock", label: "Bottom Dock" },
        ],
      },
    ],
  },
  {
    id: "simulation",
    label: "Simulation",
    children: [
      { id: "run", label: "Run", icon: <Play size={14} />, shortcut: "F5", disabled: true },
      { id: "pause", label: "Pause", icon: <Pause size={14} />, disabled: true },
      { id: "stop", label: "Stop", icon: <Square size={14} />, disabled: true },
      { id: "skip", label: "Skip Stage", icon: <SkipForward size={14} />, disabled: true },
      {
        id: "execution",
        label: "Execution Target",
        icon: <Cpu size={14} />,
        children: [
          { id: "fdm-cpu", label: "FDM CPU" },
          { id: "fdm-gpu", label: "FDM GPU" },
          { id: "fem-cpu", label: "FEM CPU" },
        ],
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    children: [
      { id: "diagnostics", label: "Diagnostics", icon: <Gauge size={14} /> },
      { id: "api-console", label: "API Console", icon: <TerminalSquare size={14} /> },
      { id: "script-view", label: "Script View", icon: <Braces size={14} /> },
    ],
  },
  {
    id: "help",
    label: "Help",
    children: [
      { id: "search-docs", label: "Search Docs", icon: <Search size={14} /> },
      { id: "reference", label: "Reference", icon: <BookOpen size={14} /> },
      { id: "about-help", label: "About", icon: <HelpCircle size={14} /> },
    ],
  },
];

export const QUICK_ACTIONS: HeaderQuickAction[] = [
  { id: "save", label: "Save / Sync", icon: <Save size={14} />, disabled: true },
  { id: "undo", label: "Undo", icon: <Undo2 size={14} />, disabled: true },
  { id: "redo", label: "Redo", icon: <Redo2 size={14} />, disabled: true },
];

export const RUN_CONTROLS: HeaderQuickAction[] = [
  { id: "run", label: "Run", icon: <Play size={12} fill="currentColor" />, disabled: true },
  { id: "pause", label: "Pause", icon: <Pause size={12} fill="currentColor" />, disabled: true },
  { id: "stop", label: "Stop", icon: <Square size={12} fill="currentColor" />, disabled: true },
  { id: "skip", label: "Skip", icon: <SkipForward size={12} />, disabled: true },
];
