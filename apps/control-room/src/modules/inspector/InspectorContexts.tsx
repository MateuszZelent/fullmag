"use client";

import type { ReactNode } from "react";
import type { Viewport3DInspectorContext } from "@/modules/viewport-3d/public";
import { Tabs, TabsContent } from "@/shared/ui/Tabs";

export function InspectorContexts({
  children,
  context,
  dirtyFieldCount = 0,
  exportPanel = null,
  onContextChange,
  view,
  viewActions,
}: {
  children: ReactNode;
  context: Viewport3DInspectorContext;
  dirtyFieldCount?: number;
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
        <div className="fm-inspector-contexts__header">
          {dirtyFieldCount > 0 ? (
            <button
              aria-label={`Return to Selection (${dirtyFieldCount} unapplied ${dirtyFieldCount === 1 ? "change" : "changes"})`}
              className="fm-inspector-contexts__dirty-indicator"
              data-dirty-fields-count={dirtyFieldCount}
              data-dirty-indicator="true"
              type="button"
              onClick={() => onContextChange("selection")}
            >
              <span aria-hidden="true" className="fm-inspector-contexts__dirty-dot" />
              <span>
                {dirtyFieldCount} unapplied {dirtyFieldCount === 1 ? "change" : "changes"}
              </span>
            </button>
          ) : null}
          {viewActions}
        </div>
      ) : null}
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "selection"}
        inert={context !== "selection" ? true : undefined}
        value="selection"
      >
        {children}
      </TabsContent>
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "view"}
        inert={context !== "view" ? true : undefined}
        value="view"
      >
        {view}
      </TabsContent>
      <TabsContent
        className="fm-inspector-contexts__content"
        forceMount
        hidden={context !== "export"}
        inert={context !== "export" ? true : undefined}
        value="export"
      >
        {exportPanel}
      </TabsContent>
    </Tabs>
  );
}
