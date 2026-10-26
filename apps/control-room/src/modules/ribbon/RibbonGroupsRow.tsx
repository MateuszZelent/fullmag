"use client";

import { ChevronDown } from "lucide-react";
import { Fragment, useLayoutEffect, useRef } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { DisabledReason } from "@/shared/ui/DisabledReason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import { ICON_COLOR_ALIASES } from "./ribbonCommon";
import { RibbonMenuRenderer } from "./RibbonMenuRenderer";
import type {
  RibbonActionStatus,
  RibbonGroup as RibbonGroupData,
  RibbonMenuNode,
} from "./ribbonTypes";
import type { RibbonDensity } from "./ribbonPreference";

export function resolveRibbonIconColor(iconColor?: string): string | undefined {
  if (!iconColor) {
    return undefined;
  }

  if (iconColor.startsWith("var(")) {
    return iconColor;
  }

  if (iconColor === "text-muted-foreground") {
    return ICON_COLOR_ALIASES.muted;
  }

  const tailwindToken = /^text-([a-z]+)(?:-\d+)?$/.exec(iconColor);
  if (!tailwindToken) {
    return undefined;
  }

  return ICON_COLOR_ALIASES[tailwindToken[1]];
}

export function resolveRibbonActionTriggerState({
  disabled,
  hasMenu,
  splitButton,
}: {
  disabled?: boolean;
  hasMenu: boolean;
  splitButton?: boolean;
}): {
  disabled: boolean;
  runsActionFromButton: boolean;
  runsActionFromSplitBody: boolean;
} {
  if (disabled) {
    return {
      disabled: true,
      runsActionFromButton: false,
      runsActionFromSplitBody: false,
    };
  }

  return {
    disabled: false,
    runsActionFromButton: !hasMenu,
    runsActionFromSplitBody: hasMenu && Boolean(splitButton),
  };
}

interface RibbonGroupsRowProps {
  groups: RibbonGroupData[];
  activeTabId?: string;
  density?: RibbonDensity;
  onAction?: (actionId: string, input?: unknown) => void;
  onCommandDetail?: (commandId: string) => void;
}

function RibbonActionButton({
  actionMenu,
  id,
  icon,
  label,
  disabled,
  active,
  activeCommandId,
  accent,
  size,
  status,
  shortcut,
  actionType,
  tooltip,
  iconColor,
  commandId,
  commandInput,
  splitButton,
  onAction,
  onCommandDetail,
}: {
  actionMenu?: RibbonGroupData["actions"][number]["menu"];
  id: string;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  active?: boolean;
  activeCommandId?: string;
  accent?: boolean;
  size?: "large" | "compact";
  status?: RibbonActionStatus;
  shortcut?: string;
  actionType?: "checkbox" | "button";
  tooltip?: string;
  iconColor?: string;
  commandId?: string;
  commandInput?: unknown;
  splitButton?: boolean;
  onAction?: (actionId: string, input?: unknown) => void;
  onCommandDetail?: (commandId: string) => void;
}) {
  const hasMenu = Boolean(actionMenu?.length);
  const triggerState = resolveRibbonActionTriggerState({
    disabled,
    hasMenu,
    splitButton,
  });
  const resolvedIconColor = active ? undefined : resolveRibbonIconColor(iconColor);
  const style = resolvedIconColor
    ? ({ "--fm-ribbon-icon-color": resolvedIconColor } as CSSProperties)
    : undefined;
  const statusText = statusLabel(status);
  const shellClassName = `fm-ribbon-action-shell${size === "large" || accent ? " fm-ribbon-action-shell--large" : ""}`;
  const tooltipText = [tooltip ?? label, shortcut].filter(Boolean).join(" · ");
  const runAction = () => {
    if (!triggerState.disabled) {
      onAction?.(commandId ?? id, commandInput);
    }
  };
  // Split-button handlers: only used when splitButton=true (body runs command,
  // chevron opens dropdown). For pure-menu buttons the whole area opens the dropdown.
  const runMenuActionFromPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const target = event.target;
    const menuTrigger =
      target instanceof Element &&
      Boolean(target.closest("[data-ribbon-menu-trigger='true']"));
    if (event.button === 0 && !menuTrigger) {
      // Radix DropdownMenuTrigger opens on bubble pointerdown; stop it so the
      // split-button body runs the command without also opening the dropdown.
      event.stopPropagation();
      event.preventDefault();
      runAction();
    }
  };
  const runMenuActionFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      // See runMenuActionFromPointer: keep the command from double-triggering
      // Radix's bubble onKeyDown menu toggle.
      event.stopPropagation();
      event.preventDefault();
      runAction();
    }
  };
  const trigger = (
    <button
      className="fm-ribbon-action"
      data-action-id={id}
      data-active={active ?? false}
      data-accent={accent ?? false}
      data-has-menu={hasMenu}
      data-disabled={triggerState.disabled}
      data-size={size ?? (accent ? "large" : "compact")}
      data-status={status ?? ""}
      disabled={triggerState.disabled}
      aria-busy={status === "pending" || status === "running" ? true : undefined}
      aria-pressed={actionType === "checkbox" ? Boolean(active) : undefined}
      aria-keyshortcuts={shortcut ? toAriaKeyShortcut(shortcut) : undefined}
      data-ribbon-toolbar-item="true"
      data-ribbon-action-id={id}
      tabIndex={-1}
      style={style}
      title={tooltipText}
      type="button"
      onClick={triggerState.runsActionFromButton ? runAction : undefined}
      onKeyDownCapture={
        triggerState.runsActionFromSplitBody ? runMenuActionFromKeyboard : undefined
      }
      onPointerDownCapture={
        triggerState.runsActionFromSplitBody ? runMenuActionFromPointer : undefined
      }
    >
      <span className="fm-ribbon-action__icon">
        {icon}
      </span>
      <span className="fm-ribbon-action__label">{label}</span>
      {status ? (
        <>
          <span aria-hidden="true" className="fm-ribbon-action__status" />
          <span className="sr-only">{statusText}</span>
        </>
      ) : null}
      {hasMenu ? (
        <ChevronDown
          className="fm-ribbon-action__chevron"
          data-ribbon-menu-trigger="true"
          size={11}
        />
      ) : null}
    </button>
  );

  const detailButton = activeCommandId ? (
    <button
      className="fm-ribbon-action-detail"
      data-ribbon-toolbar-item="true"
      title="Open active command detail"
      tabIndex={-1}
      type="button"
      onClick={() => onCommandDetail?.(activeCommandId)}
    >
      Detail
    </button>
  ) : null;

  const content = !hasMenu ? (
    trigger
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="fm-ribbon-menu">
        <RibbonMenuRenderer nodes={actionMenu ?? []} onCommand={onAction} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // A disabled action keeps a focusable, described shell so the reason is
  // reachable by keyboard and assistive technology, not only by hover.
  const wrappedContent = triggerState.disabled && tooltipText ? (
    <DisabledReason
      className={shellClassName}
      reason={tooltipText}
    >
      {content}
    </DisabledReason>
  ) : (
    <span className={shellClassName} title={tooltipText}>
      {content}
    </span>
  );

  return detailButton ? (
    <div className="fm-ribbon-action-stack">
      {wrappedContent}
      {detailButton}
    </div>
  ) : (
    wrappedContent
  );
}

