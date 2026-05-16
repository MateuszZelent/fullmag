import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";

import {
  buildInteractionApplyPatch,
  defaultObjectInteractionResource,
  draftFromInteractionResource,
  draftFromStudyScene,
  draftKeyForInteraction,
  interactionLabel,
  interactionSelectOptions,
  isWritableObjectInteraction,
  isWritableStudyInteraction,
} from "./PhysicsInteractionPanelModel";

describe("PhysicsInteractionPanelModel", () => {
  it("lists backend interaction choices from the shared physics catalog", () => {
    expect(interactionSelectOptions().map((option) => option.id)).toEqual([
      "exchange",
      "demag",
      "zeeman",
      "current_transport",
      "spin_torque",
      "interfacial_dmi",
      "bulk_dmi",
      "uniaxial_anisotropy",
      "cubic_anisotropy",
      "oersted_field",
      "magnetoelastic",
    ]);
    expect(interactionLabel("oersted_field")).toBe("Regional field source");
  });

  it("classifies H_eff term toggles as study-level switches", () => {
    expect(isWritableObjectInteraction("exchange")).toBe(false);
    expect(isWritableObjectInteraction("demag")).toBe(false);
    expect(isWritableObjectInteraction("zeeman")).toBe(false);
    expect(isWritableStudyInteraction("exchange")).toBe(true);
    expect(isWritableStudyInteraction("demag")).toBe(true);
    expect(isWritableStudyInteraction("zeeman")).toBe(true);
  });

  it("creates typed object drafts and patches without JSON parameter text", () => {
    const resource = {
      ...defaultObjectInteractionResource("free-layer", "uniaxial_anisotropy"),
      enabled: true,
      params: { axis: [1, 0, 0], ku1: 1200 },
      present: true,
    };
    const draft = draftFromInteractionResource("uniaxial_anisotropy", resource);

    expect(draft).toMatchObject({
      enabled: true,
      id: "uniaxial_anisotropy",
      present: true,
      values: { axis: ["1", "0", "0"], ku1: "1200" },
    });
    expect(buildInteractionApplyPatch(draft)).toEqual({
      patch: {
        enabled: true,
        params: { axis: [1, 0, 0], ku1: 1200, ku2: 0 },
        present: true,
      },
      storage: "object_interaction",
    });
  });

  it("creates global study drafts for exchange, demag, and uniform Zeeman", () => {
    const scene = {
      revision: 4,
      study: {
        exchange_enabled: false,
        demag_enabled: false,
        demag_realization: "poisson_robin",
        external_field: [0.01, 0, -0.002],
      },
    } as unknown as SceneResource;

    expect(draftFromStudyScene("exchange", scene)).toMatchObject({
      enabled: false,
      id: "exchange",
      present: true,
    });
    expect(buildInteractionApplyPatch(draftFromStudyScene("exchange", scene))).toEqual({
      patch: { study: { exchange_enabled: false } },
      storage: "study",
    });
    expect(draftFromStudyScene("demag", scene)).toMatchObject({
      enabled: false,
      id: "demag",
      values: { method: "poisson_robin" },
    });
    expect(buildInteractionApplyPatch(draftFromStudyScene("demag", scene))).toEqual({
      patch: { study: { demag_enabled: false, demag_realization: "poisson_robin" } },
      storage: "study",
    });
    const zeeman = draftFromStudyScene("zeeman", scene);

    expect(zeeman).toMatchObject({
      enabled: true,
      id: "zeeman",
      present: true,
      values: { field: ["0.01", "0", "-0.002"] },
    });
    expect(buildInteractionApplyPatch(zeeman)).toEqual({
      patch: { study: { external_field: [0.01, 0, -0.002] } },
      storage: "study",
    });
  });

  it("rejects deferred backend terms before hitting the API", () => {
    expect(
      buildInteractionApplyPatch({
        enabled: true,
        id: "oersted_field",
        present: true,
        values: {
          axis: ["0", "0", "1"],
          current: "0",
          current_density: ["0", "0", "0"],
          radius: "0",
          region_id: "region:free-layer",
          source_mode: "antenna_field_source",
          source_name: "drive",
        },
      }),
    ).toEqual({
      error:
        "Regional field sources need a dedicated source/current-module authoring resource before control-room edits are safe.",
    });
  });

  it("uses stable draft keys for scene-backed global settings", () => {
    const draft = draftFromStudyScene("demag", {
      study: { demag_realization: "poisson_dirichlet" },
    } as unknown as SceneResource);

    expect(draftKeyForInteraction("body", draft)).toContain("demag");
    expect(draftKeyForInteraction("body", draft)).toContain("poisson_dirichlet");
  });
});
