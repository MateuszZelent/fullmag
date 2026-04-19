/**
 * P3 — Inspector Apply Bar
 *
 * Shared component for all inspector panels.
 * Shows draft status (Clean/Dirty/Applying/Error) and Apply/Revert buttons.
 *
 * ADR-003: Inspector edits draft, Apply commits transaction.
 */

"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ── Types ─────────────────────────────────────────────────────

export type ApplyBarStatus = "clean" | "dirty" | "applying" | "error";

export interface InspectorApplyBarProps {
  status: ApplyBarStatus;
  /** Validation error or apply error message. */
  errorMessage?: string | null;
  /** Disabled reason for the Apply button (tooltip). */
  disabledReason?: string | null;
  /** Callback for Apply action. */
  onApply: () => void;
  /** Callback for Revert/Reset action. */
  onRevert: () => void;
  /** Optional callback for Preview Draft. */
  onPreview?: () => void;
  /** Label for what this panel edits. */
  scope?: string;
  /** What will be invalidated by Apply. */
  invalidationHint?: string;
  className?: string;
}

// ── Status badge ──────────────────────────────────────────────

const STATUS_CONFIG: Record<ApplyBarStatus, { label: string; className: string }> = {
  clean: { label: "CLEAN", className: "text-emerald-400/70" },
  dirty: { label: "DRAFT", className: "text-amber-400" },
  applying: { label: "APPLYING", className: "text-blue-400 animate-pulse" },
  error: { label: "ERROR", className: "text-red-400" },
};

// ── Component ─────────────────────────────────────────────────

export function InspectorApplyBar({
  status,
  errorMessage,
  disabledReason,
  onApply,
  onRevert,
  onPreview,
  scope,
  invalidationHint,
  className,
}: InspectorApplyBarProps) {
  const config = STATUS_CONFIG[status];

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 border-t border-white/10 bg-card/30",
        className,
      )}
      role="toolbar"
      aria-label={`Inspector actions${scope ? ` for ${scope}` : ""}`}
    >
      {/* Status badge */}
      <span
        className={cn("text-xs font-mono font-semibold tracking-wider", config.className)}
        aria-live="polite"
      >
        {config.label}
      </span>

      {/* Error message */}
      {status === "error" && errorMessage && (
        <span className="text-xs text-red-400/80 truncate flex-1" title={errorMessage}>
          {errorMessage}
        </span>
      )}

      {/* Invalidation hint */}
      {status === "dirty" && invalidationHint && (
        <span className="text-xs text-muted-foreground/60 truncate flex-1" title={invalidationHint}>
          {invalidationHint}
        </span>
      )}

      {/* Spacer */}
      {status !== "error" && !invalidationHint && <div className="flex-1" />}

      {/* Preview Draft button */}
      {onPreview && status === "dirty" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onPreview}
          className="h-7 text-xs"
        >
          Preview
        </Button>
      )}

      {/* Revert button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRevert}
        disabled={status === "clean" || status === "applying"}
        className="h-7 text-xs"
        aria-label="Revert changes"
      >
        Revert
      </Button>

      {/* Apply button */}
      <Button
        variant="default"
        size="sm"
        onClick={onApply}
        disabled={status !== "dirty" || !!disabledReason}
        title={disabledReason ?? undefined}
        className="h-7 text-xs"
        aria-label="Apply changes"
        aria-disabled={status !== "dirty" || !!disabledReason}
      >
        Apply
      </Button>
    </div>
  );
}
