"use client";

import { ArrowLeft } from "lucide-react";

import type { KernelApi } from "@/kernel/types";
import { Button } from "@/shared/ui/Button";

import { useResultsHistoryExitOwner } from "./ResultsHistoryExitOwnerContext";
import { returnResultsToLive } from "./returnResultsToLive";

export function ResultsHistoryExitAction({
  kernel,
}: {
  readonly kernel: KernelApi;
}) {
  const owner = useResultsHistoryExitOwner();
  if (owner !== "current") return null;

  return (
    <Button
      aria-label="Return to live"
      className="fm-header__history-exit"
      size="sm"
      title="Return to live"
      type="button"
      variant="secondary"
      onClick={() => returnResultsToLive(kernel)}
    >
      <ArrowLeft aria-hidden="true" size={14} />
      <span className="fm-header__history-exit-label">Return to live</span>
    </Button>
  );
}
