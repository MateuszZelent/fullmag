import { describe, expect, it } from "vitest";

import { readSelectionPath } from "@/kernel/selection/selectionPath";

import { findExplorerNodePath, publishExplorerNodePath } from "./explorerNodePath";
import type { ExplorerNode } from "./explorerTypes";

const node = (id: string, label: string, children: ExplorerNode[] = []): ExplorerNode =>
  ({ id, kind: "group", label, parentId: null, children }) as unknown as ExplorerNode;

const tree = [node("universe", "Universe", [node("airbox", "Airbox", [node("viz", "Visualization", [node("debug", "Debug")])])])];

describe("Explorer node path for the Inspector", () => {
  it("returns the root-first chain to the selected node", () => {
    expect(findExplorerNodePath(tree, "debug")?.map((entry) => entry.label)).toEqual([
      "Universe", "Airbox", "Visualization", "Debug",
    ]);
    expect(findExplorerNodePath(tree, "missing")).toBeNull();
  });

  it("keeps the published path identity when the chain is unchanged", () => {
    publishExplorerNodePath(tree, "viz");
    const first = readSelectionPath();
    publishExplorerNodePath(tree, "viz");
    expect(readSelectionPath()).toBe(first);
    expect(first?.crumbs.map((crumb) => crumb.label)).toEqual(["Universe", "Airbox", "Visualization"]);
    expect(first?.crumbs.at(-1)?.selection).toBeUndefined();
    expect(first?.crumbs[0]?.selection?.nodeId).toBe("universe");
    publishExplorerNodePath(tree, null);
    expect(readSelectionPath()).toBeNull();
  });
});
