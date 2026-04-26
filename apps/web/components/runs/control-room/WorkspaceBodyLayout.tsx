"use client";

import type { ReactNode } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { PANEL_SIZES } from "./shared";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

/* ── resize handle (shared visual) ────────────── */

const HANDLE_CLASS =
  "h-full w-2 bg-transparent cursor-ew-resize flex items-center justify-center" +
  " transition-colors relative hover:bg-muted/50 active:bg-muted/50" +
  " after:content-[''] after:absolute after:top-1/2 after:left-1/2" +
  " after:-translate-x-1/2 after:-translate-y-1/2 after:w-[2px] after:h-9" +
  " after:rounded-full after:bg-border hover:after:bg-primary active:after:bg-primary z-50";

/* ── props ─────────────────────────────────────── */

export interface WorkspaceBodyLayoutProps {
  /** Left explorer / sidebar panel content. When null the panel is hidden. */
  leftPanel: ReactNode;
  /** Whether the left panel is currently collapsed by the user. */
  leftCollapsed: boolean;
  /** Center dock — the viewport area + tab bar. */
  center: ReactNode;
  /** Right inspector panel content. When null the panel is hidden. */
  rightPanel: ReactNode;
  /** Whether the right panel is currently open. */
  rightOpen: boolean;
  /** Default size for the right panel (responds to compact layout). */
  rightDefaultSize?: string;
  /** Min size for the right panel (responds to compact layout). */
  rightMinSize?: string;
  /** Max size for the right panel (responds to compact layout). */
  rightMaxSize?: string;
}

/* ── component ─────────────────────────────────── */

export function WorkspaceBodyLayout({
  leftPanel,
  leftCollapsed,
  center,
  rightPanel,
  rightOpen,
  rightDefaultSize = PANEL_SIZES.rightInspectorDefault,
  rightMinSize = PANEL_SIZES.rightInspectorMin,
  rightMaxSize = PANEL_SIZES.rightInspectorMax,
}: WorkspaceBodyLayoutProps) {
  return (
    <PanelGroup
      orientation="horizontal"
      className="flex flex-row flex-1 min-h-0 min-w-0 overflow-hidden"
      resizeTargetMinimumSize={{ coarse: 40, fine: 12 }}
    >
      {/* ── Left sidebar ── */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showSidebar && !leftCollapsed ? (
        <>
          <Panel
            id="workspace-sidebar"
            defaultSize={PANEL_SIZES.sidebarDefault}
            minSize={PANEL_SIZES.sidebarMin}
            maxSize={PANEL_SIZES.sidebarMax}
            collapsible
            collapsedSize="0%"
          >
            {leftPanel}
          </Panel>
          <PanelResizeHandle className={HANDLE_CLASS} />
        </>
      ) : null}

      {/* ── Center body ── */}
      <Panel
        id="workspace-main"
        defaultSize={leftCollapsed ? "100%" : PANEL_SIZES.bodyMainDefault}
        minSize={PANEL_SIZES.bodyMainMin}
      >
        <Panel
          id="workspace-viewport"
          defaultSize={PANEL_SIZES.viewportDefault}
          minSize={PANEL_SIZES.viewportMin}
        >
          <div className="flex flex-row h-full min-h-0 min-w-0 overflow-hidden bg-background flex-1 relative">
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              {center}
            </div>
          </div>
        </Panel>
      </Panel>

      {/* ── Right inspector ── */}
      {FRONTEND_DIAGNOSTIC_FLAGS.shell.showRightInspector && rightOpen && rightPanel ? (
        <>
          <PanelResizeHandle className={HANDLE_CLASS} />
          <Panel
            id="workspace-right-inspector"
            defaultSize={rightDefaultSize}
            minSize={rightMinSize}
            maxSize={rightMaxSize}
            collapsible
            collapsedSize={0}
            className="h-full min-h-0 overflow-y-auto overflow-x-hidden"
          >
            <div className="h-full min-h-0">
              {rightPanel}
            </div>
          </Panel>
        </>
      ) : null}
    </PanelGroup>
  );
}
