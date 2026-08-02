"use client";

import type { ReactNode } from "react";

import {
  scientificTrustLabel,
  type ChartScientificTrust,
} from "./chartScientificTrust";
import type { ChartDataPresentationState } from "./chartPresentationState";

export type { ChartScientificTrust } from "./chartScientificTrust";

export interface ChartSectionStatus {
  /** Primary status text (e.g. "Live", "Paused", "Loading…", "Error") */
  primary: string;
  /** Whether this status is an error/alert condition */
  isAlert?: boolean;
  /** Scientific qualification carried by the analysis resource. */
  trust?: ChartScientificTrust;
  /** Revision or cursor position */
  revision?: string | number | null;
  /** Newer revision requested during a background refresh. */
  requestedRevision?: string | number | null;
  /** Non-blocking explanation for a retained stale payload. */
  detail?: string;
  /** Visible/total point count */
  pointSummary?: string;
  /** Resource presentation state, independent from scientific trust. */
  presentation?: ChartDataPresentationState;
}

interface ChartSectionProps {
  /** Section heading */
  title: string;
  /** Optional subtitle (source, run, stage) */
  subtitle?: string;
  /** Status descriptor */
  status?: ChartSectionStatus;
  /** Toolbar actions rendered in the header row */
  toolbar?: ReactNode;
  /** Legend row rendered below the header */
  legend?: ReactNode;
  /** Main chart content */
  children: ReactNode;
  /** Footer row (range/cursor/export) */
  footer?: ReactNode;
  /** Additional CSS class */
  className?: string;
}

/**
 * ChartSection — shared scientific chart container.
 *
 * Layout:
 *   ┌─ header: title + status + toolbar ─────────────────────┐
 *   │  legend row                                             │
 *   │  chart area (fills remaining height)                    │
 *   └─ footer: cursor / zoom / export ───────────────────────┘
 *
 * Rules:
 * - Resource state and scientific qualification are independent values.
 * - Revision, point count and scientific trust are secondary metadata.
 * - No raw hex; all colours from --fm-* tokens via CSS classes
 */
export function ChartSection({
  title,
  subtitle,
  status,
  toolbar,
  legend,
  children,
  footer,
  className,
}: ChartSectionProps) {
  const displayedStatus = presentationStatus(status);
  const normalizedPrimary = displayedStatus?.primary.toLowerCase() ?? "";
  const statusClass = displayedStatus?.isAlert
    ? "fm-chart-section__status--error"
    : normalizedPrimary === "degraded"
      ? "fm-chart-section__status--degraded"
      : normalizedPrimary === "stale"
        ? "fm-chart-section__status--stale"
        : "fm-chart-section__status--ok";

  return (
    <section
      aria-label={title}
      className={[
        "fm-chart-section",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="fm-chart-section__header">
        <div className="fm-chart-section__title-group">
          <h3 className="fm-chart-section__title">{title}</h3>
          {subtitle ? (
            <span className="fm-chart-section__subtitle">{subtitle}</span>
          ) : null}
        </div>
        {displayedStatus ? (
          <div className="fm-chart-section__status-group">
            <span
              aria-live={displayedStatus.isAlert ? "assertive" : "polite"}
              className={`fm-chart-section__status ${statusClass}`}
              role={displayedStatus.isAlert ? "alert" : "status"}
            >
              {displayedStatus.primary}
            </span>
            {status?.trust ? (
              <span className="fm-chart-section__trust">
                Scientific trust: {scientificTrustLabel(status.trust)}
              </span>
            ) : null}
            {status?.pointSummary ? (
              <span className="fm-chart-section__point-count">
                {status.pointSummary}
              </span>
            ) : null}
            {displayedStatus.revision != null ? (
              <span className="fm-chart-section__revision">
                rev {displayedStatus.revision}
              </span>
            ) : null}
            {displayedStatus.requestedRevision != null ? (
              <span className="fm-chart-section__revision">
                → {displayedStatus.requestedRevision}
              </span>
            ) : null}
            {displayedStatus.detail ? (
              <span className="fm-chart-section__status-detail">
                {displayedStatus.detail}
              </span>
            ) : null}
          </div>
        ) : null}
        {toolbar ? (
          <div className="fm-chart-section__toolbar">{toolbar}</div>
        ) : null}
      </div>
      {legend ? (
        <div className="fm-chart-section__legend">{legend}</div>
      ) : null}
      <div className="fm-chart-section__body">{children}</div>
      {footer ? (
        <div className="fm-chart-section__footer">{footer}</div>
      ) : null}
    </section>
  );
}

function presentationStatus(status: ChartSectionStatus | undefined) {
  const presentation = status?.presentation;
  if (!presentation) return status;
  switch (presentation.kind) {
    case "ready":
      return { ...status, primary: "Live", revision: presentation.revision };
    case "refreshing":
      return {
        ...status,
        primary: "Updating",
        requestedRevision: presentation.requestedRevision,
        revision: presentation.visibleRevision,
      };
    case "paused":
      return {
        ...status,
        primary: "Paused",
        requestedRevision: presentation.latestKnownRevision,
        revision: presentation.visibleRevision,
      };
    case "stale":
      return {
        ...status,
        detail: presentation.error.message,
        isAlert: true,
        primary: "Refresh failed",
        revision: presentation.visibleRevision,
      };
    case "error":
      return { ...status, detail: presentation.error.message, isAlert: true, primary: "Error" };
    case "unsupported":
      return { ...status, detail: presentation.reason, primary: "Unavailable" };
    case "empty":
      return { ...status, primary: "No table data", revision: presentation.revision };
    case "initial-loading":
      return { ...status, primary: "Loading…" };
  }
}
