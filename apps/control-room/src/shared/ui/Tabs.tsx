"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

const Tabs = TabsPrimitive.Root;

const tabsListVariants = cva("fm-tabs-list flex min-w-0 items-center", {
  variants: {
    presentation: {
      line: "gap-1 border-b border-fm-subtle",
      segmented:
        "gap-0.5 rounded-fm-control border border-fm-subtle bg-fm-disabled p-0.5",
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
        "fm-tabs-trigger inline-flex h-fm-control-sm min-w-0 items-center justify-center rounded-fm-control border border-transparent px-2 font-fm-ui text-fm-control font-medium text-fm-muted outline-none transition-colors hover:bg-fm-disabled hover:text-fm-primary focus-visible:ring-2 focus-visible:ring-fm-accent data-[state=active]:border-fm-border data-[state=active]:bg-fm-selected data-[state=active]:text-fm-accent disabled:cursor-not-allowed disabled:text-fm-disabled-text disabled:opacity-100",
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
