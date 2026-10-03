"use client";

/**
 * The inspector's context banner.
 *
 * Shown only when there is something to say, and at most ONE at a time. The
 * priority order is encoded in `selectBanner` rather than in JSX, so it is
 * unit-testable and so a new condition cannot quietly stack a second banner on
 * top of an existing one.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/inspector/ContextBanner.tsx
 */

import { Activity, AlertTriangle, Link2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/shared/ui/Button";
import { cn } from "@/shared/utils/className";

import { formatEta } from "./recentIndex";
import type { ContinueSession, RecentEntry } from "./types";

export type BannerTone = "info" | "warning" | "danger";

export interface BannerAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly variant?: "primary" | "secondary" | "ghost";
}

export interface BannerModel {
  readonly id: string;
  readonly tone: BannerTone;
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
  readonly actions?: readonly BannerAction[];
}

export interface SelectBannerInput {
  readonly entry: RecentEntry;
  readonly session?: ContinueSession;
  readonly migrationSteps?: readonly string[];
  readonly supportedSchemaVersion?: string;
  readonly onLocate?: () => void;
  readonly onForget?: () => void;
  readonly onShowLog?: () => void;
}

/**
 * Priority, highest first:
 *   1. file missing        — nothing else matters if it is not there
 *   2. run in progress     — time-sensitive, the user may want to wait
 *   3. last run failed     — needs a decision before re-running
 *   4. migration required  — changes what "Open" does
 *   5. read-only           — changes what the user may do afterwards
 */
export function selectBanner(input: SelectBannerInput): BannerModel | null {
  const { entry, session } = input;

  if (entry.status === "missing") {
    return {
      id: "missing",
      tone: "danger",
      icon: <AlertTriangle aria-hidden="true" className="size-3.5" />,
      title: "The file is no longer at this path.",
      body: "It may have been moved, renamed, or the drive may be disconnected.",
      detail: entry.path,
      actions: [
        ...(input.onLocate ? [{ label: "Locate…", onSelect: input.onLocate, variant: "primary" as const }] : []),
        ...(input.onForget ? [{ label: "Remove from recent", onSelect: input.onForget, variant: "ghost" as const }] : []),
      ],
    };
  }

  if (entry.status === "running" && session) {
    const pct = Math.round(session.progress.fraction * 100);
    const eta = formatEta(session.progress.etaSeconds);
    const where =
      session.progress.simTimeS != null && session.progress.simTimeTotalS != null
        ? `t = ${(session.progress.simTimeS * 1e9).toFixed(2)} ns of ${(session.progress.simTimeTotalS * 1e9).toFixed(2)} ns`
        : `${session.progress.framesWritten ?? 0} of ${session.progress.framesTotal ?? "?"} frames`;
    return {
      id: "running",
      tone: "warning",
      icon: <Activity aria-hidden="true" className="size-3.5" />,
      title: `Run in progress — ${pct}%.`,
      body: [where, session.device ? `on ${session.device}` : null, eta ? `${eta} remaining` : null]
        .filter(Boolean)
        .join("; ") + ".",
    };
  }

  if (entry.status === "failed" && entry.lastError) {
    return {
      id: "failed",
      tone: "danger",
      icon: <AlertTriangle aria-hidden="true" className="size-3.5" />,
      title: "Last run failed.",
      // Verbatim from the solver: cause, number, suggestion. Never "see log".
      body: entry.lastError,
      actions: input.onShowLog
        ? [{ label: "Show run log", onSelect: input.onShowLog, variant: "ghost" as const }]
        : undefined,
    };
  }

  if (entry.status === "migrate") {
    const from = entry.manifestSchemaVersion ?? "older";
    const to = input.supportedSchemaVersion ?? "current";
    return {
      id: "migrate",
      tone: "warning",
      icon: <RefreshCw aria-hidden="true" className="size-3.5" />,
      title: `Archive schema ${from} → ${to}.`,
      body: "Opening migrates a copy; the original file is left untouched.",
      detail: input.migrationSteps?.join(" · "),
    };
  }

  if (entry.mode === "read_only") {
    return {
      id: "readonly",
      tone: "info",
      icon: <Link2 aria-hidden="true" className="size-3.5" />,
      title: "Read-only.",
      body: entry.modeReason ?? "This project cannot be modified in place.",
    };
  }

  return null;
}

const TONE_CLASS: Record<BannerTone, string> = {
  info: "text-fm-accent bg-[color-mix(in_srgb,var(--fm-info)_11%,transparent)]",
  warning: "text-fm-warning bg-[color-mix(in_srgb,var(--fm-warning)_11%,transparent)]",
  danger: "text-fm-danger bg-[color-mix(in_srgb,var(--fm-danger)_11%,transparent)]",
};

export function ContextBanner({ banner }: { readonly banner: BannerModel | null }) {
  if (!banner) return null;
  return (
    <div
      className={cn(
        "mx-fm-3 mb-fm-2 flex items-start gap-fm-2 rounded-fm-md border-l-[3px] border-current",
        "px-fm-3 py-fm-2 font-fm-ui text-fm-xs leading-relaxed",
        TONE_CLASS[banner.tone],
      )}
      data-slot="context-banner"
      role={banner.tone === "danger" ? "alert" : "status"}
    >
      <span className="mt-0.5 shrink-0">{banner.icon}</span>
      <span className="min-w-0 text-fm-secondary">
        <strong className="font-semibold text-fm-primary">{banner.title}</strong>{" "}
        {banner.body}
        {banner.detail && (
          <span className="mt-1 block truncate font-fm-mono text-fm-2xs text-fm-muted" title={banner.detail}>
            {banner.detail}
          </span>
        )}
      </span>
      {banner.actions && banner.actions.length > 0 && (
        <span className="ml-auto flex shrink-0 gap-fm-1">
          {banner.actions.map((action) => (
            <Button
              key={action.label}
              onClick={action.onSelect}
              size="sm"
              type="button"
              variant={action.variant ?? "secondary"}
            >
              {action.label}
            </Button>
          ))}
        </span>
      )}
    </div>
  );
}
