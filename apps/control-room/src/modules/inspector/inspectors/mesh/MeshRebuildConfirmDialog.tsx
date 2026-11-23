"use client";

import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";

export interface MeshRebuildConfirmDialogProps {
  actionLabel?: string;
  busy?: boolean;
  lane: "fdm" | "fem";
  onConfirm: () => void | Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  summary?: string | null;
}

/**
 * Confirmation gate before replacing an already-materialized FDM voxel grid
 * or FEM shared-domain mesh. Rebuilding can be computationally expensive and
 * invalidates solver fields derived from the previous discretization.
 */
export function MeshRebuildConfirmDialog({
  actionLabel,
  busy = false,
  lane,
  onConfirm,
  onOpenChange,
  open,
  summary,
}: MeshRebuildConfirmDialogProps): ReactNode {
  const isFdm = lane === "fdm";
  const title = isFdm
    ? "Rebuild materialized FDM grid?"
    : "Rebuild shared-domain FEM mesh?";
  const confirmText =
    actionLabel ?? (isFdm ? "Re-voxelize Grid" : "Rebuild Mesh");
  const targetDetail = summary ? ` (${summary})` : "";
  const description = isFdm
    ? `Re-voxelizing replaces the current materialized structured grid${targetDetail}. This can be computationally expensive for fine cell sizes and invalidates solver fields derived from the previous grid.`
    : `Rebuilding replaces the current materialized shared-domain FEM mesh${targetDetail}. Mesh generation can take significant time and invalidates solver fields derived from the previous mesh.`;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} type="button">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            type="button"
            variant="primary"
            onClick={() => {
              onOpenChange(false);
              void onConfirm();
            }}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
