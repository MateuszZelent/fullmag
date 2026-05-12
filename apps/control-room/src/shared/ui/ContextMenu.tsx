"use client";

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import {
  type ComponentPropsWithRef,
} from "react";

import { cn } from "@/shared/utils/className";

const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
const ContextMenuGroup = ContextMenuPrimitive.Group;
const ContextMenuPortal = ContextMenuPrimitive.Portal;
const ContextMenuSub = ContextMenuPrimitive.Sub;
const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;

function ContextMenuSubTrigger({
  children,
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        "fm-context-menu-item fm-context-menu-sub-trigger",
        inset && "fm-context-menu-item--inset",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="fm-context-menu-item__chevron" aria-hidden="true" />
    </ContextMenuPrimitive.SubTrigger>
  );
}
ContextMenuSubTrigger.displayName = ContextMenuPrimitive.SubTrigger.displayName;

function ContextMenuSubContent({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      ref={ref}
      className={cn("fm-context-menu-content", className)}
      {...props}
    />
  );
}
ContextMenuSubContent.displayName = ContextMenuPrimitive.SubContent.displayName;

function ContextMenuContent({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        className={cn("fm-context-menu-content", className)}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName;

function ContextMenuItem({
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        "fm-context-menu-item",
        inset && "fm-context-menu-item--inset",
        className,
      )}
      {...props}
    />
  );
}
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName;

function ContextMenuCheckboxItem({
  children,
  className,
  checked,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      ref={ref}
      checked={checked}
      className={cn("fm-context-menu-item fm-context-menu-check-item", className)}
      {...props}
    >
      <span className="fm-context-menu-item__indicator">
        <ContextMenuPrimitive.ItemIndicator>
          <Check size={14} aria-hidden="true" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}
ContextMenuCheckboxItem.displayName =
  ContextMenuPrimitive.CheckboxItem.displayName;

function ContextMenuRadioItem({
  children,
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      ref={ref}
      className={cn("fm-context-menu-item fm-context-menu-check-item", className)}
      {...props}
    >
      <span className="fm-context-menu-item__indicator">
        <ContextMenuPrimitive.ItemIndicator>
          <Circle size={7} fill="currentColor" aria-hidden="true" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  );
}
ContextMenuRadioItem.displayName = ContextMenuPrimitive.RadioItem.displayName;

function ContextMenuLabel({
  className,
  inset,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.Label
      ref={ref}
      className={cn(
        "fm-context-menu-label",
        inset && "fm-context-menu-item--inset",
        className,
      )}
      {...props}
    />
  );
}
ContextMenuLabel.displayName = ContextMenuPrimitive.Label.displayName;

function ContextMenuSeparator({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      className={cn("fm-context-menu-separator", className)}
      {...props}
    />
  );
}
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName;

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
