"use client";

import type { ComputeNodeInventorySummary } from "./model/types";

function describeInventory(summary: ComputeNodeInventorySummary) {
  if (!summary.hasSnapshot) {
    if (summary.resourceStatus === "loading" || summary.resourceStatus === "idle") {
      return {
        detail: "The latest snapshot is being requested from the compute host.",
        label: "Reading host inventory…",
        state: "loading",
      };
    }
    return {
      detail: "No host snapshot is available yet.",
      label: "Host inventory unavailable",
      state: "unavailable",
    };
  }

  if (summary.refreshFailed) {
    if (summary.state === "stale") {
      return {
        detail: summary.staleAfterSeconds === null
          ? "The last successfully read sample is stale, and refresh failed."
          : `The last successfully read sample is older than ${summary.staleAfterSeconds} seconds, and refresh failed.`,
        label: "Stale · refresh failed",
        state: "stale",
      };
    }
    return {
      detail: "Showing the last successfully read snapshot.",
      label: "Refresh failed",
      state: summary.state === "unavailable" ? "unavailable" : "stale",
    };
  }

  if (summary.resourceStatus === "stale") {
    return {
      detail: "Showing the last snapshot while a refresh is in progress.",
      label: "Refreshing host inventory…",
      state: "loading",
    };
  }

  switch (summary.state) {
    case "current":
      return {
        detail: summary.staleAfterSeconds === null
          ? "The sample is current."
          : `Samples become stale after ${summary.staleAfterSeconds} seconds.`,
        label: `Current · ${summary.nodeCount} ${summary.nodeCount === 1 ? "node" : "nodes"}`,
        state: "current",
      };
    case "stale":
      return {
        detail: summary.staleAfterSeconds === null
          ? "The most recent host sample is old."
          : `The most recent sample is older than ${summary.staleAfterSeconds} seconds.`,
        label: "Stale",
        state: "stale",
      };
    case "not_probed":
      return {
        detail: "The configured desktop host has not published a snapshot yet.",
        label: "Not probed",
        state: "not_probed",
      };
    case "unavailable":
      return {
        detail: "The latest host snapshot could not be validated.",
        label: "Unavailable",
        state: "unavailable",
      };
    default:
      return {
        detail: "No host snapshot is available yet.",
        label: "Not reported",
        state: "unknown",
      };
  }
}

export function ComputeNodeInventoryStatus({
  className,
  summary,
}: {
  readonly className: string;
  readonly summary: ComputeNodeInventorySummary;
}) {
  const presentation = describeInventory(summary);
  return (
    <p
      className={className}
      data-state={presentation.state}
    >
      <span className="font-medium text-fm-primary">Host inventory</span>
      {" · "}{presentation.label}
      {" · "}{presentation.detail}
    </p>
  );
}