function RibbonGroup({
  group,
  density,
  onAction,
  onCommandDetail,
}: {
  group: RibbonGroupData;
  density: RibbonDensity;
  onAction?: (actionId: string, input?: unknown) => void;
  onCommandDetail?: (commandId: string) => void;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const items = ribbonToolbarItems(toolbar);
    if (items.length === 0) return;
    const focused = items.find((item) => item === document.activeElement);
    const current = focused ?? items.find((item) => item.tabIndex === 0) ?? items[0];
    for (const item of items) item.tabIndex = item === current ? 0 : -1;
  }, [density, group.actions]);

  function handleToolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest(
        "input, textarea, select, [role='slider'], [role='menu'], [role='menuitem'], [data-radix-popper-content-wrapper]",
      )
    ) {
      return;
    }
    const items = ribbonToolbarItems(event.currentTarget);
    const currentIndex = items.findIndex(
      (item) => item === target || item.contains(target),
    );
    if (currentIndex < 0 || items.length === 0) return;

    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % items.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + items.length) % items.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    items.forEach((item, index) => {
      item.tabIndex = index === nextIndex ? 0 : -1;
    });
    items[nextIndex]?.focus();
  }

  return (
    <div
      ref={toolbarRef}
      className="fm-ribbon-group"
      data-group-id={group.id}
      data-tone={group.tone ?? "neutral"}
      data-category={categoryForRibbonGroup(group.tone)}
      aria-label={group.subtitle ? `${group.title}: ${group.subtitle}` : group.title}
      aria-orientation="horizontal"
      role="toolbar"
      onKeyDown={handleToolbarKeyDown}
    >
      {density === "collapsed" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`${group.title} actions`}
              className="fm-ribbon-group__collapsed-trigger"
              data-ribbon-toolbar-item="true"
              data-ribbon-action-id={`${group.id}:group-menu`}
              type="button"
              tabIndex={0}
            >
              <span>{group.title}</span>
              <ChevronDown aria-hidden="true" size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="fm-ribbon-menu">
            {group.actions.map((action) => (
              <Fragment key={action.id}>
                <RibbonMenuRenderer
                  nodes={actionToMenuNodes(action)}
                  onCommand={onAction}
                />
                {action.activeCommandId ? (
                  <DropdownMenuItem
                    onSelect={() => onCommandDetail?.(action.activeCommandId!)}
                  >
                    Open {action.label} details
                  </DropdownMenuItem>
                ) : null}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div
          className="fm-ribbon-group__actions"
          data-density={density}
        >
          {group.actions.map((action) => (
            <RibbonActionButton
              key={action.id}
              accent={action.accent}
              actionMenu={action.menu}
              active={action.active}
              activeCommandId={action.activeCommandId}
              actionType={action.type}
              disabled={action.disabled}
              icon={action.icon}
              id={action.id}
              commandId={action.commandId}
              commandInput={action.commandInput}
              iconColor={action.iconColor}
              label={action.label}
              size={action.size}
              shortcut={action.shortcut}
              status={action.status}
              splitButton={action.splitButton}
              tooltip={action.tooltip}
              onAction={onAction}
              onCommandDetail={onCommandDetail}
            />
          ))}
        </div>
      )}
      <div
        className="fm-ribbon-group__label"
        title={group.subtitle ? `${group.title} · ${group.subtitle}` : group.title}
      >
        <span>{group.title}</span>
        {group.subtitle ? <small>{group.subtitle}</small> : null}
      </div>
    </div>
  );
}

