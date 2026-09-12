const FIELD_FRAME_ID_CACHE = new WeakMap<object, number>();
let NEXT_FIELD_FRAME_ID = 1;

export type WorkspaceTabViewMode = "3D" | "2D" | "Mesh" | "Analyze";

function normalizeWorkspaceTabPayloadViewMode(
  value: string | null | undefined,
): "3D" | "2D" | "Mesh" | "Analyze" | null {
  return value === "3D" ||
    value === "2D" ||
    value === "Mesh" ||
    value === "Analyze"
    ? value
    : null;
}

export function formatQuantityOptionLabel(quantity: {
  label: string;
  unit: string | null | undefined;
}): string {
  return quantity.unit && quantity.unit !== "dimensionless"
    ? `${quantity.label} (${quantity.unit})`
    : quantity.label;
}

export function isQuantitySelectable(quantity: {
  interactive_preview: boolean;
  supports_preview_2d: boolean;
  supports_preview_3d: boolean;
}): boolean {
  return Boolean(
    quantity.interactive_preview &&
      (quantity.supports_preview_2d || quantity.supports_preview_3d),
  );
}

export function fieldFrameIdentity(value: object | null | undefined): string {
  if (!value) {
    return "none";
  }
  let id = FIELD_FRAME_ID_CACHE.get(value);
  if (!id) {
    id = NEXT_FIELD_FRAME_ID++;
    FIELD_FRAME_ID_CACHE.set(value, id);
  }
  return String(id);
}

export function vectorHead(values: Float64Array | null | undefined): [number, number, number] | null {
  if (!values || values.length < 3) {
    return null;
  }
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

export function resolveViewModeSyncFromWorkspaceTab(args: {
  activeTabId: string | null;
  payloadViewMode?: string | null;
  currentViewMode: WorkspaceTabViewMode;
}): WorkspaceTabViewMode | null {
  const payloadMode = normalizeWorkspaceTabPayloadViewMode(args.payloadViewMode);

  if (payloadMode === "Mesh") {
    return args.currentViewMode === "Mesh" ? null : "Mesh";
  }
  if (payloadMode === "3D") {
    return args.currentViewMode === "3D" || args.currentViewMode === "Mesh" ? null : "3D";
  }
  if (payloadMode === "2D") {
    return args.currentViewMode === "2D" ? null : "2D";
  }
  if (payloadMode === "Analyze") {
    return args.currentViewMode === "Analyze" ? null : "Analyze";
  }
  return null;
}

export function workspaceTabViewSyncKey(args: {
  activeTabId: string | null;
  payloadViewMode?: string | null;
}): string {
  const normalizedPayloadMode =
    normalizeWorkspaceTabPayloadViewMode(args.payloadViewMode) ?? "none";
  return `${args.activeTabId ?? "none"}:${normalizedPayloadMode}`;
}

export function resolveViewModeSyncFromWorkspaceTabChange(args: {
  previousSyncKey: string | null;
  pendingInternalSyncKey?: string | null;
  activeTabId: string | null;
  payloadViewMode?: string | null;
  currentViewMode: WorkspaceTabViewMode;
}): {
  nextMode: WorkspaceTabViewMode | null;
  nextSyncKey: string;
  consumedInternalSyncKey: boolean;
} {
  const nextSyncKey = workspaceTabViewSyncKey({
    activeTabId: args.activeTabId,
    payloadViewMode: args.payloadViewMode,
  });
  if (args.pendingInternalSyncKey === nextSyncKey) {
    return {
      nextMode: null,
      nextSyncKey,
      consumedInternalSyncKey: true,
    };
  }
  if (args.previousSyncKey === nextSyncKey) {
    return {
      nextMode: null,
      nextSyncKey,
      consumedInternalSyncKey: false,
    };
  }
  return {
    nextMode: resolveViewModeSyncFromWorkspaceTab({
      activeTabId: args.activeTabId,
      payloadViewMode: args.payloadViewMode,
      currentViewMode: args.currentViewMode,
    }),
    nextSyncKey,
    consumedInternalSyncKey: false,
  };
}
