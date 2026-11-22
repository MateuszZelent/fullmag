"use client";

import { ChevronRight, Download, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EmptyState } from "@/shared/ui/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { cn } from "@/shared/utils/className";

import {
  Viewport3DExportPanel,
  type Viewport3DExportPanelProps,
} from "../export/Viewport3DExportPanel";
import type { Viewport3DExportMode } from "../viewport3dInspectorState";
import {
  Viewport3DSettingsContent,
  type Viewport3DSettingsSection,
} from "./Viewport3DSettingsContent";

export interface Viewport3DInspectorFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface Viewport3DInspectorTemplateShellProps<TTab extends string> {
  readonly activeTab: TTab;
  readonly aboveTabs?: ReactNode;
  readonly ariaLabel: string;
  readonly breadcrumbAriaLabel?: string;
  readonly breadcrumbCurrent: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly facts?: readonly Viewport3DInspectorFact[];
  readonly footerStatusText?: string;
  readonly icon: LucideIcon;
  readonly onTabChange: (tab: TTab) => void;
  readonly ownerId: string;
  readonly stateLabel?: string;
  readonly stateTone?: "live" | "info" | "ok" | "warn" | "err";
  readonly subtitle: string;
  readonly tabs: readonly { readonly id: TTab; readonly label: string }[];
  readonly tabsAriaLabel: string;
  readonly title: string;
}

/**
 * Shared canonical 8-slot `.fm-inspector` template shell for 3D Viewport right-panel
 * inspector surfaces (`3D View` settings and `3D Export`).
 */
