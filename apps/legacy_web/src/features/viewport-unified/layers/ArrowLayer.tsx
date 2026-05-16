"use client";

import type { ReactNode } from "react";
import type { Viewport3DVectorFieldModel } from "@/features/viewport-unified/model/viewport3dContracts";

export interface ArrowLayerProps {
  visible?: boolean;
  vectorField?: Viewport3DVectorFieldModel | null;
  statusChipsVisible?: boolean;
  children?: ReactNode;
}

export function ArrowLayer({
  visible = true,
  vectorField = null,
  statusChipsVisible = true,
  children = null,
}: ArrowLayerProps) {
  const chip = vectorStatusChip(vectorField, visible);
  return (
    <div
      className="relative flex flex-col flex-1 h-full min-h-0 min-w-0 w-full"
      data-viewport-layer="vector-field"
      data-vector-layer-visible={visible ? "true" : "false"}
      data-vector-status={vectorField?.status ?? "idle"}
    >
      {statusChipsVisible && chip ? (
        <div className="pointer-events-none absolute bottom-3 right-3 z-20 rounded border border-border/45 bg-background/80 px-2 py-1 font-mono text-[10px] uppercase text-muted-foreground backdrop-blur">
          {chip}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function vectorStatusChip(
  vectorField: Viewport3DVectorFieldModel | null,
  visible: boolean,
): string | null {
  if (!vectorField?.visible) {
    return "VEC OFF";
  }
  switch (vectorField.status) {
    case "ready":
      if (!visible) return "VEC OFF";
      return `VEC READY ${vectorField.sampledCount.toLocaleString()} / ${vectorField.pointCount.toLocaleString()}`;
    case "loading":
      return "VEC LOADING";
    case "unsupported":
      return `VEC UNSUPPORTED${vectorField.error ? `: ${vectorField.error}` : ""}`;
    case "mismatch":
      return `VEC MISMATCH${vectorField.error ? `: ${vectorField.error}` : ""}`;
    case "error":
      return `VEC API ERROR${vectorField.error ? `: ${vectorField.error}` : ""}`;
    default:
      return null;
  }
}
