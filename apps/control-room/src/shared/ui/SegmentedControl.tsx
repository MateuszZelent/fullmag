import type { KeyboardEvent } from "react";

import { cn } from "@/shared/utils/className";

export interface SegmentedControlOption<T extends string> {
  disabled?: boolean;
  label: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> {
  "aria-label": string;
  className?: string;
  disabled?: boolean;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  className,
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
        "grid min-w-0 auto-cols-fr grid-flow-col rounded-fm-control border border-fm-subtle bg-fm-disabled p-0.5",
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
            aria-checked={checked}
            aria-disabled={itemDisabled || undefined}
            className={cn(
              "min-h-fm-control-sm min-w-0 rounded-[calc(var(--fm-radius-control)-2px)] px-2 py-1",
              "font-fm-ui text-fm-control leading-tight outline-none",
              "transition-[background-color,color,box-shadow] duration-150",
              "hover:bg-fm-raised focus-visible:ring-2 focus-visible:ring-fm-accent",
              checked
                ? "bg-fm-accent-soft font-medium text-fm-accent"
                : "bg-transparent text-fm-secondary",
              itemDisabled &&
                "cursor-not-allowed bg-transparent text-fm-disabled-text opacity-100",
            )}
            data-slot="segmented-control-item"
            data-state={checked ? "checked" : "unchecked"}
            data-value={option.value}
            disabled={itemDisabled}
            key={option.value}
            role="radio"
            tabIndex={checked && !itemDisabled ? 0 : -1}
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
