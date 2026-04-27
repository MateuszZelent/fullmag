"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { RibbonAction, RibbonGroup } from "@/features/shell/registry/ribbonRegistry";

/* ── Action trigger class helper ─────────────────── */

export function ribbonActionTriggerClassName(
  action: RibbonAction,
  previewPending?: boolean,
  className?: string,
): string {
  const isPrimaryAction = action.accent && !action.disabled;
  return cn(
    "flex min-h-[52px] min-w-[58px] flex-col items-center justify-center gap-1 rounded-md border p-1 transition-all",
    action.active
      ? "border-primary/20 bg-primary/10 text-primary shadow-inner"
      : isPrimaryAction
        ? "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
        : "border-transparent text-foreground hover:border-border/50 hover:bg-muted/80",
    previewPending && action.active && "animate-pulse shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]",
    action.disabled && "pointer-events-none cursor-not-allowed opacity-40",
    className,
  );
}

/* ── Render helpers ──────────────────────────────── */

function RibbonActionTriggerContent({ action }: { action: RibbonAction }) {
  const isPrimaryAction = action.accent && !action.disabled;
  return (
    <>
      <span
        className={cn(
          "flex flex-col items-center",
          isPrimaryAction
            ? action.iconColor ?? "text-primary-foreground"
            : action.active
              ? "text-primary"
              : action.iconColor ?? "text-muted-foreground",
        )}
      >
        {action.icon}
      </span>
      <span
        className={cn(
          "text-[0.62rem] font-medium leading-none text-center",
          isPrimaryAction
            ? "text-primary-foreground"
            : action.active
              ? "text-primary"
              : "text-foreground",
        )}
      >
        {action.label}
      </span>
    </>
  );
}

export const RibbonActionTrigger = React.forwardRef<
  HTMLButtonElement,
  {
    action: RibbonAction;
    previewPending?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ action, previewPending, ...rest }, ref) => {
  const propsOnClick = rest.onClick;
  const propsOnPointerUp = rest.onPointerUp;
  const isHandlingRef = useRef(false);
  const invokeAction = useCallback(() => {
    if (isHandlingRef.current) return;
    isHandlingRef.current = true;
    try {
      action.action?.();
    } finally {
      window.setTimeout(() => {
        isHandlingRef.current = false;
      }, 0);
    }
  }, [action]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      propsOnClick?.(e);
      if (e.defaultPrevented) return;
      invokeAction();
    },
    [invokeAction, propsOnClick],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      propsOnPointerUp?.(e);
      if (e.defaultPrevented || e.button !== 0) return;
      invokeAction();
    },
    [invokeAction, propsOnPointerUp],
  );

  return (
    <button
      ref={ref}
      {...rest}
      type={rest.type ?? "button"}
      className={ribbonActionTriggerClassName(action, previewPending, rest.className)}
      disabled={action.disabled}
      onClick={handleClick}
      onPointerUp={handlePointerUp}
    >
      <RibbonActionTriggerContent action={action} />
    </button>
  );
});
RibbonActionTrigger.displayName = "RibbonActionTrigger";

export function RibbonActionMenu({
  action,
  previewPending,
}: {
  action: RibbonAction;
  previewPending?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const visibleItems = (action.menuItems ?? []).filter((item) => !item.hidden);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (visibleItems.length === 0) {
    return <RibbonActionTrigger action={action} previewPending={previewPending} />;
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={ribbonActionTriggerClassName(action, previewPending)}
        disabled={action.disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        <RibbonActionTriggerContent action={action} />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-[100] mt-2 min-w-[280px] rounded-md border border-border/50 bg-popover/95 p-1 text-popover-foreground shadow-md backdrop-blur-xl">
          {visibleItems.map((item) =>
            item.separator ? (
              <div key={item.id} className="my-1 h-px bg-border/50" />
            ) : (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "relative flex w-full cursor-default select-none items-start gap-2 rounded-sm px-2 py-2 text-left text-xs outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 hover:bg-muted hover:text-foreground",
                  item.active && "bg-primary/10 text-primary",
                )}
                disabled={item.disabled}
                onClick={() => {
                  item.action?.();
                  setOpen(false);
                }}
              >
                <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-muted-foreground opacity-80">
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.label}</span>
                  {item.description ? (
                    <span className="block truncate text-[0.68rem] text-muted-foreground">
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ── Group tone helper ───────────────────────────── */

export function ribbonGroupToneClass(tone: RibbonGroup["tone"] | undefined): string {
  switch (tone) {
    case "authoring":  return "border-emerald-500/20 bg-emerald-500/5";
    case "compose":    return "border-violet-500/20 bg-violet-500/5";
    case "compute":    return "border-primary/25 bg-primary/10";
    case "selection":  return "border-amber-500/20 bg-amber-500/5";
    case "sync":       return "border-cyan-500/20 bg-cyan-500/5";
    case "neutral":
    default:           return "border-border/40 bg-card/30";
  }
}

/* ── RibbonGroupsRow ─────────────────────────────── */

export interface RibbonGroupsRowProps {
  groups: RibbonGroup[];
  previewPending?: boolean;
}

export function RibbonGroupsRow({ groups, previewPending }: RibbonGroupsRowProps) {
  return (
    <div className="flex items-stretch overflow-x-auto scrollbar-none py-2 px-2 gap-0.5 bg-card/30 border-b border-border/20">
      {groups
        .filter((g) => g.actions.some((a) => !a.hidden))
        .map((group, gi) => (
          <div key={group.id} className="flex items-stretch shrink-0">
            {gi > 0 && <div className="w-px bg-border/40 mx-1.5 self-stretch my-2" />}
            <div
              className={cn(
                "flex min-h-[64px] flex-col justify-between items-center rounded-md border px-1.5 py-1 shrink-0",
                ribbonGroupToneClass(group.tone),
              )}
            >
              <div className="flex items-center gap-0.5">
                {group.actions.filter((a) => !a.hidden).map((action) =>
                  action.menuItems && action.menuItems.length > 0 ? (
                    <RibbonActionMenu
                      key={action.id}
                      action={action}
                      previewPending={previewPending}
                    />
                  ) : action.tooltip ? (
                    <RibbonActionTrigger
                      key={action.id}
                      action={action}
                      previewPending={previewPending}
                      title={
                        action.shortcut
                          ? `${action.tooltip} (${action.shortcut})`
                          : action.tooltip
                      }
                    />
                  ) : (
                    <RibbonActionTrigger
                      key={action.id}
                      action={action}
                      previewPending={previewPending}
                    />
                  ),
                )}
              </div>
              <div className="mt-0.5 w-full border-t border-border/40 pt-0.5 text-center">
                <span className="block text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                  {group.title}
                </span>
                {group.subtitle ? (
                  <span className="block text-[0.54rem] font-medium text-muted-foreground/70">
                    {group.subtitle}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
    </div>
  );
}
