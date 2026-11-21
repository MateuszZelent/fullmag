import { describe, expect, it, vi } from "vitest";

import { createViewport3DFrameCommitQueue } from "./viewport3DFrameCommitQueue";

describe("Viewport3DFrameCommitQueue", () => {
  it("retains every committed frame in order until the owner drains the queue", () => {
    const queue = createViewport3DFrameCommitQueue<{ airboxVisible: boolean }>();
    const onCommit = vi.fn();
    queue.subscribe(onCommit);

    queue.enqueue({ frameState: { airboxVisible: false }, revision: 4 });
    queue.enqueue({ frameState: { airboxVisible: true }, revision: 5 });

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(queue.drain()).toEqual([
      { frameState: { airboxVisible: false }, revision: 4 },
      { frameState: { airboxVisible: true }, revision: 5 },
    ]);
    expect(queue.drain()).toEqual([]);
  });
});
