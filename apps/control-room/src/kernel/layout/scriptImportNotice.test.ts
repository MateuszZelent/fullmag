import { describe, expect, it } from "vitest";

import { describeScriptImportNotice } from "./scriptImportNotice";

describe("describeScriptImportNotice", () => {
  it("names the project, the script and the hash prefix, and carries the verdict", () => {
    const view = describeScriptImportNotice({
      projectId: "p",
      projectName: "SP5",
      scriptName: "sp5.py",
      sha256: "0123456789abcdef".repeat(4),
      origin: "script_file",
      fidelity: { scene_exported: true, round_trip: "failed", notes: ["study stages differ"] },
    });
    expect(view.summary).toBe("SP5 was created from sp5.py (0123456789ab).");
    expect(view.fidelity.headline).toBe("Round trip failed");
    expect(view.fidelity.notes).toEqual(["study stages differ"]);
  });
});
