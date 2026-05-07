"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

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
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import type { RibbonMenuNode } from "@/features/shell/registry/ribbonMenuTypes";

export function RibbonMenuRenderer({ nodes }: { nodes: RibbonMenuNode[] }) {
  return <>{nodes.filter((node) => !node.hidden).map((node) => renderNode(node))}</>;
}

function renderNode(node: RibbonMenuNode): React.ReactNode {
  switch (node.type) {
    case "separator":
      return <DropdownMenuSeparator key={node.id} />;

    case "label":
      return (
        <DropdownMenuLabel key={node.id} className="flex items-center justify-between gap-2">
          <span>{node.label}</span>
          {node.badge ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              {node.badge}
            </span>
          ) : null}
        </DropdownMenuLabel>
      );

    case "status":
      return (
        <div
          key={node.id}
          className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs text-muted-foreground"
          title={node.disabledReason ?? node.description ?? undefined}
        >
          <span>{node.label}</span>
          <span
            className={cn(
              "font-medium",
              node.tone === "success" && "text-emerald-600",
              node.tone === "warning" && "text-amber-600",
              node.tone === "danger" && "text-red-600",
            )}
          >
            {node.value}
          </span>
        </div>
      );

    case "item":
      return (
        <DropdownMenuItem
          key={node.id}
          disabled={node.disabled}
          title={node.disabledReason ?? node.description ?? undefined}
          data-testid={node.testId}
          onSelect={(event) => {
            if (!node.action) return;
            event.preventDefault();
            node.action();
          }}
        >
          {node.icon ? (
            <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">
              {node.icon}
            </span>
          ) : null}
          <span className="flex-1">{node.label}</span>
          {node.state === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {node.state === "warning" ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
          ) : null}
          {node.shortcut ? <span className="text-xs text-muted-foreground">{node.shortcut}</span> : null}
        </DropdownMenuItem>
      );

    case "checkbox":
      return (
        <DropdownMenuCheckboxItem
          key={node.id}
          checked={node.checked === "indeterminate" ? false : node.checked}
          disabled={node.disabled}
          title={node.disabledReason ?? node.description ?? undefined}
          data-testid={node.testId}
          onCheckedChange={(value) => node.onCheckedChange(Boolean(value))}
          onSelect={(event) => event.preventDefault()}
        >
          <span className="flex-1">{node.label}</span>
          {node.checked === "indeterminate" ? (
            <span className="ml-auto text-[10px] uppercase text-muted-foreground">mixed</span>
          ) : null}
        </DropdownMenuCheckboxItem>
      );

    case "radio-group":
      return (
        <div key={node.id} data-testid={node.testId}>
          {node.label ? <DropdownMenuLabel>{node.label}</DropdownMenuLabel> : null}
          <DropdownMenuRadioGroup value={node.value} onValueChange={node.onValueChange}>
            {node.items.map((item) => (
              <DropdownMenuRadioItem
                key={`${node.id}:${item.value}`}
                value={item.value}
                disabled={node.disabled || item.disabled}
                title={item.disabledReason ?? item.description ?? undefined}
              >
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </div>
      );

    case "slider":
      const highlightStartPercent = node.highlightRange
        ? ((node.highlightRange.min - node.min) / Math.max(node.max - node.min, 1e-9)) * 100
        : 0;
      const highlightEndPercent = node.highlightRange
        ? ((node.highlightRange.max - node.min) / Math.max(node.max - node.min, 1e-9)) * 100
        : 0;
      return (
        <div
          key={node.id}
          className="px-2 py-2"
          title={node.disabledReason ?? node.description ?? undefined}
          data-testid={node.testId}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span>{node.label}</span>
            <span className="font-mono text-muted-foreground">
              {node.formatValue ? node.formatValue(node.value) : `${node.value}${node.unit ?? ""}`}
            </span>
          </div>
          {node.highlightRange ? (
            <div className="mb-2 h-1.5 rounded-full bg-muted/70">
              <div
                className="h-full rounded-full bg-emerald-400/80"
                style={{
                  marginLeft: `${Math.max(0, Math.min(100, highlightStartPercent))}%`,
                  width: `${Math.max(
                    0,
                    Math.min(100, highlightEndPercent) - Math.max(0, Math.min(100, highlightStartPercent)),
                  )}%`,
                }}
              />
            </div>
          ) : null}
          <Slider
            disabled={node.disabled}
            min={node.min}
            max={node.max}
            step={node.step}
            value={[node.value]}
            onValueChange={([value]) => node.onValueChange(value)}
            onValueCommit={([value]) => node.onValueCommit?.(value)}
          />
        </div>
      );

    case "color":
      return (
        <div
          key={node.id}
          className="flex items-center justify-between gap-3 px-2 py-2 text-sm"
          title={node.disabledReason ?? node.description ?? undefined}
          data-testid={node.testId}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span>{node.label}</span>
          <input
            type="color"
            disabled={node.disabled}
            value={node.value}
            onChange={(event) => node.onValueChange(event.currentTarget.value)}
            onBlur={(event) => node.onValueCommit?.(event.currentTarget.value)}
            className="h-7 w-9 rounded border bg-transparent"
          />
        </div>
      );

    case "submenu":
      return (
        <DropdownMenuSub key={node.id}>
          <DropdownMenuSubTrigger
            disabled={node.disabled}
            title={node.disabledReason ?? node.description ?? undefined}
          >
            {node.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <RibbonMenuRenderer nodes={node.nodes} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
  }
}
