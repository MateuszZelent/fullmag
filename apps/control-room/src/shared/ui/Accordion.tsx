"use client";

import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import * as React from "react";
import { cn } from "@/shared/utils/className";

const Accordion = AccordionPrimitive.Root;

function AccordionItem({
  className,
  ...props
}: React.ComponentPropsWithRef<typeof AccordionPrimitive.Item>) {
  return (
  <AccordionPrimitive.Item
    className={cn("fm-accordion-item", className)}
    {...props}
  />
  );
}
AccordionItem.displayName = "AccordionItem";

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithRef<typeof AccordionPrimitive.Trigger>) {
  return (
  <AccordionPrimitive.Header className="fm-accordion-header">
    <AccordionPrimitive.Trigger
      className={cn("fm-accordion-trigger", className)}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
  );
}
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithRef<typeof AccordionPrimitive.Content>) {
  return (
  <AccordionPrimitive.Content
    className="fm-accordion-content"
    {...props}
  >
    <div className={cn("fm-accordion-content-inner", className)}>{children}</div>
  </AccordionPrimitive.Content>
  );
}
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
