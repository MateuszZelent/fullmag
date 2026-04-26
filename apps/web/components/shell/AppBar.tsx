"use client";

import * as React from "react";
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
  Play,
  Pause,
  Square,
  SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import FullmagLogo from "../brand/FullmagLogo";
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
  // Run controls
  runtimeStatus?: "idle" | "running" | "paused" | "failed" | "awaiting_command";
  currentStep?: number | null;
  canRun?: boolean;
  canPause?: boolean;
  canStop?: boolean;
  canSkip?: boolean;
  onRun?: () => void;
  onPause?: () => void;
  onStop?: () => void;
  onSkip?: () => void;
}

interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  action?: () => void;
}

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
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!menuRootRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

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
    <div className="z-[60] flex w-full shrink-0 flex-wrap items-center gap-2 border-b border-white/5 bg-background/70 px-3 py-1.5 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex items-center gap-2 whitespace-nowrap pr-1">
          <FullmagLogo size={22} className="opacity-90 drop-shadow-sm" />
          <span className="text-[0.8rem] font-semibold tracking-tight text-foreground/90">{props.problemName}</span>
        </span>

        <div ref={menuRootRef} className="relative">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-[0.72rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={() => setMenuOpen((previous) => !previous)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            Fullmag
            <ChevronDown size={12} />
          </button>
          {menuOpen ? (
            <div className="absolute left-0 top-full z-[100] mt-2 min-w-[220px] rounded-md border border-border/50 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-xl">
              {appMenu.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="relative flex w-full select-none items-center rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 hover:bg-muted hover:text-foreground"
                  disabled={item.disabled}
                  onClick={() => {
                    item.action?.();
                    setMenuOpen(false);
                  }}
                >
                  <span className="mr-2 flex h-3.5 w-3.5 items-center justify-center text-muted-foreground opacity-70">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

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

      <div className="ml-auto flex items-center gap-2">
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

        <div className="hidden items-center gap-0.5 lg:flex">
          {/* Runtime status badge */}
          {props.runtimeStatus && props.runtimeStatus !== "idle" ? (
            <span
              className={cn(
                "mr-1.5 rounded-sm border px-2 py-0.5 text-[0.58rem] font-medium tracking-wider uppercase tabular-nums",
                props.runtimeStatus === "running"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : props.runtimeStatus === "paused"
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : props.runtimeStatus === "failed"
                      ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
                      : "border-sky-500/30 bg-sky-500/10 text-sky-300",
              )}
            >
              {props.runtimeStatus === "running" && props.currentStep != null
                ? `step ${props.currentStep}`
                : props.runtimeStatus}
            </span>
          ) : null}

          {/* Run */}
          <button
            type="button"
            disabled={!props.canRun}
            onClick={props.onRun}
            title="Run (R)"
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-emerald-400 transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Play size={12} fill="currentColor" />
          </button>

          {/* Pause */}
          <button
            type="button"
            disabled={!props.canPause}
            onClick={props.onPause}
            title="Pause"
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-amber-400 transition-colors hover:border-amber-500/30 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Pause size={12} fill="currentColor" />
          </button>

          {/* Stop */}
          <button
            type="button"
            disabled={!props.canStop}
            onClick={props.onStop}
            title="Stop"
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-rose-400 transition-colors hover:border-rose-500/30 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Square size={12} fill="currentColor" />
          </button>

          {/* Skip */}
          <button
            type="button"
            disabled={!props.canSkip}
            onClick={props.onSkip}
            title="Skip stage"
            className="inline-flex h-6 w-6 items-center justify-center rounded border border-transparent text-violet-400 transition-colors hover:border-violet-500/30 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <SkipForward size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
