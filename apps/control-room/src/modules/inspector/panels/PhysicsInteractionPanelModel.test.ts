import { describe, expect, it } from "vitest";

import {
  buildInteractionPatch,
  defaultObjectInteractionResource,
  draftFromInteractionResource,
  formatInteractionParams,
  interactionLabel,
  isOptionalInteraction,
} from "./PhysicsInteractionPanelModel";

describe("PhysicsInteractionPanelModel", () => {
  it("labels canonical object interaction kinds without frontend-only aliases", () => {
    expect(interactionLabel("exchange")).toBe("Exchange");
    expect(interactionLabel("demag")).toBe("Demagnetization");
    expect(interactionLabel("interfacial_dmi")).toBe("Interfacial DMI");
    expect(interactionLabel("uniaxial_anisotropy")).toBe("Uniaxial anisotropy");
  });

  it("treats exchange and demag as required interactions", () => {
    expect(isOptionalInteraction("exchange")).toBe(false);
    expect(isOptionalInteraction("demag")).toBe(false);
    expect(isOptionalInteraction("interfacial_dmi")).toBe(true);
    expect(isOptionalInteraction("uniaxial_anisotropy")).toBe(true);
  });

  it("builds typed patch payloads from JSON parameter drafts", () => {
    expect(
      buildInteractionPatch({
        enabled: true,
        interactionKind: "uniaxial_anisotropy",
        paramsText: '{"ku1":1200,"axis":[0,0,1]}',
        present: true,
      }),
    ).toEqual({
      patch: {
        enabled: true,
        params: { axis: [0, 0, 1], ku1: 1200 },
        present: true,
      },
    });
  });

  it("rejects removing required interactions before hitting the backend", () => {
    expect(
      buildInteractionPatch({
        enabled: false,
        interactionKind: "exchange",
        paramsText: "{}",
        present: false,
      }),
    ).toEqual({
      error: "Exchange is required and cannot be removed.",
    });
  });

  it("reports malformed JSON parameter drafts", () => {
    expect(
      buildInteractionPatch({
        enabled: true,
        interactionKind: "interfacial_dmi",
        paramsText: "{",
        present: true,
      }),
    ).toEqual({
      error: "Interaction parameters must be a JSON object.",
    });
  });

  it("formats default absent optional resources for a selected object", () => {
    const resource = defaultObjectInteractionResource("free-layer", "interfacial_dmi");

    expect(resource).toEqual({
      enabled: false,
      interaction_kind: "interfacial_dmi",
      object_id: "free-layer",
      params: {},
      present: false,
    });
    expect(formatInteractionParams(resource.params)).toBe("{}");
  });

  it("starts absent required interactions as present and enabled drafts", () => {
    expect(
      draftFromInteractionResource(
        "exchange",
        defaultObjectInteractionResource("free-layer", "exchange"),
      ),
    ).toMatchObject({
      enabled: true,
      interactionKind: "exchange",
      present: true,
    });
  });
});
