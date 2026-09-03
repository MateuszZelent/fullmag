"use client";

import { Pin, X } from "lucide-react";

import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";
import type { FrontendDiagnosticFlags } from "@/lib/debug/frontendDiagnosticFlags";

type DockCenterTabFlags = FrontendDiagnosticFlags["dockCenterTabs"];

interface DockCenterTabHeaderProps {
  stage: WorkspaceMode;
  tabs: WorkspaceTab[];
  flags: DockCenterTabFlags;
  onCloseTab: (stage: WorkspaceMode, tabId: string) => void;
}

export function DockCenterTabHeader({
  stage,
  tabs,
  flags,
  onCloseTab,
}: DockCenterTabHeaderProps) {
  if (!flags.enableTabsHeader) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-border/10 bg-transparent px-2 py-1.5 flex items-center">
      <TabsList className="w-full justify-start overflow-x-auto p-0">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            className={cn(
              "group relative h-7 min-w-[80px] max-w-[220px] justify-start gap-1 px-3 text-[0.7rem] normal-case tracking-wide",
            )}
            title={tab.title}
          >
            <span className="truncate">{tab.title}</span>
            {tab.pinned ? <Pin className="size-3 opacity-65" /> : null}
            {flags.enableInlineCloseButton && tab.closable && !tab.pinned ? (
              <div
                role="button"
                tabIndex={-1}
                className="ml-auto inline-flex size-4 items-center justify-center rounded-sm p-0 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseTab(stage, tab.id);
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseTab(stage, tab.id);
                  }
                }}
                title="Close tab"
                aria-label={`Close ${tab.title}`}
              >
                <X className="size-3" />
              </div>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
