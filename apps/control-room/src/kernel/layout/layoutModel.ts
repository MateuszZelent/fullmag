import type { SlotId } from "../types";

type WorkspaceColumnId = Extract<
  SlotId,
  "panel-left" | "viewport-main" | "viewport-aux" | "panel-right"
>;

export interface WorkspaceColumnLayout {
  slotId: WorkspaceColumnId;
  label: string;
  defaultSize: string;
  minSize: string;
  maxSize?: string;
  resizeBehavior?: "preserve-pixel-size" | "preserve-relative-size";
}

export interface WorkspaceLayout {
  columns: WorkspaceColumnLayout[];
  bottomDockDefaultSize: number;
  bottomDockMinSize: number;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "fullmag.workspace.layout.v2";
export const WORKSPACE_LAYOUT_RESTORED_EVENT = "fullmag:workspace-layout-restored";

export interface WorkspaceInspectorWidthConstraints {
  minSize: string;
  maxSize: string;
}

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  columns: [
    {
      slotId: "panel-left",
      label: "Explorer",
      defaultSize: "20%",
      minSize: "16%",
    },
    {
      slotId: "viewport-main",
      label: "Viewport",
      defaultSize: "40%",
      minSize: "32%",
    },
    {
      slotId: "viewport-aux",
      label: "Section",
      defaultSize: "22%",
      minSize: "20%",
    },
    {
      slotId: "panel-right",
      label: "Inspector",
      defaultSize: "416px",
      minSize: "360px",
      maxSize: "560px",
      resizeBehavior: "preserve-pixel-size",
    },
  ],
  bottomDockDefaultSize: 22,
  bottomDockMinSize: 12,
};

/**
 * Keep the dock's preferred percentage minima while fitting the Inspector to
 * the measured panel group. Separator pixels are outside the panel budget.
 */
export function resolveWorkspaceInspectorWidthConstraints(
  columns: readonly WorkspaceColumnLayout[],
  groupWidth: number,
  separatorWidth: number,
): WorkspaceInspectorWidthConstraints {
  const inspector = columns.find((column) => column.slotId === "panel-right");
  if (!inspector || !Number.isFinite(groupWidth) || groupWidth <= 0) {
    return {
      minSize: inspector?.minSize ?? "360px",
      maxSize: inspector?.maxSize ?? "560px",
    };
  }

  const separators = Number.isFinite(separatorWidth)
    ? Math.max(0, separatorWidth)
    : 0;
  const panelWidth = Math.max(0, groupWidth - separators);
  const otherMinimums = columns
    .filter((column) => column.slotId !== "panel-right")
    .reduce(
      (minimum, column) => minimum + resolvePanelMinimum(column.minSize, groupWidth),
      0,
    );
  const inspectorBudget = Math.floor(
    Math.max(0, panelWidth - otherMinimums),
  );
  const minimumWidth = Math.min(360, inspectorBudget);
  const preferredMaximum = Math.max(
    360,
    Math.min(560, panelWidth * 0.38),
  );
  const maximumWidth = Math.max(
    minimumWidth,
    Math.min(inspectorBudget, Math.floor(preferredMaximum)),
  );

  return {
    minSize: `${minimumWidth}px`,
    maxSize: `${maximumWidth}px`,
  };
}

function resolvePanelMinimum(minSize: string, groupWidth: number): number {
  const percentage = /^(\d+(?:\.\d+)?)%$/.exec(minSize);
  if (percentage) return (Number(percentage[1]) / 100) * groupWidth;

  const pixels = /^(\d+(?:\.\d+)?)px$/.exec(minSize);
  if (pixels) return Number(pixels[1]);

  return 0;
}

function isWorkspaceColumnId(slotId: unknown): slotId is WorkspaceColumnId {
  return DEFAULT_WORKSPACE_LAYOUT.columns.some((column) => column.slotId === slotId);
}

export function moveWorkspaceColumn(
  layout: WorkspaceLayout,
  activeId: string,
  overId: string,
): WorkspaceLayout {
  const fromIndex = layout.columns.findIndex(
    (column) => column.slotId === activeId,
  );
  const toIndex = layout.columns.findIndex((column) => column.slotId === overId);

  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return layout;
  }

  const columns = [...layout.columns];
  const [movedColumn] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, movedColumn);

  return {
    ...layout,
    columns,
  };
}

export function resetWorkspaceLayout(): WorkspaceLayout {
  return DEFAULT_WORKSPACE_LAYOUT;
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  return JSON.stringify({
    columns: layout.columns.map((column) => column.slotId),
  });
}

export function restoreWorkspaceLayout(serializedLayout: string | null): WorkspaceLayout {
  if (!serializedLayout) {
    return DEFAULT_WORKSPACE_LAYOUT;
  }

  try {
    const parsedLayout: unknown = JSON.parse(serializedLayout);

    if (
      !parsedLayout ||
      typeof parsedLayout !== "object" ||
      !("columns" in parsedLayout) ||
      !Array.isArray(parsedLayout.columns)
    ) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }

    const slotIds = parsedLayout.columns as unknown[];
    const validSlotIds = new Set(
      DEFAULT_WORKSPACE_LAYOUT.columns.map((column) => column.slotId),
    );
    const storedSlotIds = new Set(slotIds);

    if (
      slotIds.length !== validSlotIds.size ||
      storedSlotIds.size !== validSlotIds.size ||
      slotIds.some((slotId) => !isWorkspaceColumnId(slotId))
    ) {
      return DEFAULT_WORKSPACE_LAYOUT;
    }

    const columnsById = new Map(
      DEFAULT_WORKSPACE_LAYOUT.columns.map((column) => [column.slotId, column]),
    );
    const columns = slotIds.map((slotId) => {
      if (!isWorkspaceColumnId(slotId)) {
        return DEFAULT_WORKSPACE_LAYOUT.columns[0];
      }

      return columnsById.get(slotId)!;
    });

    return {
      ...DEFAULT_WORKSPACE_LAYOUT,
      columns,
    };
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}
