import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrapWorkflow = readFileSync(
  join(process.cwd(), "../../.github/workflows/bootstrap.yml"),
  "utf8",
);

describe("compute performance CI coverage", () => {
  it("runs the compute-performance audit in the control-room bootstrap lane", () => {
    expect(bootstrapWorkflow).toContain("Check control-room compute performance");
    expect(bootstrapWorkflow).toContain(
      "pnpm --dir apps/control-room audit:compute-performance",
    );
  });
});
