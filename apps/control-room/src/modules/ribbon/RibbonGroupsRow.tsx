"use client";

import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import { RibbonMenuRenderer } from "./RibbonMenuRenderer";
import type { RibbonGroup as RibbonGroupData } from "./ribbonTypes";

interface RibbonGroupsRowProps {
  groups: RibbonGroupData[];
  onAction?: (actionId: string) => void;
}

function RibbonActionButton({
  actionMenu,
  id,
  icon,
  label,
  disabled,
  active,
  accent,
  tooltip,
  iconColor,
  onAction,
}: {
  actionMenu?: RibbonGroupData["actions"][number]["menu"];
  id: string;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
  tooltip?: string;
  iconColor?: string;
  onAction?: (actionId: string) => void;
}) {
  const hasMenu = Boolean(actionMenu?.length);
  const isTriggerDisabled = Boolean(disabled && !hasMenu);
  const trigger = (
    <button
      className="fm-ribbon-action"
      data-action-id={id}
      data-active={active ?? false}
      data-accent={accent ?? false}
      data-has-menu={hasMenu}
      data-disabled={isTriggerDisabled}
      disabled={isTriggerDisabled}
      title={tooltip ?? label}
      type="button"
      onClick={() => onAction?.(id)}
    >
      <span
        className="fm-ribbon-action__icon"
        style={!active && iconColor ? { color: iconColor } : undefined}
      >
        {icon}
      </span>
      <span className="fm-ribbon-action__label">{label}</span>
      {hasMenu ? (
        <ChevronDown className="fm-ribbon-action__chevron" size={11} />
      ) : null}
    </button>
  );

  if (!hasMenu) {
    return trigger;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="fm-ribbon-menu">
        <RibbonMenuRenderer nodes={actionMenu ?? []} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RibbonGroup({
  group,
  onAction,
}: {
  group: RibbonGroupData;
  onAction?: (actionId: string) => void;
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
            disabled={action.disabled}
            icon={action.icon}
            id={action.id}
            iconColor={action.iconColor}
            label={action.label}
            tooltip={action.tooltip}
            onAction={onAction}
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

export function RibbonGroupsRow({ groups, onAction }: RibbonGroupsRowProps) {
  return (
    <div className="fm-ribbon__groups" role="tabpanel">
      {groups.map((group) => (
        <RibbonGroup key={group.id} group={group} onAction={onAction} />
      ))}
    </div>
  );
}
