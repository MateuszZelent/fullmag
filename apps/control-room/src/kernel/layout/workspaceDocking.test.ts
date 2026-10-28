import { describe, expect, it } from "vitest";
import { defaultWorkspaceTree, dockWorkspacePane, filterWorkspaceTree, paneIds, resizeWorkspaceSplit, restoreWorkspaceTree, workspacePaneIds } from "./workspaceDocking";
import type { DockEdge } from "./viewportDocking";

describe("workspace docking tree", () => {
  it("preserves exactly one leaf per panel for every source, target and edge", () => {
    for (const source of workspacePaneIds) for (const target of [null, ...workspacePaneIds]) for (const edge of ["left","right","top","bottom"] as DockEdge[]) {
      const before=defaultWorkspaceTree();const after=dockWorkspacePane(before,source,target,edge,"drop-1");
      expect([...paneIds(after)].sort()).toEqual([...workspacePaneIds].sort());
      expect(restoreWorkspaceTree(JSON.stringify(after))).toEqual(after);
      expect(before).toEqual(defaultWorkspaceTree());
    }
  });
  it("can dock diagnostics above Inspector and then Explorer to its right", () => {
    const first=dockWorkspacePane(defaultWorkspaceTree(),"panel-bottom","panel-right","top","drop-1");
    const next=dockWorkspacePane(first,"panel-left","panel-bottom","right","drop-2");
    expect(paneIds(next).slice(-3)).toEqual(["panel-bottom","panel-left","panel-right"]);
    expect(JSON.stringify(next)).toContain('"id":"drop-2","axis":"horizontal","ratio":50');
  });
  it("removes only anchors when floating/hidden and restores their saved position", () => {
    const full=defaultWorkspaceTree();const filtered=filterWorkspaceTree(full,id=>id!=="panel-right"&&id!=="viewport-aux");
    expect(paneIds(filtered)).toEqual(["panel-left","viewport-main","panel-bottom"]);
    expect(paneIds(full)).toHaveLength(5);
    expect(filterWorkspaceTree(full,()=>false)).toBeNull();
  });
  it("resizes only the matching split and ignores stale or invalid callbacks", () => {
    const full=defaultWorkspaceTree();const changed=resizeWorkspaceSplit(full,"workspace-root",65);
    expect(changed).toMatchObject({ratio:65});
    expect(resizeWorkspaceSplit(changed,"removed-split",42)).toBe(changed);
    expect(resizeWorkspaceSplit(full,"workspace-root",NaN)).toBe(full);
    expect(resizeWorkspaceSplit(full,"workspace-root",0)).toBe(full);
  });
  it("fails closed for missing/duplicate panes, invalid sizes and malformed preferences", () => {
    for (const raw of [null,"broken",JSON.stringify({kind:"pane",pane:"viewport-main"}),JSON.stringify({...defaultWorkspaceTree(),ratio:200}),JSON.stringify({kind:"split",id:"duplicate",axis:"horizontal",ratio:50,first:{kind:"pane",pane:"panel-left"},second:{kind:"pane",pane:"panel-left"}})])
      expect(restoreWorkspaceTree(raw)).toEqual(defaultWorkspaceTree());
  });
  it("keeps the complete layout through a JSON round trip", () => {
    let tree=defaultWorkspaceTree();
    for (const [i,id] of workspacePaneIds.entries()) tree=dockWorkspacePane(tree,id,null,i%2?"left":"bottom",`move-${i}`);
    expect(restoreWorkspaceTree(JSON.stringify(tree))).toEqual(tree);
    expect(new Set(paneIds(tree)).size).toBe(5);
  });
});
