import { describe, expect, it } from "vitest";

import { ALL_MODULES } from "@/modules";

import { footerManifest } from "./manifest";

describe("footerManifest", () => {
  it("mounts the transport footer in the bottom panel slot", () => {
    expect(footerManifest).toMatchObject({
      id: "transport-footer",
      slots: ["panel-bottom"],
      title: "Transport Footer",
    });
    expect(ALL_MODULES.map((manifest) => manifest.id)).toContain(
      "transport-footer",
    );
  });
});
