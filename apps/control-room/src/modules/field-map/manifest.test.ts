import { describe, expect, it } from "vitest";

import { fieldMapManifest } from "./manifest";

describe("field-map manifest", () => {
  it("registers one viewport module backed by shared commands", () => {
    expect(fieldMapManifest).toMatchObject({
      id: "field-map",
      slots: ["viewport-main"],
      title: "2D View",
      version: "1.0.0",
    });
    expect(
      fieldMapManifest.contributes?.commands?.map((command) => command.id),
    ).toEqual(
      expect.arrayContaining([
        "field-map.open",
        "field-map.fit",
        "field-map.export-png",
        "field-map.toggle-vectors",
      ]),
    );
  });
});