export function Viewport3DInspectorTemplateShell<TTab extends string>({
  activeTab,
  aboveTabs,
  ariaLabel,
  breadcrumbAriaLabel = "Inspector breadcrumb",
  breadcrumbCurrent,
  children,
  className,
  facts,
  footerStatusText,
  icon: Icon,
  onTabChange,
  ownerId,
  stateLabel = "Live",
  stateTone = "live",
  subtitle,
  tabs,
  tabsAriaLabel,
  title,
}: Viewport3DInspectorTemplateShellProps<TTab>) {
  const [scrolled, setScrolled] = useState(false);

  return (
    <TooltipProvider delayDuration={250}>
      <section
        aria-label={ariaLabel}
        className={cn("fm-inspector fm-viewport-3d-settings", className)}
        data-domain="visualization"
        data-inspector-owner={ownerId}
        data-slot="inspector-root"
      >
        {/* Slots 1–3: Canonical 8-slot Inspector header + identity + facts. */}
        <header
          className="fm-inspector__header"
          data-scrolled={scrolled ? "true" : "false"}
          data-slot="inspector-header"
        >
          <div className="fm-inspector__path-bar" data-slot="inspector-path-bar">
            <nav aria-label={breadcrumbAriaLabel} className="fm-inspector__breadcrumbs">
              <ol className="fm-inspector__breadcrumb-list">
                <li className="fm-inspector__breadcrumb-item">
                  <span className="fm-inspector__breadcrumb">Viewport</span>
                </li>
                <li className="fm-inspector__breadcrumb-item">
                  <ChevronRight
                    aria-hidden="true"
                    className="fm-inspector__breadcrumb-separator"
                    size={12}
                  />
                  <span aria-current="page" className="fm-inspector__breadcrumb">
                    {breadcrumbCurrent}
                  </span>
                </li>
              </ol>
            </nav>
          </div>

          <div className="fm-inspector__identity" data-slot="inspector-identity">
            <span aria-hidden="true" className="fm-inspector__identity-icon">
              <Icon size={18} strokeWidth={1.75} />
            </span>
            <div className="fm-inspector__identity-copy">
              <h2 className="fm-inspector__title fm-viewport-3d-settings__title">{title}</h2>
              <div className="fm-inspector__subtitle fm-viewport-3d-settings__subtitle">
                <span>{subtitle}</span>
              </div>
            </div>
            <span
              className="fm-inspector-state-pill"
              data-slot="inspector-state-pill"
              data-tone={stateTone}
            >
              <span aria-hidden="true" className="fm-inspector-state-pill__dot" />
              <span>{stateLabel}</span>
            </span>
          </div>

          {facts && facts.length > 0 ? (
            <div
              className="fm-inspector__facts-wrap"
              data-collapsed={scrolled ? "true" : "false"}
              data-slot="inspector-facts-wrap"
            >
              <div className="fm-inspector__facts-inner">
                <dl className="fm-inspector__facts" data-slot="inspector-facts">
                  {facts.slice(0, 4).map((fact) => (
                    <div className="fm-inspector__fact" key={fact.id}>
                      <dt className="fm-inspector__fact-label">{fact.label}</dt>
                      <dd className="fm-inspector__fact-value" data-tone="neutral">
                        {fact.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ) : null}
        </header>

        <Tabs
          className="fm-viewport-3d-settings__tabs"
          onValueChange={(value) => {
            if (tabs.some((tab) => tab.id === value)) {
              onTabChange(value as TTab);
            }
          }}
          value={activeTab}
        >
          <div
            className="fm-inspector__tabs fm-viewport-3d-settings__field-list"
            data-slot="inspector-mode-tabs"
          >
            {aboveTabs}
            <TabsList
              aria-label={tabsAriaLabel}
              className={cn(
                "fm-inspector__mode-tabs fm-viewport-3d-settings__tab-list",
                tabs.length === 2 && "fm-viewport-3d-settings__tab-list--two",
              )}
              presentation="segmented"
            >
              {tabs.map((tab) => (
                <TabsTrigger
                  className="fm-inspector__mode-tab fm-viewport-3d-settings__tab"
                  key={tab.id}
                  value={tab.id}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div
            className="fm-inspector__body fm-viewport-3d-settings__panels p-0"
            data-slot="inspector-scroll"
            onScroll={(event) => {
              const y = event.currentTarget.scrollTop;
              if (!scrolled && y > 40) {
                setScrolled(true);
              } else if (scrolled && y < 4) {
                setScrolled(false);
              }
            }}
          >
            {children}
          </div>
        </Tabs>

        {footerStatusText ? (
          <footer
            className="fm-inspector__footer fm-inspector__commit-bar"
            data-mode="liveViewport"
            data-slot="inspector-commit-bar"
            data-tone="live"
          >
            <div className="fm-inspector__commit-status">
              <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="live" />
              <span className="fm-inspector__commit-text">{footerStatusText}</span>
            </div>
          </footer>
        ) : null}
      </section>
    </TooltipProvider>
  );
}

export function Viewport3DSettingsPlaceholder() {
  return (
    <EmptyState
      description="Open the 3D viewport to adjust its camera, appearance, and render quality."
      heading="3D View Settings"
      icon={<SlidersHorizontal aria-hidden="true" size={20} strokeWidth={1.5} />}
      size="compact"
    />
  );
}

export function Viewport3DExportPlaceholder() {
  return (
    <EmptyState
      description="Open the 3D viewport to export a PNG image or 3D model."
      heading="3D Export"
      icon={<Download aria-hidden="true" size={20} strokeWidth={1.5} />}
      size="compact"
    />
  );
}

export function Viewport3DSettingsInspectorSpecView({
  cameraContent = null,
  onCommand,
}: {
  cameraContent?: ReactNode;
  onCommand?: (id: string) => void;
} = {}) {
  const [section, setSection] = useState<Viewport3DSettingsSection>("view");
  return (
    <Viewport3DSettingsContent
      activeSection={section}
      cameraContent={cameraContent}
      onCommand={onCommand ?? (() => undefined)}
      onSectionChange={setSection}
    />
  );
}

export function Viewport3DExportInspectorSpecView({
  getSource,
  initialMode = "png",
  onCommand,
  onExportPng,
  sourceRevisionKey,
  visible = true,
}: {
  getSource: Viewport3DExportPanelProps["getSource"];
  initialMode?: Viewport3DExportMode;
  onCommand?: (id: string) => void;
  onExportPng?: () => Promise<void> | void;
  sourceRevisionKey?: string;
  visible?: boolean;
}) {
  const [mode, setMode] = useState<Viewport3DExportMode>(initialMode);
  return (
    <Viewport3DExportPanel
      activeMode={mode}
      getSource={getSource}
      onCommand={onCommand ?? (() => undefined)}
      onExportPng={onExportPng}
      onModeChange={setMode}
      sourceRevisionKey={sourceRevisionKey}
      visible={visible}
    />
  );
}
