"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
          title={node.tooltip}
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
          <DropdownMenuRadioGroup value={node.value}>
            {node.items.map((item) => (
              <DropdownMenuRadioItem
                key={`${node.id}:${item.value}`}
                disabled={node.disabled || item.disabled}
                value={item.value}
                onSelect={() => {
                  if (item.value === node.value) return;
                  runRadioCommand(node, item.value, onCommand);
                }}
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
          key={node.id}
          node={node}
          onCommand={onCommand}
        />
      );

    case "color":
      return <ColorMenuItem key={node.id} node={node} onCommand={onCommand} />;

    case "text":
      return <TextMenuItem key={node.id} node={node} onCommand={onCommand} />;
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

function runRadioCommand(
  node: Extract<RibbonMenuNode, { type: "radio-group" }>,
  value: string,
  onCommand?: (commandId: string, input?: unknown) => void,
): void {
  const item = node.items.find((entry) => entry.value === value);
  if (item?.commandId) {
    onCommand?.(
      item.commandId,
      item.commandInput ?? resolveCommandInput(node.commandInput, value),
    );
    return;
  }
  if (node.commandId) {
    onCommand?.(node.commandId, resolveCommandInput(node.commandInput, value));
    return;
  }
  onCommand?.(node.id, resolveCommandInput(node.commandInput, value));
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
  const [draftState, setDraftState] = useState<{
    sourceValue: number;
    value: number;
  } | null>(null);
  const { flushSliderCommand, stageSliderCommand } = useDraftSliderCommand(
    node,
    onCommand,
  );
  const draftValue =
    draftState?.sourceValue === node.value ? draftState.value : node.value;

  const pct = ((draftValue - node.min) / (node.max - node.min)) * 100;

  return (
    <div
      className={`fm-dropdown-slider${node.disabled ? " fm-dropdown-slider--disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="fm-dropdown-slider__header">
        <span className="fm-dropdown-slider__label">{node.label}</span>
        <span className="fm-dropdown-slider__value">
          {Number.isInteger(node.step) ? Math.round(draftValue) : draftValue.toFixed(1)}
          {node.unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        className="fm-dropdown-slider__track"
        min={node.min}
        max={node.max}
        step={node.step}
        value={draftValue}
        disabled={node.disabled}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        onChange={(e) => {
          const next = Number(e.target.value);
          setDraftState({ sourceValue: node.value, value: next });
          stageSliderCommand(next);
        }}
        onPointerUp={flushSliderCommand}
        onPointerCancel={flushSliderCommand}
        onBlur={flushSliderCommand}
        onKeyUp={flushSliderCommand}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function useDraftSliderCommand(
  node: SliderNode,
  onCommand?: (commandId: string, input?: unknown) => void,
): {
  flushSliderCommand: () => void;
  stageSliderCommand: (value: number) => void;
} {
  const commandRef = useRef({ node, onCommand });
  const dirtyRef = useRef(false);
  const latestValueRef = useRef(node.value);

  useEffect(() => {
    commandRef.current = { node, onCommand };
  }, [node, onCommand]);

  const emitSliderCommand = useCallback((value: number) => {
    const { node: currentNode, onCommand: currentOnCommand } = commandRef.current;
    if (currentNode.commandId) {
      currentOnCommand?.(
        currentNode.commandId,
        resolveCommandInput(currentNode.commandInput, value),
      );
      return;
    }
    currentOnCommand?.(
      currentNode.id,
      resolveCommandInput(currentNode.commandInput, value),
    );
  }, []);

  const flushSliderCommand = useCallback(() => {
    if (!dirtyRef.current) return;
    const value = latestValueRef.current;
    dirtyRef.current = false;
    emitSliderCommand(value);
  }, [emitSliderCommand]);

  const stageSliderCommand = useCallback(
    (value: number) => {
      dirtyRef.current = true;
      latestValueRef.current = value;
    },
    [],
  );

  useEffect(
    () => () => {
      const shouldFlush = dirtyRef.current;
      const value = latestValueRef.current;
      if (!shouldFlush) return;
      dirtyRef.current = false;
      emitSliderCommand(value);
    },
    [emitSliderCommand],
  );

  return { flushSliderCommand, stageSliderCommand };
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

// ── Text input ────────────────────────────────────────────────────────────────
type TextNode = Extract<RibbonMenuNode, { type: "text" }>;

function TextMenuItem({
  node,
  onCommand,
}: {
  node: TextNode;
  onCommand?: (commandId: string, input?: unknown) => void;
}) {
  const [draftState, setDraftState] = useState<{
    sourceValue: string;
    value: string;
  } | null>(null);
  const draft =
    draftState?.sourceValue === node.value ? draftState.value : node.value;

  const commit = useCallback(() => {
    const value = draft.trim();
    if (value === node.value) return;
    if (node.commandId) {
      onCommand?.(node.commandId, resolveCommandInput(node.commandInput, value));
      return;
    }
    onCommand?.(node.id, resolveCommandInput(node.commandInput, value));
  }, [draft, node, onCommand]);

  return (
    <label
      className={`fm-dropdown-text${node.disabled ? " fm-dropdown-text--disabled" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="fm-dropdown-text__label">{node.label}</span>
      <input
        className="fm-dropdown-text__input"
        disabled={node.disabled}
        placeholder={node.placeholder}
        value={draft}
        onBlur={commit}
        onChange={(event) =>
          setDraftState({
            sourceValue: node.value,
            value: event.target.value,
          })
        }
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
