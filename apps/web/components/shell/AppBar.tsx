"use client";

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Save,
  Undo2,
  Redo2,
  RefreshCw,
  Search,
  BookOpen,
  Info,
  Settings,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import FullmagLogo from "../brand/FullmagLogo";
import type { WorkspaceMode } from "../runs/control-room/context-hooks";
import { useWorkspaceStore } from "@/lib/workspace/workspace-store";
import { useRouter } from "next/navigation";

export interface AppBarProps {
  problemName: string;
  backend: string;
  runtimeEngine?: string;
  runtimeGpuLabel?: string;
  status: string;
  connection: "connecting" | "connected" | "disconnected";
  interactiveEnabled?: boolean;
  commandBusy?: boolean;
  commandMessage?: string | null;
  canSyncScriptBuilder?: boolean;
  scriptSyncBusy?: boolean;
  onSyncScriptBuilder?: () => void;
  workspaceMode: WorkspaceMode;
  resultsAvailable?: boolean;
  onPerspectiveChange?: (mode: WorkspaceMode) => void;
}

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  action?: () => void;
}

const PERSPECTIVE_ENTRIES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: "build", label: "Model" },
  { id: "study", label: "Study" },
  { id: "analyze", label: "Results" },
];

function quickSyncBadge(
  canSyncScriptBuilder: boolean | undefined,
  scriptSyncBusy: boolean | undefined,
): string {
  if (scriptSyncBusy) return "syncing";
  if (canSyncScriptBuilder) return "linked";
  return "local";
}

export default function AppBar(props: AppBarProps) {
  const router = useRouter();
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen);
  const setPhysicsDocsOpen = useWorkspaceStore((s) => s.setPhysicsDocsOpen);

  const appMenu: MenuItem[] = [
    {
      label: "Preferences",
      icon: <Settings size={14} />,
      action: () => {
        setSettingsOpen(false);
        router.push("/settings");
      },
    },
    { label: "Documentation", icon: <BookOpen size={14} />, action: () => setPhysicsDocsOpen(true) },
    {
      label: "About Fullmag",
      icon: <Info size={14} />,
      action: () => {
        setSettingsOpen(false);
        router.push("/settings");
      },
    },
  ];

  const quickActions = [
    {
      id: "save",
      label: props.scriptSyncBusy ? "Syncing..." : "Save/Sync",
      icon: <Save size={15} />,
      disabled: !props.canSyncScriptBuilder || props.scriptSyncBusy,
      action: () => props.onSyncScriptBuilder?.(),
    },
    {
      id: "undo",
      label: "Undo",
      icon: <Undo2 size={15} />,
      disabled: true,
      action: undefined,
    },
    {
      id: "redo",
      label: "Redo",
      icon: <Redo2 size={15} />,
      disabled: true,
      action: undefined,
    },
  ] as const;

  return (
    <div className="flex w-full shrink-0 items-center gap-3 border-b border-white/5 bg-background/70 px-3 py-1.5 backdrop-blur-xl z-[60]">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex items-center gap-2 whitespace-nowrap pr-1">
          <FullmagLogo size={22} className="opacity-90 drop-shadow-sm" />
          <span className="text-[0.8rem] font-semibold tracking-tight text-foreground/90">{props.problemName}</span>
        </span>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[0.72rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground">
              Fullmag
              <ChevronDown size={12} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="z-[100] min-w-[220px] rounded-md border border-border/50 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-xl animate-in fade-in-80 slide-in-from-top-1"
              sideOffset={8}
              align="start"
            >
              {appMenu.map((item) => (
                <DropdownMenu.Item
                  key={item.label}
                  className="relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[highlighted]:text-foreground"
                  disabled={item.disabled}
                  onSelect={() => item.action?.()}
                >
                  <span className="mr-2 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground opacity-70">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <div className="hidden items-center gap-1 border-l border-border/30 pl-3 xl:flex">
          {quickActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border/30 px-2 text-[0.66rem] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={action.disabled}
              onClick={action.action}
              title={action.label}
            >
              {action.id === "save" && props.scriptSyncBusy ? <RefreshCw size={14} className="animate-spin" /> : action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        <label className="hidden lg:flex h-7 min-w-[240px] items-center gap-2 rounded-md border border-border/40 bg-card/30 px-2 text-[0.68rem] text-muted-foreground">
          <Search size={13} className="opacity-80" />
          <input
            type="text"
            className="w-full bg-transparent text-[0.68rem] text-foreground outline-none placeholder:text-muted-foreground/80"
            placeholder="Command search (Ctrl+K)"
            readOnly
          />
        </label>
      </div>

      <div className="mx-auto hidden items-center gap-1 rounded-lg border border-border/35 bg-card/30 p-1 md:flex">
        {PERSPECTIVE_ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => props.onPerspectiveChange?.(entry.id)}
            disabled={entry.id === "analyze" && props.resultsAvailable === false}
            title={
              entry.id === "analyze" && props.resultsAvailable === false
                ? "Results become available after the first completed solve."
                : undefined
            }
            className={cn(
              "rounded-md px-2.5 py-1 text-[0.67rem] font-semibold tracking-wide transition-colors",
              props.workspaceMode === entry.id
                ? "bg-primary/15 text-primary border border-primary/30"
                : "text-muted-foreground border border-transparent hover:bg-muted/40 hover:text-foreground",
              entry.id === "analyze" && props.resultsAvailable === false && "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 border-r border-border/40 pr-3 h-5 md:flex">
          <span className="text-[0.62rem] font-medium tracking-wider text-muted-foreground uppercase mr-1">
            {props.backend}
            {props.runtimeEngine ? ` · ${props.runtimeEngine}` : ""}
            {props.runtimeGpuLabel ? ` · ${props.runtimeGpuLabel}` : ""}
          </span>
          <span className={cn(
            "flex items-center gap-1.5 text-[0.62rem] font-medium tracking-wider uppercase",
            props.connection === "connected" ? "text-emerald-500" :
            props.connection === "connecting" ? "text-amber-500" : "text-rose-500",
          )}>
            <span className="relative flex h-1.5 w-1.5">
              {props.connection === "connecting" ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" /> : null}
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            {props.status}
          </span>
          <span className="rounded-sm border border-border/40 px-1.5 py-0.5 text-[0.56rem] tracking-[0.12em] text-muted-foreground uppercase">
            {quickSyncBadge(props.canSyncScriptBuilder, props.scriptSyncBusy)}
          </span>
        </div>

        {props.commandMessage ? (
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
        ) : null}

        <div
          className="hidden rounded-md border border-border/40 bg-card/30 px-2 py-1 text-[0.62rem] font-medium tracking-wide text-muted-foreground lg:block"
          title="Stage authoring and execution now live in the Study ribbon."
        >
          Compute in Study
        </div>
      </div>
    </div>
  );
}
