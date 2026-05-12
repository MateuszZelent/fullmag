"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import {
  type ComponentPropsWithRef,
} from "react";

import { cn } from "@/shared/utils/className";

function Command({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive>) {
  return (
  <CommandPrimitive ref={ref} className={cn("fm-command", className)} {...props} />
  );
}
Command.displayName = CommandPrimitive.displayName;

function CommandInput({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Input>) {
  return (
    <div className="fm-command-input-wrap">
      <Search size={14} aria-hidden="true" />
      <CommandPrimitive.Input
        ref={ref}
        className={cn("fm-command-input", className)}
        {...props}
      />
    </div>
  );
}
CommandInput.displayName = CommandPrimitive.Input.displayName;

function CommandList({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn("fm-command-list", className)}
      {...props}
    />
  );
}
CommandList.displayName = CommandPrimitive.List.displayName;

function CommandEmpty({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn("fm-command-empty", className)}
      {...props}
    />
  );
}
CommandEmpty.displayName = CommandPrimitive.Empty.displayName;

function CommandGroup({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      ref={ref}
      className={cn("fm-command-group", className)}
      {...props}
    />
  );
}
CommandGroup.displayName = CommandPrimitive.Group.displayName;

function CommandItem({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn("fm-command-item", className)}
      {...props}
    />
  );
}
CommandItem.displayName = CommandPrimitive.Item.displayName;

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
};
