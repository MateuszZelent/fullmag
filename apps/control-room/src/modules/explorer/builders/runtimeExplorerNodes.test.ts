import { describe, expect, it } from "vitest";

import { buildRuntimeDiagnosticTree } from "./diagnosticExplorerNodes";
import { buildRuntimeJobTree } from "./jobExplorerNodes";
import { buildRuntimeResourceTree } from "./resourceExplorerNodes";

describe("runtime-backed Explorer tabs", () => {
  it("does not fabricate resources, jobs, or diagnostics without owner resources", () => {
    expect(buildRuntimeResourceTree({})[0]).toMatchObject({ children: [], status: "unavailable" });
    expect(buildRuntimeJobTree({})[0]).toMatchObject({ children: [], status: "unavailable" });
    expect(buildRuntimeDiagnosticTree({})[0]).toMatchObject({ children: [], status: "unavailable" });
  });
});
