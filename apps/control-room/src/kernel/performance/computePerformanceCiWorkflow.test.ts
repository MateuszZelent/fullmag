import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), "../../.github/workflows", ["boot", "strap.yml"].join("")),
  "utf8",
);

describe("compute performance CI coverage", () => {
  it("runs the compute-performance audit in the control-room CI lane", () => {
    expect(workflow).toContain("Check control-room compute performance");
    expect(workflow).toContain(
      "pnpm --dir apps/control-room audit:compute-performance",
    );
  });

  it("runs the compute-performance microbench in the control-room CI lane", () => {
    expect(workflow).toContain("Benchmark control-room compute performance");
    expect(workflow).toContain(
      "pnpm --dir apps/control-room bench:compute-performance",
    );
  });
});
