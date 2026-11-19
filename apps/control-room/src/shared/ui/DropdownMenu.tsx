"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import {
  type ComponentPropsWithRef,
  type KeyboardEvent as ReactKeyboardEvent,
  useId,
} from "react";

import { cn } from "@/shared/utils/className";

/** Keep menus clear of viewport edges when Radix flips/shifts them. */
const MENU_COLLISION_PADDING = 8;

/**
 * Embedded form controls own their keys: without this, the Radix menu
 * typeahead and arrow navigation steal characters and arrows from the input.
 * Escape and Tab still reach the menu so it can close / release focus.
 */
function keepKeysInControl(event: ReactKeyboardEvent) {
  if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
}

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuSubTrigger({
  children,
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "fm-dropdown-item fm-dropdown-sub-trigger",
        inset && "fm-dropdown-item--inset",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="fm-dropdown-item__chevron" aria-hidden="true" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}
DropdownMenuSubTrigger.displayName =
  DropdownMenuPrimitive.SubTrigger.displayName;

function DropdownMenuSubContent({
  className,
  collisionPadding = MENU_COLLISION_PADDING,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn("fm-dropdown-content", className)}
      {...props}
    />
  );
}
DropdownMenuSubContent.displayName =
  DropdownMenuPrimitive.SubContent.displayName;

function DropdownMenuContent({
  className,
  collisionPadding = MENU_COLLISION_PADDING,
  ref,
  sideOffset = 4,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        collisionPadding={collisionPadding}
        sideOffset={sideOffset}
        className={cn("fm-dropdown-content", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

function DropdownMenuItem({
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn(
        "fm-dropdown-item",
        inset && "fm-dropdown-item--inset",
        className,
      )}
      {...props}
    />
  );
}
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

function DropdownMenuCheckboxItem({
  children,
  className,
  checked,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      className={cn("fm-dropdown-item fm-dropdown-check-item", className)}
      {...props}
    >
      <span className="fm-dropdown-item__indicator">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check size={14} aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}
DropdownMenuCheckboxItem.displayName =
  DropdownMenuPrimitive.CheckboxItem.displayName;

function DropdownMenuRadioItem({
  children,
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn("fm-dropdown-item fm-dropdown-check-item", className)}
      {...props}
    >
      <span className="fm-dropdown-item__indicator">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle size={7} fill="currentColor" aria-hidden="true" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}
DropdownMenuRadioItem.displayName =
  DropdownMenuPrimitive.RadioItem.displayName;

function DropdownMenuLabel({
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      ref={ref}
      className={cn(
        "fm-dropdown-label",
        inset && "fm-dropdown-item--inset",
        className,
      )}
      {...props}
    />
  );
}
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

function DropdownMenuSeparator({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      className={cn("fm-dropdown-separator", className)}
      {...props}
    />
  );
}
DropdownMenuSeparator.displayName =
  DropdownMenuPrimitive.Separator.displayName;

/* ── Extended dropdown items ── */

interface DropdownMenuSliderItemProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
}

function DropdownMenuSliderItem({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  className,
}: DropdownMenuSliderItemProps) {
  const labelId = useId();
  return (
    <div
      className={cn("fm-dropdown-slider", className)}
      onKeyDown={keepKeysInControl}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="fm-dropdown-slider__label" id={labelId}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-labelledby={labelId}
        className="fm-dropdown-slider__input"
      />
      <span className="fm-dropdown-slider__value">{value}</span>
    </div>
  );
}

interface DropdownMenuColorItemProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

function DropdownMenuColorItem({
  label,
  value,
  onChange,
  className,
}: DropdownMenuColorItemProps) {
  const labelId = useId();
  return (
    <div
      className={cn("fm-dropdown-color", className)}
      onKeyDown={keepKeysInControl}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="fm-dropdown-color__label" id={labelId}>{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-labelledby={labelId}
        className="fm-dropdown-color__input"
      />
    </div>
  );
}

interface DropdownMenuTextItemProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function DropdownMenuTextItem({
  label,
  value,
  onChange,
  placeholder,
  className,
}: DropdownMenuTextItemProps) {
  const labelId = useId();
  return (
    <div
      className={cn("fm-dropdown-text", className)}
      onKeyDown={keepKeysInControl}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="fm-dropdown-text__label" id={labelId}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-labelledby={labelId}
        className="fm-dropdown-text__input"
      />
    </div>
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuColorItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSliderItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTextItem,
  DropdownMenuTrigger,
};
