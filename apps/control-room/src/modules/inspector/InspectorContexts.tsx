"use client";

import type { ReactNode } from "react";
import { Box, SlidersHorizontal } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

export function InspectorContexts({ children, context, onContextChange, view }: {
  children: ReactNode;
  context: "selection" | "view";
  onContextChange: (context: "selection" | "view") => void;
  view: ReactNode;
}) {
  return <Tabs className="fm-inspector-contexts" value={context} onValueChange={value => onContextChange(value as "selection" | "view")}>
    <TabsList aria-label="Inspector context" className="fm-inspector-contexts__tabs">
      <TabsTrigger value="selection"><Box size={14} aria-hidden="true" />Selection</TabsTrigger>
      <TabsTrigger value="view"><SlidersHorizontal size={14} aria-hidden="true" />3D View</TabsTrigger>
    </TabsList>
    <TabsContent className="fm-inspector-contexts__content" forceMount hidden={context !== "selection"} value="selection">{children}</TabsContent>
    <TabsContent className="fm-inspector-contexts__content" forceMount hidden={context !== "view"} value="view">{view}</TabsContent>
  </Tabs>;
}
