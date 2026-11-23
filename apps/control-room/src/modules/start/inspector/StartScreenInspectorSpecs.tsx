"use client";

import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/shared/ui/Badge";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { cn } from "@/shared/utils/className";

export type StartInspectorSpecId =
  | "start.project"
  | "start.script"
  | "start.result"
  | "start.template"
  | "start.about";

export const START_INSPECTOR_SPECS: Readonly<
  Record<"project" | "script" | "result" | "template" | "about", StartInspectorSpecId>
> = {
  project: "start.project",
  script: "start.script",
  result: "start.result",
  template: "start.template",
  about: "start.about",
};

export interface StartInspectorFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface StartInspectorTemplateFrameProps {
  readonly specId: StartInspectorSpecId;
  readonly ariaLabel: string;
  readonly breadcrumbs: readonly string[];
  readonly title: string;
  readonly typeLabel: string;
  readonly statusLabel?: string;
  readonly statusVariant?: "accent" | "danger" | "default" | "secondary" | "success" | "warning";
  readonly customIdentity?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly preview?: ReactNode;
  readonly facts?: readonly StartInspectorFact[];
  readonly modeTabs?: ReactNode;
  readonly notices?: ReactNode;
  readonly children: ReactNode;
  readonly details?: ReactNode;
  readonly footer?: ReactNode;
  readonly dataKind?: string;
}

/**
 * Canonical 8-slot `.fm-inspector` template shell (`inspector-root`, `inspector-header`,
 * `inspector-path-bar`, `inspector-identity`, `inspector-facts-wrap`, `inspector-mode-tabs`,
 * `inspector-scroll`, `inspector-notices`, `inspector-commit-bar`) for Start Screen surfaces
 * (`start.{project,script,result,template,about}`), respecting module boundaries via
 * `@/shared/ui/*` and `--fm-*` design tokens.
 */
export function StartInspectorTemplateFrame({
  specId,
  ariaLabel,
  breadcrumbs,
  title,
  typeLabel,
  statusLabel,
  statusVariant = "default",
  customIdentity,
  headerActions,
  preview,
  facts,
  modeTabs,
  notices,
  children,
  details,
  footer,
  dataKind,
}: StartInspectorTemplateFrameProps) {
  const [scrolled, setScrolled] = useState(false);

  return (
    <TooltipProvider delayDuration={250}>
      <aside
        aria-label={ariaLabel}
        className="fm-start__inspector fm-start-inspector"
        data-inspector-spec={specId}
        data-kind={dataKind}
      >
      {preview}

      <div
        className="fm-inspector !bg-transparent"
        data-domain="study"
        data-inspector-owner={specId}
        data-slot="inspector-root"
      >
        {/* Slots 1–4: Canonical Sticky Inspector Header */}
        <div
          className={cn(
            "fm-inspector__header",
            customIdentity ? "gap-0 border-b-0 p-0" : undefined,
          )}
          data-scrolled={scrolled ? "true" : "false"}
          data-slot="inspector-header"
        >
          {/* Slot 1 — Path & Header Actions */}
          <div
            className={cn("fm-inspector__path-bar", customIdentity ? "sr-only" : undefined)}
            data-slot="inspector-path-bar"
          >
            <nav aria-label="Inspector breadcrumb" className="fm-inspector__breadcrumbs">
              <ol className="fm-inspector__breadcrumb-list">
                {breadcrumbs.map((crumb, index) => {
                  const isLast = index === breadcrumbs.length - 1;
                  return (
                    <li className="fm-inspector__breadcrumb-item" key={`${index}:${crumb}`}>
                      {index > 0 ? (
                        <ChevronRight
                          aria-hidden="true"
                          className="fm-inspector__breadcrumb-separator"
                          size={12}
                        />
                      ) : null}
                      <span
                        aria-current={isLast ? "page" : undefined}
                        className="fm-inspector__breadcrumb"
                      >
                        {crumb}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </nav>
            {headerActions ? (
              <div className="fm-inspector__path-actions">{headerActions}</div>
            ) : null}
          </div>

          {/* Slot 2 — Identity */}
          {customIdentity ? (
            <div data-slot="inspector-identity">{customIdentity}</div>
          ) : (
            <div className="fm-inspector__identity" data-slot="inspector-identity">
              <div className="fm-inspector__identity-copy">
                <h2 className="fm-inspector__title">{title}</h2>
                <div className="fm-inspector__subtitle">
                  <span>{typeLabel}</span>
                </div>
              </div>
              {statusLabel ? (
                <Badge
                  className="fm-inspector-state-pill"
                  data-slot="inspector-state-pill"
                  variant={statusVariant}
                >
                  <span aria-hidden="true" className="fm-inspector-state-pill__dot" />
                  <span>{statusLabel}</span>
                </Badge>
              ) : null}
            </div>
          )}

          {/* Slot 3 — Key Facts Strip */}
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

          {/* Slot 4 — Mode Tabs */}
          {modeTabs ? <div data-slot="inspector-mode-tabs">{modeTabs}</div> : null}
        </div>

        {/* Slots 5–7 — Scrollable Body */}
        <div
          className={cn("fm-inspector__scroll", customIdentity ? "!p-0" : undefined)}
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
          {notices ? (
            <div className="fm-inspector__notices" data-slot="inspector-notices">
              {notices}
            </div>
          ) : null}
          {children}
          {details ? (
            <div className="fm-inspector__details" data-slot="inspector-details">
              {details}
            </div>
          ) : null}
        </div>

        {/* Slot 8 — Sticky Commit / Action Bar */}
        {footer ? (
          <div className="shrink-0" data-slot="inspector-commit-bar">
            {footer}
          </div>
        ) : null}
      </div>
      </aside>
    </TooltipProvider>
  );
}
