"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FileText, FolderOpen, Save, Download, LogOut,
  Undo2, Redo2, Settings,
  Box, Columns2, Grid3X3, PanelRight, Monitor,
  Terminal, LayoutGrid, BarChart3,
  BookOpen, Keyboard, Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import FullmagLogo from "../brand/FullmagLogo";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";

/* ── Menu definitions ───────────────────────────── */

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  action?: () => void;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

export interface TopHeaderProps {
  problemName: string;
  backend: string;
  runtimeEngine?: string;
  runtimeGpuLabel?: string;
  status: string;
  connection: "connecting" | "connected" | "disconnected";
  commandBusy?: boolean;
  commandMessage?: string | null;
  viewMode?: string;
  onViewChange?: (mode: string) => void;
  onSidebarToggle?: () => void;
  onSaveSession?: () => void;
  onOpenSession?: () => void;
}

interface MenuCallbacks {
  onOpenSettings: () => void;
  onOpenDocs: () => void;
  onOpenAbout: () => void;
  onSaveSession: () => void;
  onOpenSession: () => void;
}

function buildMenus(props: TopHeaderProps, cb: MenuCallbacks): MenuDef[] {
  return [
    {
      label: "File",
      items: [
        { label: "New Script", icon: <FileText size={14} />, shortcut: "Ctrl+N" },
        { label: "Open…", icon: <FolderOpen size={14} />, shortcut: "Ctrl+O", action: cb.onOpenSession },
        { label: "Save Session", icon: <Save size={14} />, shortcut: "Ctrl+S", action: cb.onSaveSession },
        { separator: true, label: "" },
        { label: "Export VTK", icon: <Download size={14} /> },
        { separator: true, label: "" },
        { label: "Exit", icon: <LogOut size={14} /> },
      ],
    },
    {
      label: "Edit",
      items: [
        { label: "Undo", icon: <Undo2 size={14} />, shortcut: "Ctrl+Z", disabled: true },
        { label: "Redo", icon: <Redo2 size={14} />, shortcut: "Ctrl+Shift+Z", disabled: true },
        { separator: true, label: "" },
        { label: "Preferences", icon: <Settings size={14} />, action: cb.onOpenSettings },
      ],
    },
    {
      label: "View",
      items: [
        { label: "3D View", icon: <Box size={14} />, shortcut: "1", action: () => props.onViewChange?.("3D") },
        { label: "2D View", icon: <Columns2 size={14} />, shortcut: "2", action: () => props.onViewChange?.("2D") },
        { label: "Mesh View", icon: <Grid3X3 size={14} />, shortcut: "3", action: () => props.onViewChange?.("Mesh") },
        { separator: true, label: "" },
        { label: "Toggle Sidebar", icon: <PanelRight size={14} />, shortcut: "Ctrl+B", action: props.onSidebarToggle },
        { separator: true, label: "" },
        { label: "Theme", icon: <Monitor size={14} /> },
      ],
    },
    {
      label: "Tools",
      items: [
        { label: "Script Editor", icon: <Terminal size={14} /> },
        { label: "Mesh Builder", icon: <LayoutGrid size={14} /> },
        { separator: true, label: "" },
        { label: "Performance", icon: <BarChart3 size={14} /> },
      ],
    },
    {
      label: "Help",
      items: [
        { label: "Documentation", icon: <BookOpen size={14} />, action: cb.onOpenDocs },
        { label: "Keyboard Shortcuts", icon: <Keyboard size={14} />, shortcut: "Ctrl?", action: cb.onOpenSettings },
        { separator: true, label: "" },
        { label: "About Fullmag", icon: <Info size={14} />, action: cb.onOpenAbout },
      ],
    },
  ];
}

/* ── Component ──────────────────────────────────── */