function categoryForRibbonGroup(
  tone: RibbonGroupData["tone"],
): "runtime" | "solver" | "magnetization" | "energy" | "ui" {
  switch (tone) {
    case "authoring":
    case "compose":
      return "solver";
    case "compute":
      return "runtime";
    case "selection":
      return "energy";
    case "sync":
      return "magnetization";
    default:
      return "ui";
  }
}

function ribbonToolbarItems(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(
    toolbar.querySelectorAll<HTMLElement>(
      'button[data-ribbon-toolbar-item="true"]:not(:disabled), .fm-ribbon-action-shell[data-disabled-reason]',
    ),
  );
}

function actionToMenuNodes(
  action: RibbonGroupData["actions"][number],
): RibbonMenuNode[] {
  if (action.menu?.length) {
    if (!action.splitButton) {
      return [
        {
          type: "submenu",
          id: `${action.id}:collapsed-menu`,
          label: action.label,
          disabled: action.disabled,
          tooltip: action.tooltip,
          nodes: [...actionStatusMenuNodes(action), ...action.menu],
        },
      ];
    }
    return [
      {
        type: "submenu",
        id: `${action.id}:collapsed-menu`,
        label: action.label,
        disabled: action.disabled,
        tooltip: action.tooltip,
        nodes: [
          actionMenuPrimaryNode(action),
          ...actionStatusMenuNodes(action),
          ...action.menu,
        ],
      },
    ];
  }
  return [actionMenuPrimaryNode(action), ...actionStatusMenuNodes(action)];
}

function actionStatusMenuNodes(
  action: RibbonGroupData["actions"][number],
): RibbonMenuNode[] {
  if (!action.status) return [];
  const tone =
    action.status === "failed"
      ? "danger"
      : action.status === "stale" || action.status === "degraded"
        ? "warning"
        : "neutral";
  return [
    {
      type: "status",
      id: `${action.id}:status`,
      label: "Command status",
      value: statusLabel(action.status),
      tone,
    },
  ];
}

function actionMenuPrimaryNode(
  action: RibbonGroupData["actions"][number],
): RibbonMenuNode {
  const commandId = action.commandId ?? action.id;
  if (action.type === "checkbox") {
    return {
      type: "checkbox",
      id: action.id,
      label: action.label,
      checked: Boolean(action.active),
      tooltip: action.tooltip,
      disabled: action.disabled,
      commandId,
      commandInput: action.commandInput,
    };
  }
  return {
    type: "item",
    id: action.id,
    label: action.label,
    icon: action.icon,
    shortcut: action.shortcut,
    tooltip: action.tooltip,
    disabled: action.disabled,
    commandId,
    commandInput: action.commandInput,
  };
}

function statusLabel(status: RibbonActionStatus | undefined): string {
  switch (status) {
    case "pending": return "Submitted; completion is not confirmed";
    case "running": return "Running";
    case "failed": return "Failed";
    case "stale": return "Stale resource";
    case "degraded": return "Degraded capability";
    default: return "";
  }
}

function toAriaKeyShortcut(shortcut: string): string {
  return shortcut
    .replace(/Ctrl/gi, "Control")
    .replace(/Cmd/gi, "Meta")
    .replace(/Alt/gi, "Alt")
    .replace(/Shift/gi, "Shift");
}

export function RibbonGroupsRow({
  groups,
  activeTabId,
  density = "full",
  onAction,
  onCommandDetail,
}: RibbonGroupsRowProps) {
  return (
    <div
      className="fm-ribbon__groups"
      data-density={density}
      role="tabpanel"
      id="fm-ribbon-tabpanel"
      aria-labelledby={activeTabId ? `fm-ribbon-tab-${activeTabId}` : undefined}
    >
      {groups.map((group) => (
        <RibbonGroup
          key={group.id}
          group={group}
          density={density}
          onAction={onAction}
          onCommandDetail={onCommandDetail}
        />
      ))}
    </div>
  );
}
