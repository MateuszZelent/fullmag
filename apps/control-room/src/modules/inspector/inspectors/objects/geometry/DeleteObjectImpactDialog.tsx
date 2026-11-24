"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { deleteObjectDialogStore } from "@/kernel/authoring/deleteObjectDialogStore";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { parseCompositeGeometry } from "@/kernel/authoring/compositeGeometryModel";
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
import { Badge } from "@/shared/ui/Badge";

export interface DeleteObjectImpactCategory {
  count: number;
  items: readonly string[];
  kind: "regions" | "couplings" | "field_drives" | "transports" | "planar_monitors" | "csg_references";
  label: string;
}

export interface DeleteObjectImpactSummary {
  categories: readonly DeleteObjectImpactCategory[];
  objectId: string;
  objectName: string;
  totalDependents: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordReferencesObject(value: unknown, objectId: string, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === "string") return value === objectId;
  if (Array.isArray(value)) {
    return value.some((item) => recordReferencesObject(item, objectId, depth + 1));
  }
  const rec = asRecord(value);
  if (!rec) return false;
  for (const [key, entry] of Object.entries(rec)) {
    if (
      (key === "object_id" ||
        key === "source_object_id" ||
        key === "target_object_id" ||
        key === "object_a" ||
        key === "object_b" ||
        key === "owner_object_id") &&
      entry === objectId
    ) {
      return true;
    }
    if (recordReferencesObject(entry, objectId, depth + 1)) return true;
  }
  return false;
}

export function analyzeDeleteObjectImpact(
  scene: SceneResource | null | undefined,
  objectId: string,
): DeleteObjectImpactSummary {
  const sceneRecord = asRecord(scene) ?? {};
  const objects = Array.isArray(scene?.objects) ? scene.objects : [];
  const targetObject = objects.find((obj) => obj.id === objectId);
  const objectName =
    asString(targetObject?.name) ?? objectId;

  const regionItems: string[] = [];
  const rawRegions = asRecord(targetObject)?.regions;
  if (Array.isArray(rawRegions)) {
    for (const region of rawRegions) {
      const rec = asRecord(region);
      const label = asString(rec?.name) ?? asString(rec?.id) ?? "Region";
      regionItems.push(label);
    }
  }

  const collectMatching = (rawList: unknown, fallbackLabel: string): string[] => {
    if (!Array.isArray(rawList)) return [];
    const matched: string[] = [];
    for (const item of rawList) {
      if (!recordReferencesObject(item, objectId)) continue;
      const rec = asRecord(item);
      matched.push(asString(rec?.name) ?? asString(rec?.id) ?? fallbackLabel);
    }
    return matched;
  };

  const couplingItems = collectMatching(sceneRecord.couplings, "Coupling");
  const fieldDrivesRecord = asRecord(sceneRecord.field_drives);
  const fieldDriveItems = [
    ...collectMatching(fieldDrivesRecord?.drives, "Regional field drive"),
    ...collectMatching(fieldDrivesRecord?.mask_drives, "Mask field drive"),
    ...collectMatching(sceneRecord.regional_field_drives, "Regional field drive"),
    ...collectMatching(sceneRecord.mask_field_drives, "Mask field drive"),
  ];
  const transportItems = [
    ...collectMatching(sceneRecord.current_transports, "Current transport"),
    ...collectMatching(sceneRecord.spin_transports, "Spin transport"),
  ];
  const monitorsRecord = asRecord(sceneRecord.monitors);
  const planarMonitorItems = [
    ...collectMatching(monitorsRecord?.planar, "Planar monitor"),
    ...collectMatching(sceneRecord.planar_monitors, "Planar monitor"),
  ];

  const csgRefItems: string[] = [];
  for (const obj of objects) {
    if (obj.id === objectId) continue;
    const parsed = parseCompositeGeometry(obj.geometry);
    if (parsed.operands.some((op) => op.sourceObjectId === objectId)) {
      csgRefItems.push(asString(obj.name) ?? obj.id);
    }
  }

  const categories: DeleteObjectImpactCategory[] = [];
  if (regionItems.length > 0) {
    categories.push({
      count: regionItems.length,
      items: regionItems,
      kind: "regions",
      label: "Authored regions",
    });
  }
  if (couplingItems.length > 0) {
    categories.push({
      count: couplingItems.length,
      items: couplingItems,
      kind: "couplings",
      label: "Physics couplings",
    });
  }
  if (fieldDriveItems.length > 0) {
    categories.push({
      count: fieldDriveItems.length,
      items: fieldDriveItems,
      kind: "field_drives",
      label: "Field drives",
    });
  }
  if (transportItems.length > 0) {
    categories.push({
      count: transportItems.length,
      items: transportItems,
      kind: "transports",
      label: "Transport definitions",
    });
  }
  if (planarMonitorItems.length > 0) {
    categories.push({
      count: planarMonitorItems.length,
      items: planarMonitorItems,
      kind: "planar_monitors",
      label: "Planar monitors",
    });
  }
  if (csgRefItems.length > 0) {
    categories.push({
      count: csgRefItems.length,
      items: csgRefItems,
      kind: "csg_references",
      label: "CSG composite references",
    });
  }

  const totalDependents = categories.reduce((sum, entry) => sum + entry.count, 0);
  return {
    categories,
    objectId,
    objectName,
    totalDependents,
  };
}

