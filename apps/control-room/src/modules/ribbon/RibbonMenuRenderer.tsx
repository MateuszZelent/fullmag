"use client";

import {
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";

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

export function RibbonMenuRenderer({
  nodes,
  onCommand,
}: {
  nodes: RibbonMenuNode[];
  onCommand?: (commandId: string, input?: unknown) => void;
}) {
  return <>{nodes.map((node) => renderNode(node, onCommand))}</>;
}

function renderNode(
  node: RibbonMenuNode,
  onCommand?: (commandId: string, input?: unknown) => void,
): ReactNode {
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
        <DropdownMenuItem
          key={node.id}
          disabled={node.disabled}
          onSelect={() => {
            onCommand?.(node.commandId ?? node.id, node.commandInput);
          }}
        >
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
          onCheckedChange={(checked) => {
            const next = Boolean(checked);
            if (node.commandId) {
              onCommand?.(
                node.commandId,
                resolveCommandInput(node.commandInput, next),
              );
              return;
            }
            onCommand?.(node.id, resolveCommandInput(node.commandInput, next));
          }}
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
            onValueChange={(value) => {
              const item = node.items.find((entry) => entry.value === value);
              if (item?.commandId) {
                onCommand?.(
                  item.commandId,
                  item.commandInput ??
                    resolveCommandInput(node.commandInput, value),
                );
                return;
              }
              if (node.commandId) {
                onCommand?.(
                  node.commandId,
                  resolveCommandInput(node.commandInput, value),
                );
                return;
              }
              onCommand?.(node.id, resolveCommandInput(node.commandInput, value));
            }}
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
            <RibbonMenuRenderer nodes={node.nodes} onCommand={onCommand} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );

    case "slider":
      return (
        <SliderMenuItem
          key={`${node.id}:${node.value}`}
          node={node}
          onCommand={onCommand}
        />
      );

    case "color":
      return <ColorMenuItem key={node.id} node={node} onCommand={onCommand} />;
  }
}

function resolveCommandInput<T>(
  input: unknown | ((value: T) => unknown),
  value: T,
): unknown {
  return typeof input === "function"
    ? (input as (value: T) => unknown)(value)
    : input ?? value;
}

// ── Slider ────────────────────────────────────────────────────────────────────
type SliderNode = Extract<RibbonMenuNode, { type: "slider" }>;

function SliderMenuItem({
  node,
  onCommand,
}: {
  node: SliderNode;
  onCommand?: (commandId: string, input?: unknown) => void;
}) {
  const pct = ((node.value - node.min) / (node.max - node.min)) * 100;

  return (
    <div
      className={`fm-dropdown-slider${node.disabled ? " fm-dropdown-slider--disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fm-dropdown-slider__header">
        <span className="fm-dropdown-slider__label">{node.label}</span>
        <span className="fm-dropdown-slider__value">
          {Number.isInteger(node.step) ? Math.round(node.value) : node.value.toFixed(1)}
          {node.unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        className="fm-dropdown-slider__track"
        min={node.min}
        max={node.max}
        step={node.step}
        value={node.value}
        disabled={node.disabled}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (node.commandId) {
            onCommand?.(
              node.commandId,
              resolveCommandInput(node.commandInput, next),
            );
            return;
          }
          onCommand?.(node.id, resolveCommandInput(node.commandInput, next));
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── Color picker ──────────────────────────────────────────────────────────────
type ColorNode = Extract<RibbonMenuNode, { type: "color" }>;

function ColorMenuItem({
  node,
  onCommand,
}: {
  node: ColorNode;
  onCommand?: (commandId: string, input?: unknown) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerValue = isColorPickerValue(node.value)
    ? node.value
    : colorInputValue(255, 255, 255);

  const handleSwatchClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (!node.disabled) inputRef.current?.click();
    },
    [node.disabled],
  );

  return (
    <div
      className={`fm-dropdown-color${node.disabled ? " fm-dropdown-color--disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="fm-dropdown-color__label">{node.label}</span>
      <span
        className="fm-dropdown-color__swatch"
        style={{ background: node.value }}
        onClick={handleSwatchClick}
        role="button"
        aria-label={`Pick color: ${node.label}`}
        tabIndex={node.disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            if (!node.disabled) inputRef.current?.click();
          }
        }}
      >
        <input
          ref={inputRef}
          type="color"
          className="fm-dropdown-color__input"
          value={pickerValue}
          disabled={node.disabled}
          readOnly={!node.commandId}
          tabIndex={-1}
          onChange={(e) => {
            const next = e.target.value;
            if (node.commandId) {
              onCommand?.(
                node.commandId,
                resolveCommandInput(node.commandInput, next),
              );
              return;
            }
            onCommand?.(node.id, resolveCommandInput(node.commandInput, next));
          }}
          onClick={(e) => e.stopPropagation()}
        />
      </span>
    </div>
  );
}

function isColorPickerValue(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function colorInputValue(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}
