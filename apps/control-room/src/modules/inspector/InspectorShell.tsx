"use client";

import {
  Activity,
  Box,
  Focus,
  MoreHorizontal,
  RotateCcw,
  BarChart2,
  Check,
  Database,
  Gauge,
  Layers3,
  Play,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { ScrollArea } from "@/shared/ui/ScrollArea";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/shared/ui/Tooltip";

import {
  inspectorActionState,
  useInspectorEditSession,
} from "./InspectorEditSession";
import type { InspectorDescriptor } from "./inspectorDescriptor";
import { resetInspectorScroll } from "./inspectorScroll";
import {
  configureInspectorTabs,
  setInspectorActiveTab,
  useInspectorActiveTab,
} from "./InspectorTabState";

interface InspectorShellProps {
  children: ReactNode;
  descriptor: InspectorDescriptor;
  onFocus: () => void;
  onSelectBreadcrumb: (selection: NonNullable<InspectorDescriptor["breadcrumbs"][number]["selection"]>) => void;
}

function statusVariant(
  tone: NonNullable<InspectorDescriptor["status"]>["tone"],
): "default" | "secondary" | "success" | "warning" | "danger" {
  if (tone === "success") return "success";
  if (tone === "warning") return "warning";
  if (tone === "danger") return "danger";
  return tone === "info" ? "default" : "secondary";
}

function InspectorIdentityIcon({ icon }: Pick<InspectorDescriptor, "icon">) {
  if (icon === "airbox") return <Layers3 size={22} strokeWidth={1.5} />;
  if (icon === "analysis") return <BarChart2 size={22} strokeWidth={1.5} />;
  if (icon === "diagnostics") return <Gauge size={22} strokeWidth={1.5} />;
  if (icon === "mesh") return <Database size={22} strokeWidth={1.5} />;
  if (icon === "mode") return <Activity size={22} strokeWidth={1.5} />;
  if (icon === "study") return <Play size={22} strokeWidth={1.5} />;
  if (icon === "visualization") return <Focus size={22} strokeWidth={1.5} />;
  return <Box size={22} strokeWidth={1.5} />;
}

export function InspectorShell({
  children,
  descriptor,
  onFocus,
  onSelectBreadcrumb,
}: InspectorShellProps) {
  const editSession = useInspectorEditSession();
  const actions = inspectorActionState(editSession);
  const isolateReasonId = useId();
  const resetReasonId = useId();
  const applyReasonId = useId();
  const activeTab = useInspectorActiveTab();
  const contentRef = useRef<HTMLDivElement>(null);
  const nodeId = descriptor.metadata.find((item) => item.label === "Node")?.value;
  const descriptorKey = `${nodeId ?? descriptor.title}:${descriptor.tabs.map((tab) => tab.id).join(",")}`;
  useLayoutEffect(() => {
    configureInspectorTabs(descriptorKey, descriptor.tabs.map((tab) => tab.id));
    resetInspectorScroll(contentRef.current);
  }, [descriptor.tabs, descriptorKey]);

  return (
    <section
      aria-label="Inspector"
      className="fm-inspector"
      data-inspector-owner={descriptor.ownerId}
    >
      <header className="fm-inspector__header">
        {descriptor.breadcrumbs.length > 0 ? (
          <nav className="fm-inspector__breadcrumbs" aria-label="Selection path">
            {descriptor.breadcrumbs.map((crumb, index) => (
              <span className="fm-inspector__breadcrumb-item" key={crumb.id}>
                {index > 0 ? (
                  <span className="fm-inspector__breadcrumb-separator" aria-hidden="true">
                    /
                  </span>
                ) : null}
                {crumb.selection ? (
                  <button
                    className="fm-inspector__breadcrumb"
                    type="button"
                    onClick={() => onSelectBreadcrumb(crumb.selection!)}
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span className="fm-inspector__breadcrumb">{crumb.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="fm-inspector__identity">
          <span className="fm-inspector__identity-icon" aria-hidden="true">
            <InspectorIdentityIcon icon={descriptor.icon} />
          </span>
          <div className="fm-inspector__identity-copy">
            <h2 className="fm-inspector__title">{descriptor.title}</h2>
            <div className="fm-inspector__badges">
              <Badge variant="secondary">{descriptor.typeLabel}</Badge>
              {descriptor.status ? (
                <Badge variant={statusVariant(descriptor.status.tone)}>
                  {descriptor.status.label}
                </Badge>
              ) : null}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Inspector options"
                className="fm-inspector__options-button"
                size="icon"
                variant="ghost"
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!nodeId}
                onSelect={() => {
                  if (nodeId) void navigator.clipboard?.writeText(nodeId);
                }}
              >
                Copy node ID
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {descriptor.metadata.length > 0 ? (
          <dl className="fm-inspector__metadata-grid">
            {descriptor.metadata.map((item) => (
              <div className="fm-inspector__metadata-item" key={item.label}>
                <dt>{item.label}</dt>
                <dd title={item.value}>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </header>

      {descriptor.tabs.length > 0 ? (
        <Tabs
          className="fm-inspector__tabs"
          value={activeTab}
          onValueChange={setInspectorActiveTab}
        >
          <TabsList className="fm-inspector__tab-list">
            {descriptor.tabs.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      <ScrollArea className="fm-inspector__content" ref={contentRef}>
        <div className="fm-inspector__body">{children}</div>
      </ScrollArea>

      <footer className="fm-inspector__action-bar">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="fm-inspector__action-btn"
                size="sm"
                variant="secondary"
                onClick={onFocus}
              >
                <Focus size={14} aria-hidden="true" />
                Focus
              </Button>
            </TooltipTrigger>
            <TooltipContent>Focus viewport on this selection</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-describedby={isolateReasonId}
                className="fm-inspector__action-tooltip-target"
                role="note"
                tabIndex={0}
              >
                <Button
                  className="fm-inspector__action-btn"
                  size="sm"
                  variant="secondary"
                  disabled
                >
                  <BarChart2 size={14} aria-hidden="true" />
                  Isolate
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent id={isolateReasonId}>Isolation is not available for this selection.</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-describedby={!actions.canReset ? resetReasonId : undefined}
                className="fm-inspector__action-tooltip-target"
                tabIndex={!actions.canReset ? 0 : -1}
              >
                <Button
                  className="fm-inspector__action-btn"
                  disabled={!actions.canReset}
                  size="sm"
                  variant="secondary"
                  onClick={() => void editSession?.reset()}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  Reset
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent id={resetReasonId}>
              {actions.canReset ? "Reset to the last applied state" : actions.applyReason}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-describedby={!actions.canApply ? applyReasonId : undefined}
                className="fm-inspector__action-tooltip-target"
                tabIndex={!actions.canApply ? 0 : -1}
              >
                <Button
                  className="fm-inspector__action-btn fm-inspector__action-btn--apply"
                  disabled={!actions.canApply}
                  size="sm"
                  variant="primary"
                  onClick={() => void editSession?.apply()}
                >
                  <Check size={14} aria-hidden="true" />
                  {editSession?.applying ? "Applying…" : "Apply"}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent id={applyReasonId}>{actions.applyReason ?? "Apply changes"}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </footer>
    </section>
  );
}
