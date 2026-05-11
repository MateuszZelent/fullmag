"use client";

import type { ReactNode } from "react";

import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/shared/ui/DropdownMenu";

import type { RibbonMenuNode } from "./ribbonTypes";

export function RibbonMenuRenderer({ nodes }: { nodes: RibbonMenuNode[] }) {
  return <>{nodes.map((node) => renderNode(node))}</>;
}

function renderNode(node: RibbonMenuNode): ReactNode {
  switch (node.type) {
    case "label":
      return (
        <DropdownMenuLabel key={node.id}>
          <span>{node.label}</span>
          {node.badge ? (
            <span className="fm-dropdown-badge">{node.badge}</span>
          ) : null}
        </DropdownMenuLabel>
      );

    case "separator":
      return <DropdownMenuSeparator key={node.id} />;

    case "item":
      return (
        <DropdownMenuItem key={node.id} disabled={node.disabled}>
          {node.icon}
          <span>{node.label}</span>
          {node.shortcut ? (
            <span className="fm-dropdown-shortcut">{node.shortcut}</span>
          ) : null}
        </DropdownMenuItem>
      );

    case "checkbox":
      return (
        <DropdownMenuCheckboxItem
          key={node.id}
          checked={node.checked}
          disabled={node.disabled}
          onCheckedChange={() => undefined}
          onSelect={(event) => event.preventDefault()}
        >
          {node.label}
        </DropdownMenuCheckboxItem>
      );

    case "radio-group":
      return (
        <div key={node.id}>
          {node.label ? <DropdownMenuLabel>{node.label}</DropdownMenuLabel> : null}
          <DropdownMenuRadioGroup
            value={node.value}
            onValueChange={() => undefined}
          >
            {node.items.map((item) => (
              <DropdownMenuRadioItem
                key={`${node.id}:${item.value}`}
                disabled={node.disabled || item.disabled}
                value={item.value}
              >
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
      );

    case "status":
      return (
        <div
          key={node.id}
          className="fm-ribbon-menu-status"
          data-tone={node.tone ?? "neutral"}
        >
          <span>{node.label}</span>
          <span>{node.value}</span>
        </div>
      );

    case "submenu":
      return (
        <DropdownMenuSub key={node.id}>
          <DropdownMenuSubTrigger disabled={node.disabled}>
            {node.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <RibbonMenuRenderer nodes={node.nodes} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
  }
}