export default function TopHeader(props: TopHeaderProps) {
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen);
  const setPhysicsDocsOpen = useWorkspaceStore((s) => s.setPhysicsDocsOpen);

  const menuCallbacks: MenuCallbacks = {
    onOpenSettings: () => setSettingsOpen(true),
    onOpenDocs: () => setPhysicsDocsOpen(true),
    onOpenAbout: () => setSettingsOpen(true),
    onSaveSession: () => props.onSaveSession?.(),
    onOpenSession: () => props.onOpenSession?.(),
  };

  const menus = buildMenus(props, menuCallbacks);
  return (
    <div className="flex flex-col w-full shrink-0 border-b border-white/5 bg-background/70 backdrop-blur-xl z-[60] relative">
      {/* ── Row 1: logo + menus + status + controls ── */}
      <div className="flex h-9 w-full items-center justify-between px-3 text-sm font-medium">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-2 whitespace-nowrap pr-1">
          <FullmagLogo size={22} className="opacity-90 drop-shadow-sm" />
          <span className="text-[0.8rem] font-semibold tracking-tight text-foreground/90 truncate max-w-[16rem]">{props.problemName}</span>
        </span>

        <div className="hidden items-center gap-0.5 border-l border-white/5 pl-3 lg:flex">
          {menus.map((menu) => (
            <DropdownMenu.Root key={menu.label}>
              <DropdownMenu.Trigger className="px-2 py-1 text-[0.72rem] font-medium text-muted-foreground outline-none cursor-default rounded transition-colors hover:bg-muted/40 hover:text-foreground data-[state=open]:bg-muted/40 data-[state=open]:text-foreground">
                {menu.label}
              </DropdownMenu.Trigger>

              <DropdownMenu.Portal>
                <DropdownMenu.Content className="min-w-[220px] rounded-md border border-border/50 bg-popover/95 text-popover-foreground backdrop-blur-xl p-1 shadow-md animate-in fade-in-80 slide-in-from-top-1 z-[100]" sideOffset={8} align="start">
                  {menu.items.map((item, i) =>
                    item.separator ? (
                      <DropdownMenu.Separator key={i} className="my-1 h-px bg-border/50" />
                    ) : (
                      <DropdownMenu.Item
                        key={item.label}
                        className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                        disabled={item.disabled}
                        onSelect={() => item.action?.()}
                      >
                        <span className="mr-2 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground opacity-70">{item.icon}</span>
                        <span className="flex-1">{item.label}</span>
                        {item.shortcut && (
                          <span className="ml-auto text-[0.65rem] tracking-widest text-muted-foreground opacity-60">{item.shortcut}</span>
                        )}
                      </DropdownMenu.Item>
                    ),
                  )}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 border-r border-border/40 pr-3 h-5 md:flex">
          <span className="text-[0.62rem] font-medium tracking-wider text-muted-foreground uppercase mr-1">
            {props.backend} {props.runtimeEngine ? `· ${props.runtimeEngine}` : ""} {props.runtimeGpuLabel ? `· ${props.runtimeGpuLabel}` : ""}
          </span>
          <span className={cn(
            "flex items-center gap-1.5 text-[0.62rem] font-medium tracking-wider uppercase",
            props.connection === "connected" ? "text-emerald-500" :
            props.connection === "connecting" ? "text-amber-500" : "text-rose-500"
          )}>
            <span className="relative flex h-1.5 w-1.5">
              {props.connection === "connecting" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            {props.status}
          </span>
        </div>

        {props.commandMessage && (
          <div
            className={cn(
              "hidden max-w-[12rem] truncate rounded-full border px-2 py-0.5 text-[0.58rem] font-medium tracking-wider uppercase xl:block",
              props.commandBusy
                ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                : "border-sky-500/30 bg-sky-500/10 text-sky-300",
            )}
            title={props.commandMessage}
          >
            {props.commandMessage}
          </div>
        )}

        <div
          className="hidden rounded-md border border-border/40 bg-card/30 px-2 py-1 text-[0.62rem] font-medium tracking-wide text-muted-foreground lg:block"
          title="Stage authoring and execution now live in the Study ribbon."
        >
          Compute in Study
        </div>
      </div>
      </div>

    </div>
  );
}
