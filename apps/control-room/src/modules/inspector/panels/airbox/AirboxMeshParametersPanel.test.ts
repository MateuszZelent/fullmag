import { describe, expect, it, vi } from "vitest";

import { draftFromUniverseMeshPolicyResource } from "./airboxMeshPolicyDraft";
import { submitAirboxPolicyDraft } from "./AirboxMeshParametersPanel";

describe("AirboxMeshParametersPanel apply boundary", () => {
  it("does not issue a replace request for an untouched absent policy", async () => {
    const replace = vi.fn();
    const draft = draftFromUniverseMeshPolicyResource({ config: null, effective_config: { mode: "auto" }, revision: 1 });

    await expect(submitAirboxPolicyDraft(draft, replace)).resolves.toEqual({ kind: "noop" });
    expect(replace).not.toHaveBeenCalled();
  });
});
