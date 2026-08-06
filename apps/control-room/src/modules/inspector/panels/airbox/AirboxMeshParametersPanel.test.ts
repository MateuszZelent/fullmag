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

  it("passes the FDM lane through to the policy serializer", async () => {
    const replace = vi.fn(async (request) => ({ config: request.config, effective_config: null, revision: 2 }));
    const draft = {
      ...draftFromUniverseMeshPolicyResource({
        config: { airbox_hmax: 1e-9, mode: "manual" },
        revision: 1,
      }),
      airboxHmax: "-1",
      airboxMode: "manual",
    };

    await expect(submitAirboxPolicyDraft(draft, replace, { lane: "fdm" })).resolves.toMatchObject({
      kind: "submitted",
      resource: { config: { mode: "manual" } },
    });
  });
});