export interface DeleteObjectImpactDialogProps {
  deleting?: boolean;
  impact: DeleteObjectImpactSummary;
  onConfirmDelete: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function DeleteObjectImpactDialog({
  deleting = false,
  impact,
  onConfirmDelete,
  onOpenChange,
  open,
}: DeleteObjectImpactDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="delete-object-impact-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete object &ldquo;{impact.objectName}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {impact.totalDependents > 0
              ? `Deleting "${impact.objectName}" affects ${impact.totalDependents} dependent item(s) in the session model.`
              : `Deleting "${impact.objectName}" permanently removes it from the current scene document.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {impact.categories.length > 0 ? (
          <div
            className="flex flex-col gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] p-3"
            data-slot="delete-object-impact-list"
          >
            {impact.categories.map((category) => (
              <div
                key={category.kind}
                className="flex flex-col gap-1"
                data-impact-kind={category.kind}
              >
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-[var(--fm-text-primary)]">
                  <span>{category.label}</span>
                  <Badge variant="warning">{category.count}</Badge>
                </div>
                <p className="text-xs text-[var(--fm-text-muted)]">
                  {category.items.slice(0, 5).join(", ")}
                  {category.items.length > 5
                    ? ` +${category.items.length - 5} more`
                    : ""}
                </p>
              </div>
            ))}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={deleting}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            variant="danger"
            onClick={onConfirmDelete}
          >
            {deleting ? "Deleting…" : "Delete Object"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Workspace-level host that presents `DeleteObjectImpactDialog` whenever
 * `geometry.delete-object` is triggered from any surface (Explorer context menu,
 * Ribbon, keyboard shortcut, Command Palette, or Inspector).
 */
export function DeleteObjectImpactDialogHost() {
  const request = useSyncExternalStore(
    deleteObjectDialogStore.subscribe,
    deleteObjectDialogStore.getSnapshot,
    deleteObjectDialogStore.getServerSnapshot,
  );

  useEffect(() => deleteObjectDialogStore.registerHost(), []);

  const liveScene = useSceneResource({ enabled: Boolean(request) });
  const sceneForImpact = liveScene.data ?? request?.scene ?? null;

  const impact = useMemo(
    () =>
      request
        ? analyzeDeleteObjectImpact(sceneForImpact, request.objectId)
        : null,
    [request, sceneForImpact],
  );

  if (!request || !impact) {
    return null;
  }

  return (
    <DeleteObjectImpactDialog
      impact={impact}
      open
      onConfirmDelete={() => {
        deleteObjectDialogStore.confirm(request.requestId);
      }}
      onOpenChange={(open) => {
        if (!open) {
          deleteObjectDialogStore.cancel(request.requestId);
        }
      }}
    />
  );
}
