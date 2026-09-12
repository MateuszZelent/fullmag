"use client";

import React, { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import type { RibbonAction, RibbonGroup } from "@/features/shell/registry/ribbonRegistry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { legacyMenuItemsToNodes } from "@/features/shell/registry/ribbonMenuAdapter";
import { RibbonMenuRenderer } from "./RibbonMenuRenderer";

/* ── Action trigger class helper ─────────────────── */

export function ribbonActionTriggerClassName(
  action: RibbonAction,
  previewPending?: boolean,
  className?: string,
): string {
  const isPrimaryAction = action.accent && !action.disabled;
  return cn(
    "flex h-[52px] min-w-[58px] max-w-[74px] flex-col items-center justify-center gap-1 rounded-md border p-1 transition-all",
    action.active
      ? "border-primary/20 bg-primary/10 text-primary shadow-inner"
      : isPrimaryAction
        ? "border-transparent bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
        : "border-transparent text-foreground hover:border-border/50 hover:bg-muted/80",
    previewPending && action.active && "animate-pulse shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]",
    action.disabled && "cursor-not-allowed opacity-40",
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
          "max-w-full truncate text-center text-[0.62rem] font-medium leading-none",
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
  const nodes = action.menu?.length ? action.menu : legacyMenuItemsToNodes(action.menuItems);

  if (nodes.length === 0) {
    return <RibbonActionTrigger action={action} previewPending={previewPending} />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={ribbonActionTriggerClassName(action, previewPending)}
          disabled={action.disabled}
          title={action.tooltip}
        >
          <RibbonActionTriggerContent action={action} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto">
        <RibbonMenuRenderer nodes={nodes} />
      </DropdownMenuContent>
    </DropdownMenu>
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
    <div className="flex h-[96px] items-stretch overflow-x-auto overflow-y-hidden scrollbar-none px-2 py-2 gap-0.5 bg-card/30 border-b border-border/20">
      {groups
        .filter((g) => g.actions.some((a) => !a.hidden))
        .map((group, gi) => (
          <div key={group.id} className="flex h-full items-stretch shrink-0">
            {gi > 0 && <div className="w-px bg-border/40 mx-1.5 self-stretch my-2" />}
            <div
              className={cn(
                "flex h-full flex-col items-center justify-between rounded-md border px-1.5 py-1 shrink-0",
                ribbonGroupToneClass(group.tone),
              )}
            >
              <div className="flex h-[54px] items-center gap-0.5 overflow-hidden">
                {group.actions.filter((a) => !a.hidden).map((action) =>
                  (action.menu?.length ?? action.menuItems?.length ?? 0) > 0 ? (
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
              <div className="mt-0.5 flex h-[24px] w-full flex-col justify-center border-t border-border/40 pt-0.5 text-center">
                <span className="block truncate text-[0.6rem] font-semibold uppercase tracking-widest text-muted-foreground">
                  {group.title}
                </span>
                {group.subtitle ? (
                  <span className="block truncate text-[0.54rem] font-medium leading-none text-muted-foreground/70">
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
