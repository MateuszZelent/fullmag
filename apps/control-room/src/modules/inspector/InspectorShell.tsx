"use client";

import {
  Activity,
  Box,
  Focus,
  BarChart2,
  Database,
  Gauge,
  Layers3,
  PanelRightClose,
  Play,
} from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import { PanelChrome, usePanelChromeControls } from "@/shared/ui/PanelFrame";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { DropdownMenuItem } from "@/shared/ui/DropdownMenu";
import { ScrollArea } from "@/shared/ui/ScrollArea";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";
import { InspectorFooter } from "./InspectorFooter";
import type { InspectorDescriptor } from "./inspectorDescriptor";
import { resetInspectorScroll } from "./inspectorScroll";
import {
  configureInspectorTabs,
  setInspectorActiveTab,
  useInspectorActiveTab,
} from "./InspectorTabState";

interface InspectorShellProps {
  focusDisabled?: boolean;
  children: ReactNode;
  descriptor: InspectorDescriptor;
  onFocus: () => void;
  onSelectBreadcrumb: (selection: NonNullable<InspectorDescriptor["breadcrumbs"][number]["selection"]>) => void;
  onToggleVisibility: () => void;
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
  focusDisabled = false,
  children,
  descriptor,
  onFocus,
  onSelectBreadcrumb,
  onToggleVisibility,
}: InspectorShellProps) {
  const activeTab = useInspectorActiveTab();
  const chrome = usePanelChromeControls();
  const contentRef = useRef<HTMLDivElement>(null);
  const nodeId = descriptor.metadata.find((item) => item.label === "Node")?.value;
  const descriptorKey = `${nodeId ?? descriptor.title}:${descriptor.tabs.map((tab) => tab.id).join(",")}`;
  useLayoutEffect(() => {
    configureInspectorTabs(descriptorKey, descriptor.tabs.map((tab) => tab.id));
  }, [descriptor.tabs, descriptorKey]);
  useLayoutEffect(() => {
    resetInspectorScroll(contentRef.current);
  }, [descriptorKey]);

  return (
    <section
      aria-label="Inspector"
      className="fm-inspector"
      data-inspector-owner={descriptor.ownerId}
    >
      <PanelChrome
        menuItems={
          <DropdownMenuItem
            disabled={!nodeId}
            onSelect={() => {
              if (nodeId) void navigator.clipboard?.writeText(nodeId);
            }}
          >
            Copy node ID
          </DropdownMenuItem>
        }
      >
        <span className="fm-panel-chrome__title">Inspector</span>
        <Button
          aria-label="Hide Inspector"
          className="fm-inspector__panel-toggle"
          data-panel-toggle="inspector"
          size="icon"
          title="Hide Inspector"
          type="button"
          variant="ghost"
          onClick={() => (chrome ? chrome.hideWith(onToggleVisibility) : onToggleVisibility())}
        >
          <PanelRightClose size={16} aria-hidden="true" />
        </Button>
      </PanelChrome>
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

      <InspectorFooter key={descriptorKey} focusDisabled={focusDisabled} onFocus={onFocus} />
    </section>
  );
}
