import type { KeyboardEvent } from "react";

import { cn } from "@/shared/utils/className";

export interface SegmentedControlOption<T extends string> {
  accessibleLabel?: string;
  disabled?: boolean;
  label: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> {
  "aria-label": string;
  className?: string;
  columns?: 2 | 3 | 4;
  disabled?: boolean;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  className,
  columns,
  disabled = false,
  options,
  value,
  onValueChange,
}: SegmentedControlProps<T>) {
  function selectByKeyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ): void {
    const enabledIndexes = options.flatMap((option, index) =>
      option.disabled ? [] : [index],
    );
    if (disabled || enabledIndexes.length === 0) return;

    let nextIndex: number | undefined;
    if (event.key === "Home") {
      nextIndex = enabledIndexes[0];
    } else if (event.key === "End") {
      nextIndex = enabledIndexes.at(-1);
    } else if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) {
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      const enabledPosition = Math.max(0, enabledIndexes.indexOf(currentIndex));
      nextIndex =
        enabledIndexes[
          (enabledPosition + direction + enabledIndexes.length) %
            enabledIndexes.length
        ];
    }

    if (nextIndex === undefined) return;
    const nextOption = options[nextIndex];
    if (!nextOption) return;

    event.preventDefault();
    onValueChange(nextOption.value);
    const items = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[data-slot="segmented-control-item"]',
    );
    items?.[nextIndex]?.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        "grid min-w-0 gap-0.5 rounded-[var(--fm-radius-segment)] border border-fm-subtle bg-fm-disabled p-0.5 shadow-[var(--fm-shadow-control-inset)]",
        columns === 2 && "grid-cols-2",
        columns === 3 && "grid-cols-3",
        columns === 4 && "grid-cols-4",
        columns === undefined && "auto-cols-fr grid-flow-col",
        className,
      )}
      data-disabled={disabled || undefined}
      data-slot="segmented-control"
      role="radiogroup"
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        const itemDisabled = disabled || Boolean(option.disabled);

        return (
          <button
            aria-label={option.accessibleLabel}
            aria-checked={checked}
            aria-disabled={itemDisabled || undefined}
            className={cn(
              "h-fm-control-sm min-w-0 rounded-[var(--fm-radius-segment)] px-2",
              "font-fm-ui text-fm-control leading-tight outline-none",
              "transition-[transform,background-color,color,box-shadow] duration-150",
              "active:scale-[0.98] motion-reduce:active:scale-100",
              "hover:bg-fm-raised focus-visible:ring-2 focus-visible:ring-fm-accent",
              checked
                ? "bg-fm-accent font-medium text-fm-inverse shadow-[var(--fm-shadow-control)]"
                : "bg-transparent text-fm-secondary",
              itemDisabled &&
                "cursor-not-allowed bg-transparent text-fm-disabled-text opacity-100 active:scale-100",
            )}
            data-slot="segmented-control-item"
            data-state={checked ? "checked" : "unchecked"}
            data-value={option.value}
            disabled={itemDisabled}
            key={option.value}
            role="radio"
            tabIndex={checked && !itemDisabled ? 0 : -1}
            title={option.accessibleLabel}
            type="button"
            onClick={() => {
              if (!itemDisabled) onValueChange(option.value);
            }}
            onKeyDown={(event) => selectByKeyboard(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
