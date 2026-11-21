"use client";

import type { ReactNode } from "react";
import type { Viewport3DInspectorContext } from "@/modules/viewport-3d/public";
import { Tabs, TabsContent } from "@/shared/ui/Tabs";

export function InspectorContexts({
  children,
  context,
  exportPanel = null,
  onContextChange,
  view,
  viewActions,
}: {
  children: ReactNode;
  context: Viewport3DInspectorContext;
  exportPanel?: ReactNode;
  onContextChange: (context: Viewport3DInspectorContext) => void;
  view: ReactNode;
  viewActions?: ReactNode;
}) {
  return (
    <Tabs
      className="fm-inspector-contexts"
      value={context}
      onValueChange={(value) => onContextChange(value as Viewport3DInspectorContext)}
    >
      {/* Selection, 3D View and Export are chosen on the right side rail (specs/frontend-v2/10 §1a). */}
      {context === "view" || context === "export" ? (
        <div className="fm-inspector-contexts__header">{viewActions}</div>
      ) : null}
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "selection"}
        value="selection"
      >
        {children}
      </TabsContent>
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "view"}
        value="view"
      >
        {view}
      </TabsContent>
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "export"}
        value="export"
      >
        {exportPanel}
      </TabsContent>
    </Tabs>
  );
}
