"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva("fm-tabs-list", {
  variants: {
    presentation: {
      line: "fm-tabs-list--line",
      segmented: "fm-tabs-list--segmented",
    },
  },
  defaultVariants: {
    presentation: "line",
  },
});

type TabsListProps = ComponentPropsWithRef<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>;

function TabsList({
  className,
  presentation,
  ref,
  ...props
}: TabsListProps) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(tabsListVariants({ presentation }), className)}
      data-presentation={presentation ?? "line"}
      data-slot="tabs-list"
      {...props}
    />
  );
}
TabsList.displayName = TabsPrimitive.List.displayName;

function TabsTrigger({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "fm-tabs-trigger",
        className,
      )}
      data-slot="tabs-trigger"
      {...props}
    />
  );
}
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

function TabsContent({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("fm-tabs-content", className)}
      data-slot="tabs-content"
      {...props}
    />
  );
}
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
