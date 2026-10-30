export type DockEdge = "left" | "right" | "top" | "bottom";
export interface DockArea { left: number; top: number; width: number; height: number }
export interface DockPointer { x: number; y: number }

/** Client-coordinate edge hit test; corners choose the nearest edge, not a quarter. */
export function hitTestDockEdge(area: DockArea, point: DockPointer): DockEdge | null {
  if (![area.left, area.top, area.width, area.height, point.x, point.y].every(Number.isFinite)
    || area.width <= 0 || area.height <= 0) return null;
  const x = point.x - area.left, y = point.y - area.top;
  const tolerance = 24;
  if (x < -tolerance || x > area.width + tolerance || y < -tolerance || y > area.height + tolerance) return null;
  const distances: [DockEdge, number, number][] = [
    ["left", Math.abs(x), Math.min(32, area.width / 4)],
    ["right", Math.abs(area.width - x), Math.min(32, area.width / 4)],
    ["top", Math.abs(y), Math.min(32, area.height / 4)],
    ["bottom", Math.abs(area.height - y), Math.min(32, area.height / 4)],
  ];
  return distances.filter(([, distance, threshold]) => distance <= threshold)
    .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
}

/** Preserve a visible neighbour; displaced docked views become floating. */
export function planViewportDock(draggedId: string, edge: DockEdge, selectedIds: string[], visibleIds: string[], dockedIds: string[]) {
  const other = [...dockedIds, ...selectedIds, ...visibleIds]
    .find(id => id !== draggedId && visibleIds.includes(id)) ?? null;
  const first = edge === "left" || edge === "top";
  return {
    primaryId: first || !other ? draggedId : other,
    companionId: other ? (first ? other : draggedId) : null,
    placement: edge === "left" || edge === "right" ? "beside" as const : "below" as const,
    displacedIds: selectedIds.filter(id => id !== draggedId && id !== other && visibleIds.includes(id)),
  };
}
