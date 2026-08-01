"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import type { VariantProps } from "class-variance-authority";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/shared/utils/className";
import { controlVariants } from "@/shared/ui/controlVariants";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

type SelectTriggerProps = React.ComponentPropsWithoutRef<
  typeof SelectPrimitive.Trigger
> &
  VariantProps<typeof controlVariants>;

export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, children, density, invalid, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "fm-select-trigger",
      controlVariants({ density, invalid }),
      "w-full justify-between",
      className,
    )}
    data-slot="select-trigger"
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown size={14} className="opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectScrollUpButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn(
      "fm-select-scroll-button",
      className
    )}
    data-slot="select-scroll-up-button"
    {...props}
  >
    <ChevronUp size={14} />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

export const SelectScrollDownButton = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn(
      "fm-select-scroll-button",
      className
    )}
    data-slot="select-scroll-down-button"
    {...props}
  >
    <ChevronDown size={14} />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        "fm-select-content",
        position === "popper" && "fm-select-content--popper",
        className
      )}
      data-slot="select-content"
      position={position}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn(
          "fm-select-viewport",
          position === "popper" && "fm-select-viewport--popper"
        )}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn("fm-select-label", className)}
    data-slot="select-label"
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn("fm-select-item", className)}
    data-slot="select-item"
    {...props}
  >
    <span className="fm-select-item__indicator">
      <SelectPrimitive.ItemIndicator>
        <Check size={14} />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn("fm-select-separator", className)}
    data-slot="select-separator"
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;
