import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("viewport3dColorTransformScheduler", () => {
  it("aborts one color transform without disposing the shared worker", () => {
    const source = readFileSync(
      new URL("./viewport3dColorTransformScheduler.ts", import.meta.url),
      "utf8",
    );
    const abortStart = source.indexOf("const abortListener = signal");
    const pendingSetStart = source.indexOf("this.pending.set(id", abortStart);
    const abortBlock = source.slice(abortStart, pendingSetStart);

    expect(abortBlock).toContain("this.abortPending(id)");
    expect(abortBlock).not.toContain("this.dispose(createAbortError())");
  });
});
