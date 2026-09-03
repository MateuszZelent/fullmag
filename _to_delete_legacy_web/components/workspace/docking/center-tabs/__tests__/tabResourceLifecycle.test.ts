import { describe, expect, it } from "vitest";

import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";
import { resolveWorkspaceTabResourceDisposals } from "../tabResourceLifecycle";

function makeTab(patch: Partial<WorkspaceTab>): WorkspaceTab {
  return {
    id: "core:3d",
    key: "core:3d",
    kind: "viewport-3d",
    title: "3D Viewport",
    closable: false,
    pinned: true,
    mountPolicy: "active-only",
    payload: { viewMode: "3D" },
    ...patch,
  };
}

const stage: WorkspaceMode = "study";

describe("resolveWorkspaceTabResourceDisposals", () => {
  it("disposes a resource owner when a tab disappears", () => {
    expect(
      resolveWorkspaceTabResourceDisposals(
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d" }),
            makeTab({ id: "result:m", key: "result:m", kind: "result-quantity" }),
          ],
          activeTabId: "core:3d",
        },
        {
          stage,
          tabs: [makeTab({ id: "core:3d" })],
          activeTabId: "core:3d",
        },
      ),
    ).toEqual([
      {
        ownerId: "workspace:study:result:m",
        reason: "tab-close",
      },
    ]);
  });

  it("disposes the core 3D viewport on tab-hide", () => {
    expect(
      resolveWorkspaceTabResourceDisposals(
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({ id: "core:2d", key: "core:2d", kind: "viewport-2d" }),
          ],
          activeTabId: "core:3d",
        },
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({ id: "core:2d", key: "core:2d", kind: "viewport-2d" }),
          ],
          activeTabId: "core:2d",
        },
      ),
    ).toEqual([
      {
        ownerId: "workspace:study:core:3d",
        reason: "tab-hide",
      },
    ]);
  });

  it("disposes the core 2D viewport on tab-hide", () => {
    expect(
      resolveWorkspaceTabResourceDisposals(
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({ id: "core:2d", key: "core:2d", kind: "viewport-2d" }),
          ],
          activeTabId: "core:2d",
        },
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({ id: "core:2d", key: "core:2d", kind: "viewport-2d" }),
          ],
          activeTabId: "core:3d",
        },
      ),
    ).toEqual([
      {
        ownerId: "workspace:study:core:2d",
        reason: "tab-hide",
      },
    ]);
  });

  it("does not dispose a non-WebGL hidden-mounted tab on active tab switch", () => {
    expect(
      resolveWorkspaceTabResourceDisposals(
        {
          stage,
          tabs: [
            makeTab({ id: "core:analyze", key: "core:analyze", kind: "analyze", mountPolicy: "hidden-mounted" }),
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
          ],
          activeTabId: "core:analyze",
        },
        {
          stage,
          tabs: [
            makeTab({ id: "core:analyze", key: "core:analyze", kind: "analyze", mountPolicy: "hidden-mounted" }),
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
          ],
          activeTabId: "core:3d",
        },
      ),
    ).toEqual([]);
  });

  it("still disposes non-core WebGL tabs when they are hidden", () => {
    expect(
      resolveWorkspaceTabResourceDisposals(
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({
              id: "result:m",
              key: "result:m",
              kind: "result-quantity",
              title: "M",
              mountPolicy: "active-only",
            }),
          ],
          activeTabId: "result:m",
        },
        {
          stage,
          tabs: [
            makeTab({ id: "core:3d", kind: "viewport-3d" }),
            makeTab({
              id: "result:m",
              key: "result:m",
              kind: "result-quantity",
              title: "M",
              mountPolicy: "active-only",
            }),
          ],
          activeTabId: "core:3d",
        },
      ),
    ).toEqual([
      {
        ownerId: "workspace:study:result:m",
        reason: "tab-hide",
      },
    ]);
  });
});
