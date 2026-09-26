import {
  BookOpen,
  Box,
  Braces,
  Check,
  Command,
  Cpu,
  Database,
  FileCode2,
  FilePlus2,
  Gauge,
  HelpCircle,
  Info,
  LayoutDashboard,
  Layers3,
  ListChecks,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Settings,
  SkipForward,
  Square,
  TerminalSquare,
  Timer,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

export interface AppMenuNode {
  checkable?: boolean;
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

const HIDDEN_PLACEHOLDER_COMMAND_IDS = new Set([
  "workspace.preferences",
  "workspace.docs",
  "workspace.about",
  "workspace.view-2d",
  "execution.fdm-cpu",
  "execution.fdm-gpu",
  "execution.fem-cpu",
  "workspace.diagnostics",
  "workspace.api-console",
  "workspace.script-view",
  "workspace.search-docs",
  "workspace.reference",
  "workspace.about-help",
]);

function hidePlaceholderMenuNodes(nodes: AppMenuNode[]): AppMenuNode[] {
  return nodes.flatMap((node) => {
    if (HIDDEN_PLACEHOLDER_COMMAND_IDS.has(node.id)) return [];

    if (!node.children) return [node];

    const children = hidePlaceholderMenuNodes(node.children);
    if (children.length === 0) return [];

    return [{ ...node, children }];
  });
}

const APP_DROPDOWN_ITEM_DEFINITIONS: AppMenuNode[] = [
  { id: "workspace.theme-toggle", label: "Toggle Theme", icon: <Settings size={14} /> },
  { id: "workspace.preferences", label: "Preferences", icon: <Settings size={14} /> },
  { id: "workspace.docs", label: "Physics Documentation", icon: <BookOpen size={14} /> },
  { id: "workspace.about", label: "About Fullmag", icon: <Info size={14} /> },
];

const MAIN_MENU_DEFINITIONS: AppMenuNode[] = [
  {
    id: "file",
    label: "File",
    children: [
      { id: "workspace.new-problem", label: "New Problem", icon: <FilePlus2 size={14} />, shortcut: "Ctrl+N" },
      { id: "workspace.new-project", label: "New Project", icon: <FilePlus2 size={14} />, shortcut: "Ctrl+Shift+N" },
      { id: "workspace.open-project", label: "Open Project", icon: <Upload size={14} />, shortcut: "Ctrl+O" },
      { id: "study.import-state", label: "Restore Runtime State", icon: <Upload size={14} />, shortcut: "Ctrl+Shift+O" },
      { id: "workspace.save-project", label: "Save Project", icon: <Save size={14} />, shortcut: "Ctrl+S" },
      { id: "workspace.close-project", label: "Close Project", icon: <X size={14} />, shortcut: "Ctrl+W" },
      { id: "workspace.export-python", label: "Export Python DSL", icon: <FileCode2 size={14} /> },
    ],
  },
  {
    id: "edit",
    label: "Edit",
    children: [
      { id: "workspace.apply-inspector", label: "Apply Inspector Changes", icon: <Check size={14} />, shortcut: "Ctrl+Shift+Enter" },
      { id: "workspace.reset-inspector", label: "Reset Inspector Changes", icon: <RotateCcw size={14} /> },
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
      { id: "study.prepare-live", label: "Prepare Live Study", icon: <Layers3 size={14} /> },
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
      { id: "tools.thread-manager", label: "Diagnostic Recorder", icon: <Cpu size={14} /> },
      { id: "tools.material-library", label: "Material Library", icon: <BookOpen size={14} /> },
      { id: "tools.data-preview", label: "Data Preview", icon: <Database size={14} /> },
      { id: "tools.communication", label: "Communication", icon: <Settings size={14} /> },
      { id: "diagnostics.toggle-solver-profiler", label: "Solver Profiler", icon: <Timer size={14} />, checkable: true },
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

const QUICK_ACTION_DEFINITIONS: HeaderQuickAction[] = [
  { id: "workspace.save-project", label: "Save Project", icon: <Save size={14} /> },
  { id: "workspace.apply-inspector", label: "Apply Inspector", icon: <Check size={14} /> },
  { id: "workspace.undo", label: "Undo", icon: <Undo2 size={14} /> },
  { id: "workspace.redo", label: "Redo", icon: <Redo2 size={14} /> },
];

export const APP_DROPDOWN_ITEMS: AppMenuNode[] = hidePlaceholderMenuNodes(
  APP_DROPDOWN_ITEM_DEFINITIONS,
);

export const MAIN_MENUS: AppMenuNode[] = hidePlaceholderMenuNodes(
  MAIN_MENU_DEFINITIONS,
);

export const QUICK_ACTIONS: HeaderQuickAction[] = QUICK_ACTION_DEFINITIONS.filter(
  (action) => !HIDDEN_PLACEHOLDER_COMMAND_IDS.has(action.id),
);

export const RUN_CONTROLS: HeaderQuickAction[] = [
  { id: "study.run", label: "Compute Study", icon: <Play size={12} fill="currentColor" /> },
  { id: "study.pause", label: "Pause", icon: <Pause size={12} fill="currentColor" /> },
  { id: "study.stop", label: "Stop", icon: <Square size={12} fill="currentColor" /> },
  { id: "study.skip", label: "Skip", icon: <SkipForward size={12} /> },
];
