"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  type ComponentPropsWithRef,
} from "react";

import { cn } from "@/shared/utils/className";

const Tabs = TabsPrimitive.Root;

function TabsList({
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List ref={ref} className={cn("fm-tabs-list", className)} {...props} />
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
      className={cn("fm-tabs-trigger", className)}
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
      {...props}
    />
  );
}
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };
