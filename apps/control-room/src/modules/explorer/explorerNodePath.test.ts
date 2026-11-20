import { describe, expect, it } from "vitest";

import { findExplorerNodePath, publishExplorerNodePath, readExplorerNodePath } from "./explorerNodePath";
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
    const first = readExplorerNodePath();
    publishExplorerNodePath(tree, "viz");
    expect(readExplorerNodePath()).toBe(first);
    publishExplorerNodePath(tree, null);
    expect(readExplorerNodePath()).toBeNull();
  });
});
