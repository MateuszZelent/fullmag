"use client";

import {
  Activity,
  Box,
  Copy,
  Focus,
  BarChart2,
  ChevronRight,
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
  publishInspectorTabs,
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
  if (icon === "airbox") return <Layers3 size={20} strokeWidth={1.75} />;
  if (icon === "analysis") return <BarChart2 size={20} strokeWidth={1.75} />;
  if (icon === "diagnostics") return <Gauge size={20} strokeWidth={1.75} />;
  if (icon === "mesh") return <Database size={20} strokeWidth={1.75} />;
  if (icon === "mode") return <Activity size={20} strokeWidth={1.75} />;
  if (icon === "study") return <Play size={20} strokeWidth={1.75} />;
  if (icon === "visualization") return <Focus size={20} strokeWidth={1.75} />;
  return <Box size={20} strokeWidth={1.75} />;
}

/** Domain hue of the identity glyph (specs/frontend-v2/09 §1a). */
export function inspectorDomain(
  icon: InspectorDescriptor["icon"],
): "definition" | "geometry" | "mesh" | "study" | "visualization" {
  if (icon === "airbox" || icon === "mesh") return "mesh";
  if (icon === "analysis" || icon === "mode" || icon === "visualization") return "visualization";
  if (icon === "diagnostics") return "definition";
  if (icon === "study") return "study";
  return "geometry";
}

/** The user-facing ID shown in the header: the object ID, else the node ID. */
export function inspectorDisplayId(
  metadata: InspectorDescriptor["metadata"],
): string | undefined {
  return (
    metadata.find((item) => item.label === "Object")?.value ??
    metadata.find((item) => item.label === "Node")?.value
  );
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
  const displayId = inspectorDisplayId(descriptor.metadata);
  const descriptorKey = `${nodeId ?? descriptor.title}:${descriptor.tabs.map((tab) => tab.id).join(",")}`;
  useLayoutEffect(() => {
    configureInspectorTabs(descriptorKey, descriptor.tabs.map((tab) => tab.id));
    publishInspectorTabs(descriptor.tabs);
  }, [descriptor.tabs, descriptorKey]);
  useLayoutEffect(() => () => publishInspectorTabs([]), []);
  useLayoutEffect(() => {
    resetInspectorScroll(contentRef.current);
  }, [descriptorKey]);

  return (
    <section
      aria-label="Inspector"
      className="fm-inspector"
      data-domain={inspectorDomain(descriptor.icon)}
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
        {descriptor.breadcrumbs.length > 0 ? (
          <nav className="fm-inspector__breadcrumbs" aria-label="Selection path">
            {descriptor.breadcrumbs.map((crumb, index) => (
              <span className="fm-inspector__breadcrumb-item" key={crumb.id}>
                {index > 0 ? (
                  <ChevronRight aria-hidden="true" className="fm-inspector__breadcrumb-separator" size={12} />
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
        ) : (
          <span className="fm-panel-chrome__title">Inspector</span>
        )}
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
        <div className="fm-inspector__identity">
          <span className="fm-inspector__identity-icon" aria-hidden="true">
            <InspectorIdentityIcon icon={descriptor.icon} />
          </span>
          <div className="fm-inspector__identity-copy">
            <h2 className="fm-inspector__title">{descriptor.title}</h2>
            <div className="fm-inspector__subtitle">
              <span className="fm-inspector__kind">{descriptor.typeLabel}</span>
              {displayId ? (
                <button
                  aria-label={`Copy ID ${displayId}`}
                  className="fm-inspector__id-chip"
                  title="Copy ID"
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(displayId)}
                >
                  <span className="fm-inspector__id-chip-text">{displayId}</span>
                  <Copy aria-hidden="true" size={11} />
                </button>
              ) : null}
            </div>
          </div>
          {descriptor.status ? (
            <Badge
              className="fm-inspector__state"
              variant={statusVariant(descriptor.status.tone)}
            >
              {descriptor.status.label}
            </Badge>
          ) : null}
        </div>
        {/* Full descriptor metadata stays in the DOM for browser audits; the
            visible header shows only the ID and the facts strip. */}
        <dl className="fm-inspector__metadata" data-slot="inspector-metadata" hidden>
          {descriptor.metadata.map((item) => (
            <div className="fm-inspector__metadata-item" key={`${item.label}=${item.value}`}>
              <dt>{item.label}</dt>
              <dd title={item.value}>{item.value}</dd>
            </div>
          ))}
        </dl>
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
