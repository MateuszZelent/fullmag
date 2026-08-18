"use client";

import { ChevronDown } from "lucide-react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import { ICON_COLOR_ALIASES } from "./ribbonCommon";
import { RibbonMenuRenderer } from "./RibbonMenuRenderer";
import type { RibbonGroup as RibbonGroupData } from "./ribbonTypes";

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
  const tooltipText = tooltip ?? label;
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
      disabled={triggerState.disabled}
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
      title="Open active command detail"
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
  const wrappedContent = (
    <span className="fm-ribbon-action-shell" title={tooltipText}>
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
  onAction,
  onCommandDetail,
}: {
  group: RibbonGroupData;
  onAction?: (actionId: string, input?: unknown) => void;
  onCommandDetail?: (commandId: string) => void;
}) {
  return (
    <div
      className="fm-ribbon-group"
      data-group-id={group.id}
      data-tone={group.tone ?? "neutral"}
    >
      <div className="fm-ribbon-group__actions">
        {group.actions.map((action) => (
          <RibbonActionButton
            key={action.id}
            accent={action.accent}
            actionMenu={action.menu}
            active={action.active}
            activeCommandId={action.activeCommandId}
            disabled={action.disabled}
            icon={action.icon}
            id={action.id}
            commandId={action.commandId}
            commandInput={action.commandInput}
            iconColor={action.iconColor}
            label={action.label}
            splitButton={action.splitButton}
            tooltip={action.tooltip}
            onAction={onAction}
            onCommandDetail={onCommandDetail}
          />
        ))}
      </div>
      <div className="fm-ribbon-group__label">
        <span>{group.title}</span>
        {group.subtitle ? <small>{group.subtitle}</small> : null}
      </div>
    </div>
  );
}

export function RibbonGroupsRow({
  groups,
  activeTabId,
  onAction,
  onCommandDetail,
}: RibbonGroupsRowProps) {
  return (
    <div
      className="fm-ribbon__groups"
      role="tabpanel"
      id="fm-ribbon-tabpanel"
      aria-labelledby={activeTabId ? `fm-ribbon-tab-${activeTabId}` : undefined}
    >
      {groups.map((group) => (
        <RibbonGroup
          key={group.id}
          group={group}
          onAction={onAction}
          onCommandDetail={onCommandDetail}
        />
      ))}
    </div>
  );
}
