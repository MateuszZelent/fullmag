"use client";

import { AlertTriangle, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { BackendErrorInfo } from "./types";

interface BackendErrorNoticeProps {
  error: BackendErrorInfo;
  className?: string;
  compact?: boolean;
  onDismiss?: () => void;
}

function formatErrorTime(timestampUnixMs: number): string {
  if (!Number.isFinite(timestampUnixMs) || timestampUnixMs <= 0) {
    return "Backend error";
  }
  return new Date(timestampUnixMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function BackendErrorNotice({
  error,
  className,
  compact = false,
  onDismiss,
}: BackendErrorNoticeProps) {
  const detailLabel = error.traceback ? "Show traceback" : "Show full error";

  return (
    <section
      className={cn(
        "rounded-2xl border border-rose-500/25 bg-rose-500/10 text-rose-50 shadow-[0_18px_48px_rgba(120,20,20,0.18)]",
        compact ? "px-4 py-3" : "px-4 py-4",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-rose-200/90">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error.title}
          </div>
          <div className={cn("mt-2 font-semibold text-rose-50", compact ? "text-sm" : "text-base")}>
            {error.summary}
          </div>
          <div className="mt-1 text-xs text-rose-100/75">
            The current operation was interrupted because the backend reported an error.
            {" "}
            {formatErrorTime(error.timestampUnixMs)}
          </div>
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-500/20 bg-rose-950/20 text-rose-100/80 transition-colors hover:bg-rose-950/35 hover:text-rose-50"
            aria-label="Dismiss backend error"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <details className="mt-3 rounded-xl border border-rose-500/15 bg-black/20 px-3 py-2.5">
        <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.16em] text-rose-100/85">
          {detailLabel}
        </summary>
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 font-mono text-[0.72rem] leading-relaxed text-rose-50/92">
          {error.details}
        </pre>
      </details>
    </section>
  );
}
