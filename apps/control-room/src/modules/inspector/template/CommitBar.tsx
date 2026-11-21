"use client";

import { Check, Loader2, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/shared/ui/Button";

import type { CommitBarSpec, InspectorActionContext } from "./types";

function mapActionVariant(
  variant?: "primary" | "secondary" | "outline" | "destructive",
): ButtonProps["variant"] {
  if (variant === "destructive") return "danger";
  if (variant === "primary") return "primary";
  return "secondary";
}

export interface CommitBarProps<TDraft> {
  spec: CommitBarSpec<TDraft>;
  /** Effective commit mode (allows Slot 4 `modeTab.commitModeOverride`). */
  effectiveMode?: CommitBarSpec<TDraft>["mode"];
  ctx: InspectorActionContext<TDraft>;
  dirtyCount: number;
  invalidCount: number;
  firstInvalidFieldKey: (keyof TDraft & string) | null;
  applying: boolean;
  appliedFlash: boolean;
  appliedMessage?: string | null;
  applyError?: string | null;
  hasLiveSection?: boolean;
  onApply: () => void;
  onRevert: () => void;
  onResetDisplay: () => void;
  onFocusFirstInvalid: () => void;
}

export function CommitBar<TDraft>({
  spec,
  effectiveMode,
  ctx,
  dirtyCount,
  invalidCount,
  firstInvalidFieldKey,
  applying,
  appliedFlash,
  appliedMessage,
  applyError,
  hasLiveSection = false,
  onApply,
  onRevert,
  onResetDisplay,
  onFocusFirstInvalid,
}: CommitBarProps<TDraft>): ReactNode {
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const mode = effectiveMode ?? spec.mode;

  if (mode === "readOnly") {
    const readOnlyStatus =
      spec.mode === "readOnly" ? spec.statusMessage?.(ctx.draft)?.trim() ?? "" : "";
    if (!readOnlyStatus) return null;

    return (
      <footer
        className="fm-inspector__commit-bar"
        data-mode="readOnly"
        data-slot="inspector-commit-bar"
        data-tone="neutral"
      >
        <div className="fm-inspector__commit-status">
          <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="neutral" />
          <span className="fm-inspector__commit-text">{readOnlyStatus}</span>
        </div>
      </footer>
    );
  }

  if (mode === "liveViewport") {
    const hasOverrides =
      spec.mode === "liveViewport" ? spec.hasOverrides(ctx.draft, ctx.baseline) : false;
    const statusText =
      (spec.mode === "liveViewport" ? spec.statusMessage : undefined) ??
      "Live · Display changes apply immediately";

    return (
      <footer
        className="fm-inspector__commit-bar"
        data-mode="liveViewport"
        data-slot="inspector-commit-bar"
        data-tone="live"
      >
        <div className="fm-inspector__commit-status">
          <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="live" />
          <span className="fm-inspector__commit-text">{statusText}</span>
        </div>
        {hasOverrides ? (
          <div
            className="fm-inspector__commit-actions"
            data-slot="commit-bar-live-actions"
            data-visible="true"
          >
            <Button
              className="fm-inspector__commit-btn"
              size="sm"
              type="button"
              variant="secondary"
              onClick={onResetDisplay}
            >
              <RotateCcw aria-hidden="true" data-icon="inline-start" size={14} />
              Reset display
            </Button>
          </div>
        ) : null}
      </footer>
    );
  }

  if (mode === "immediate") {
    const statusText = spec.mode === "immediate" ? spec.statusMessage(ctx.draft) : "";
    const actions = spec.mode === "immediate" ? (spec.actions ?? []) : [];

    return (
      <footer
        className="fm-inspector__commit-bar"
        data-mode="immediate"
        data-slot="inspector-commit-bar"
        data-tone="info"
      >
        <div className="fm-inspector__commit-status">
          <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="info" />
          <span className="fm-inspector__commit-text">{statusText}</span>
        </div>
        {actions.length > 0 ? (
          <div
            className="fm-inspector__commit-actions"
            data-slot="commit-bar-immediate-actions"
            data-visible="true"
          >
            {actions.map((action) => {
              const Icon = action.icon;
              const disabledReason = action.disabledReason?.(ctx.draft) ?? null;
              const isRunning = runningActionId === action.id;
              const isDisabled = Boolean(disabledReason) || runningActionId !== null;
              return (
                <Button
                  key={action.id}
                  className="fm-inspector__commit-btn"
                  disabled={isDisabled}
                  disabledReason={disabledReason}
                  size="sm"
                  type="button"
                  variant={mapActionVariant(action.variant)}
                  onClick={() => {
                    if (runningActionId !== null) return;
                    setRunningActionId(action.id);
                    Promise.resolve(action.onRun(ctx)).finally(() => {
                      setRunningActionId((current) => (current === action.id ? null : current));
                    });
                  }}
                >
                  {isRunning ? (
                    <Loader2
                      aria-hidden="true"
                      className="fm-inspector-spinner"
                      data-icon="inline-start"
                      size={14}
                    />
                  ) : Icon ? (
                    <Icon aria-hidden="true" data-icon="inline-start" size={14} />
                  ) : null}
                  {action.label}
                </Button>
              );
            })}
          </div>
        ) : null}
      </footer>
    );
  }

  // Mode: "staged"
  const lockReason = spec.mode === "staged" ? (spec.lockReason?.(ctx.draft) ?? null) : null;
  const hasDirty = dirtyCount > 0;
  const hasErrors = invalidCount > 0;
  const showActions = hasDirty;
  const barTone =
    (hasErrors && (hasDirty || Boolean(applyError))) || Boolean(applyError)
      ? "error"
      : hasDirty
        ? "draft"
        : appliedFlash
          ? "applied"
          : "neutral";

  const cleanText =
    (spec.mode === "staged" ? spec.cleanMessage?.(ctx.draft) : undefined) ??
    (hasLiveSection
      ? "Draft is clean · Display settings apply immediately"
      : "Up to date");

  const errorLabel = `Fix ${invalidCount} ${invalidCount === 1 ? "field" : "fields"} to apply`;
  const dirtyLabel = `${dirtyCount} unapplied ${dirtyCount === 1 ? "change" : "changes"}`;

  let statusContent: ReactNode;
  if (hasErrors && firstInvalidFieldKey) {
    statusContent = (
      <button
        className="fm-inspector__commit-status fm-inspector__commit-status--error"
        type="button"
        onClick={onFocusFirstInvalid}
      >
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="error" />
        <span className="fm-inspector__commit-text">{errorLabel}</span>
      </button>
    );
  } else if (applyError) {
    statusContent = (
      <div className="fm-inspector__commit-status fm-inspector__commit-status--error" role="alert">
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="error" />
        <span className="fm-inspector__commit-text">{applyError}</span>
      </div>
    );
  } else if (lockReason && hasDirty) {
    statusContent = (
      <div className="fm-inspector__commit-status">
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="warn" />
        <span className="fm-inspector__commit-text">{lockReason}</span>
      </div>
    );
  } else if (hasDirty) {
    statusContent = (
      <div className="fm-inspector__commit-status fm-inspector__commit-status--dirty">
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="draft" />
        <span className="fm-inspector__commit-text">{dirtyLabel}</span>
      </div>
    );
  } else if (appliedFlash) {
    statusContent = (
      <div className="fm-inspector__commit-status fm-inspector__commit-status--applied" role="status">
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="applied" />
        <Check aria-hidden="true" size={14} />
        <span className="fm-inspector__commit-text">{appliedMessage ?? "Applied"}</span>
      </div>
    );
  } else {
    statusContent = (
      <div className="fm-inspector__commit-status">
        <span aria-hidden="true" className="fm-inspector__commit-dot" data-tone="neutral" />
        <span className="fm-inspector__commit-text">{cleanText}</span>
      </div>
    );
  }

  return (
    <footer
      className="fm-inspector__commit-bar"
      data-mode="staged"
      data-slot="inspector-commit-bar"
      data-tone={barTone}
    >
      {statusContent}
      <div
        aria-hidden={!showActions}
        className="fm-inspector__commit-actions"
        data-slot="commit-bar-staged-actions"
        data-visible={showActions ? "true" : "false"}
      >
        <Button
          className="fm-inspector__commit-btn"
          disabled={!showActions || applying}
          size="sm"
          tabIndex={showActions ? 0 : -1}
          type="button"
          variant="secondary"
          onClick={onRevert}
        >
          <RotateCcw aria-hidden="true" data-icon="inline-start" size={14} />
          Revert
        </Button>
        <Button
          className="fm-inspector__commit-btn"
          disabled={!showActions || applying || hasErrors || Boolean(lockReason)}
          disabledReason={
            showActions ? (lockReason ?? (hasErrors ? errorLabel : undefined)) : undefined
          }
          size="sm"
          tabIndex={showActions ? 0 : -1}
          type="button"
          variant="primary"
          onClick={onApply}
        >
          {applying ? (
            <Loader2
              aria-hidden="true"
              className="fm-inspector-spinner"
              data-icon="inline-start"
              size={14}
            />
          ) : (
            <Check aria-hidden="true" data-icon="inline-start" size={14} />
          )}
          {applying ? "Applying" : "Apply"}
          <kbd className="fm-inspector__commit-kbd">Ctrl ↵</kbd>
        </Button>
      </div>
    </footer>
  );
}
