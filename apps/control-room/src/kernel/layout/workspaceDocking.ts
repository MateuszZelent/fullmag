import type { DockEdge } from "./viewportDocking";

export const WORKSPACE_TREE_KEY = "fullmag.workspace.dock-tree.v1";
export const workspacePaneIds = ["panel-left", "viewport-main", "panel-right", "panel-bottom", "viewport-aux"] as const;
export type WorkspacePaneId = typeof workspacePaneIds[number];
export type WorkspaceDockTree = { kind: "pane"; pane: WorkspacePaneId } | {
  kind: "split"; id: string; axis: "horizontal" | "vertical"; ratio: number;
  first: WorkspaceDockTree; second: WorkspaceDockTree;
};
const pane = (id: WorkspacePaneId): WorkspaceDockTree => ({ kind: "pane", pane: id });
export function defaultWorkspaceTree(): WorkspaceDockTree {
  return { kind: "split", id: "workspace-root", axis: "vertical", ratio: 78,
    first: { kind: "split", id: "workspace-main", axis: "horizontal", ratio: 20,
      first: pane("panel-left"), second: { kind: "split", id: "workspace-right", axis: "horizontal", ratio: 70,
        first: { kind: "split", id: "workspace-center", axis: "horizontal", ratio: 70,
          first: pane("viewport-main"), second: pane("viewport-aux") }, second: pane("panel-right") } },
    second: pane("panel-bottom") };
}
export function paneIds(tree: WorkspaceDockTree | null): WorkspacePaneId[] {
  return !tree ? [] : tree.kind === "pane" ? [tree.pane] : [...paneIds(tree.first), ...paneIds(tree.second)];
}
/** Filtering affects anchors only. The full tree preserves hidden/floating positions. */
export function filterWorkspaceTree(tree: WorkspaceDockTree, keep: (id: WorkspacePaneId) => boolean): WorkspaceDockTree | null {
  if (tree.kind === "pane") return keep(tree.pane) ? tree : null;
  const first = filterWorkspaceTree(tree.first, keep), second = filterWorkspaceTree(tree.second, keep);
  return first && second ? { ...tree, first, second } : first ?? second;
}
export function dockWorkspacePane(tree: WorkspaceDockTree, source: WorkspacePaneId, target: WorkspacePaneId | null, edge: DockEdge, splitId: string): WorkspaceDockTree {
  if (source === target || (target && !paneIds(tree).includes(target))) return tree;
  const remaining = filterWorkspaceTree(tree, id => id !== source);
  if (!remaining) return pane(source);
  const wrap = (other: WorkspaceDockTree): WorkspaceDockTree => {
    const leading = edge === "left" || edge === "top";
    return { kind: "split", id: splitId, axis: edge === "left" || edge === "right" ? "horizontal" : "vertical", ratio: 50,
      first: leading ? pane(source) : other, second: leading ? other : pane(source) };
  };
  if (!target) return wrap(remaining);
  const insert = (node: WorkspaceDockTree): WorkspaceDockTree => node.kind === "pane"
    ? (node.pane === target ? wrap(node) : node)
    : { ...node, first: insert(node.first), second: insert(node.second) };
  return insert(remaining);
}
export function resizeWorkspaceSplit(tree: WorkspaceDockTree, id: string, ratio: number): WorkspaceDockTree {
  if (tree.kind === "pane" || !Number.isFinite(ratio) || ratio < 5 || ratio > 95) return tree;
  if (tree.id === id) return Math.abs(tree.ratio - ratio) < .05 ? tree : { ...tree, ratio };
  const first = resizeWorkspaceSplit(tree.first, id, ratio), second = resizeWorkspaceSplit(tree.second, id, ratio);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}
export function restoreWorkspaceTree(raw: string | null): WorkspaceDockTree {
  try {
    if (!raw || raw.length > 12000) return defaultWorkspaceTree();
    const ids = new Set<string>(), panes = new Set<string>();
    const parse = (value: unknown, depth: number): WorkspaceDockTree => {
      if (!value || typeof value !== "object" || depth > 8) throw Error("Invalid dock tree");
      const n = value as Record<string, unknown>;
      if (n.kind === "pane" && workspacePaneIds.includes(n.pane as WorkspacePaneId) && !panes.has(String(n.pane))) {
        panes.add(String(n.pane)); return pane(n.pane as WorkspacePaneId);
      }
      if (n.kind !== "split" || typeof n.id !== "string" || !n.id || n.id.length > 128 || ids.has(n.id)
        || (n.axis !== "horizontal" && n.axis !== "vertical") || typeof n.ratio !== "number" || !Number.isFinite(n.ratio) || n.ratio < 5 || n.ratio > 95) throw Error("Invalid dock split");
      ids.add(n.id);
      return { kind: "split", id: n.id, axis: n.axis, ratio: n.ratio, first: parse(n.first, depth+1), second: parse(n.second, depth+1) };
    };
    const tree = parse(JSON.parse(raw), 0);
    return panes.size === workspacePaneIds.length ? tree : defaultWorkspaceTree();
  } catch { return defaultWorkspaceTree(); }
}
