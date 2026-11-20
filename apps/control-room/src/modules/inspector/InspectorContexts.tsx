"use client";

import type { ReactNode } from "react";
import { Tabs, TabsContent } from "@/shared/ui/Tabs";

export function InspectorContexts({ children, context, onContextChange, view, viewActions }: {
  children: ReactNode;
  context: "selection" | "view";
  onContextChange: (context: "selection" | "view") => void;
  view: ReactNode;
  viewActions?: ReactNode;
}) {
  return <Tabs className="fm-inspector-contexts" value={context} onValueChange={value => onContextChange(value as "selection" | "view")}>
    {/* Selection and 3D View are chosen on the right side rail (specs/frontend-v2/10 §1a). */}
    {context === "view" ? <div className="fm-inspector-contexts__header">{viewActions}</div> : null}
    <TabsContent className="fm-inspector-contexts__content" forceMount hidden={context !== "selection"} value="selection">{children}</TabsContent>
    <TabsContent className="fm-inspector-contexts__content" forceMount hidden={context !== "view"} value="view">{view}</TabsContent>
  </Tabs>;
}
