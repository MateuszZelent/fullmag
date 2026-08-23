import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
} from "@/kernel/api/apiPaths";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";

import { commitObjectInteractionMutation } from "./PhysicsInteractionPanel";

describe("PhysicsInteractionPanel lane contract", () => {
  it("uses the resolved interaction catalog and blocks unresolved writes", () => {
    const source = readFileSync(
      new URL("./PhysicsInteractionPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("useActiveLaneCapabilities(");
    expect(source).toContain("resolveActiveLaneOperation(");
    expect(source).toContain("interactionSpecsForDiscretization(");
    expect(source).toContain("validateInteractionDraftForDiscretization(");
    expect(source).toContain('if (interactionDiscretization === "unknown")');
    expect(source).not.toContain("interactionSelectOptions()");
    expect(source).not.toContain("AIRBOX_VISUALIZATION_TARGET");
  });

  it("guards the write path with the authoritative active-lane operation", () => {
    const source = readFileSync(
      new URL("./PhysicsInteractionPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!activeLaneOperation.enabled)");
    expect(source).toContain("activeLaneOperation.reason");
  });

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
    const source = readFileSync(
      new URL("./PhysicsInteractionPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("Date.now()");
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
});
