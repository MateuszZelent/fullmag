import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { allInteractionSpecs } from "@/shared/domain/physics/interactions";

import { commitObjectInteractionMutation } from "./PhysicsInteractionPanel.model";

describe("PhysicsInteractionPanel lane contract", () => {
  it("invalidates from the final object interaction ACK without a synthetic fallback", async () => {
    const patch = vi.fn(async () => ({ scene_revision: 41 }));
    const invalidate = vi.fn();

    await expect(
      commitObjectInteractionMutation({
        interactionKind: "uniaxial_anisotropy",
        objectId: "body",
        patch,
        resources: { invalidate },
      }),
    ).resolves.toBe(41);

    expect(patch).toHaveBeenCalledTimes(1);
    for (const resourceKey of [
      MODEL_SCENE_PATH,
      MODEL_READINESS_PATH,
      MODEL_STUDY_PATH,
      SESSION_STATUS_RESOURCE_KEY,
    ]) {
      expect(invalidate).toHaveBeenCalledWith(resourceKey, 41);
      expect(
        invalidate.mock.calls.filter(([key]) => key === resourceKey),
      ).toHaveLength(1);
    }
  });

  it("fails closed when the interaction ACK omits scene_revision", async () => {
    await expect(
      commitObjectInteractionMutation({
        interactionKind: "uniaxial_anisotropy",
        objectId: "body",
        patch: async () => ({}),
        resources: { invalidate: vi.fn() },
      }),
    ).rejects.toThrow("Authoring mutation ACK omitted the scene revision.");
  });

  it("links every physics interaction help dialog to an existing documentation source page", () => {
    for (const spec of allInteractionSpecs()) {
      expect(spec.docsPage, spec.id).toMatch(/^physics\/interactions\/.+\.html$/);
      const mdRelPath = spec.docsPage!.replace(/\.html$/, ".md");
      const mdUrl = new URL(
        `../../../../../../public_docs/site/${mdRelPath}`,
        import.meta.url,
      );
      expect(existsSync(mdUrl), `${spec.id} -> ${mdRelPath}`).toBe(true);
    }
  });
});
