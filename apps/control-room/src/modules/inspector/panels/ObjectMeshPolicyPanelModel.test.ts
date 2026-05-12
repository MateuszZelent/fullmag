import { describe, expect, it } from "vitest";

import {
  buildObjectMeshPolicyReplaceRequest,
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  draftKeyForObjectMeshPolicyResource,
  formatObjectMeshPolicyConfig,
} from "./ObjectMeshPolicyPanelModel";

describe("ObjectMeshPolicyPanelModel", () => {
  it("formats nullable backend config as an editable object draft", () => {
    expect(formatObjectMeshPolicyConfig(null)).toBe("{}");
    expect(
      formatObjectMeshPolicyConfig({
        curvature_factor: 0.3,
        maximum_element_size: 5e-9,
      }),
    ).toContain("\"maximum_element_size\": 5e-9");
  });

  it("creates drafts and stable keys from the backend object policy resource", () => {
    const absent = defaultObjectMeshPolicyResource("free-layer");
    const present = {
      config: { maximum_element_size: 5e-9 },
      object_id: "free-layer",
      revision: 7,
    };

    expect(draftFromObjectMeshPolicyResource(absent)).toEqual({
      configText: "{}",
      present: false,
    });
    expect(draftFromObjectMeshPolicyResource(present)).toEqual({
      configText: "{\n  \"maximum_element_size\": 5e-9\n}",
      present: true,
    });
    expect(draftKeyForObjectMeshPolicyResource("free-layer", present)).toBe(
      "free-layer:7:{\n  \"maximum_element_size\": 5e-9\n}",
    );
  });

  it("builds a replace request for enabled and disabled object mesh policies", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest({
        configText: "{ \"maximum_element_size\": 5e-9 }",
        present: true,
      }),
    ).toEqual({
      request: { config: { maximum_element_size: 5e-9 } },
    });

    expect(
      buildObjectMeshPolicyReplaceRequest({
        configText: "{ \"maximum_element_size\": 5e-9 }",
        present: false,
      }),
    ).toEqual({
      request: { config: null },
    });
  });

  it("rejects malformed and non-object mesh policy config drafts", () => {
    expect(
      buildObjectMeshPolicyReplaceRequest({
        configText: "[1, 2, 3]",
        present: true,
      }),
    ).toEqual({
      error: "Object mesh policy config must be a JSON object.",
    });

    expect(
      buildObjectMeshPolicyReplaceRequest({
        configText: "{",
        present: true,
      }),
    ).toEqual({
      error: "Object mesh policy config must be a JSON object.",
    });
  });
});
