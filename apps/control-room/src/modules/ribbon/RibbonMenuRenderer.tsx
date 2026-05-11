"use client";

import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
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
        <DropdownMenuItem
          key={node.id}
          disabled={node.disabled}
          onSelect={node.onSelect}
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
          onCheckedChange={(checked) => node.onCheckedChange?.(Boolean(checked))}
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
            onValueChange={(value) => node.onValueChange?.(value)}
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

    case "slider":
      return <SliderMenuItem key={`${node.id}:${node.value}`} node={node} />;

    case "color":
      return <ColorMenuItem key={node.id} node={node} />;
  }
}

// ── Slider ────────────────────────────────────────────────────────────────────
type SliderNode = Extract<RibbonMenuNode, { type: "slider" }>;

function SliderMenuItem({ node }: { node: SliderNode }) {
  const [val, setVal] = useState(node.value);
  const pct = ((val - node.min) / (node.max - node.min)) * 100;

  return (
    <div
      className={`fm-dropdown-slider${node.disabled ? " fm-dropdown-slider--disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fm-dropdown-slider__header">
        <span className="fm-dropdown-slider__label">{node.label}</span>
        <span className="fm-dropdown-slider__value">
          {Number.isInteger(node.step) ? Math.round(val) : val.toFixed(1)}
          {node.unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        className="fm-dropdown-slider__track"
        min={node.min}
        max={node.max}
        step={node.step}
        value={val}
        disabled={node.disabled}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        onChange={(e) => {
          const next = Number(e.target.value);
          setVal(next);
          node.onValueChange?.(next);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── Color picker ──────────────────────────────────────────────────────────────
type ColorNode = Extract<RibbonMenuNode, { type: "color" }>;

function ColorMenuItem({ node }: { node: ColorNode }) {
  const [color, setColor] = useState(node.value);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSwatchClick = useCallback(
    (e: React.MouseEvent) => {
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
        style={{ background: color }}
        onClick={handleSwatchClick}
        role="button"
        aria-label={`Pick color: ${node.label}`}
        tabIndex={node.disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleSwatchClick(e as unknown as React.MouseEvent);
        }}
      >
        <input
          ref={inputRef}
          type="color"
          className="fm-dropdown-color__input"
          value={color}
          disabled={node.disabled}
          tabIndex={-1}
          onChange={(e) => setColor(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </span>
    </div>
  );
}
