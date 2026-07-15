import { describe, expect, it } from "vitest";

import {
  canonicalFieldVectorQuery,
  fieldVectorResourceKey,
  parseCanonicalFieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "./fieldQueryIdentity";

describe("fieldQueryIdentity", () => {
  it("builds a vector resource key through the canonical API path", () => {
    expect(
      fieldVectorResourceKey("m", {
        component: "full",
        scope_id: "part-a",
        scope_kind: "part",
      }),
    ).toBe(
      "/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_id=part-a&scope_kind=part",
    );
  });
  it("normalizes object target ids while preserving exact mesh part ids", () => {
    expect(
      canonicalFieldVectorQuery("m", {
        component: "x",
        scope_id: "object:film",
        scope_kind: "object",
      }),
    ).toMatchObject({ quantityId: "m", scopeId: "film", scopeKind: "object" });
    expect(
      canonicalFieldVectorQuery("m", {
        component: "x",
        scope_id: "part:film_mesh",
        scope_kind: "part",
      }),
    ).toMatchObject({ quantityId: "m", scopeId: "part:film_mesh", scopeKind: "part" });
    expect(
      serializeCanonicalFieldVectorResourceKey(
        canonicalFieldVectorQuery("m", {
          component: "x",
          scope_id: "part:film_mesh",
          scope_kind: "part",
        }),
      ),
    ).toContain("scope_id=part%3Afilm_mesh&scope_kind=part");
  });

  it("serializes every field-vector identity dimension in a stable order", () => {
    const key = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("m", {
        component: "y",
        geometry_scope: "surface",
        max_samples: 1200,
        phase_rad: 1.5,
        scope_id: "object:film",
        scope_kind: "object",
        snapshot_id: "snapshot-1",
        stage_id: "stage-1",
        view: "phase_rotated_real",
      }),
    );

    expect(key).toBe(
      "/v2/sessions/current/data/fields/m/samples/vector?component=y&geometry_scope=surface&max_samples=1200&phase_rad=1.5&scope_id=film&scope_kind=object&snapshot_id=snapshot-1&stage_id=stage-1&view=phase_rotated_real",
    );
  });

  it("parses an exact recommended fetch regardless of query parameter order", () => {
    expect(
      parseCanonicalFieldVectorResourceKey(
        "/v2/sessions/current/data/fields/m/samples/vector?view=phase_rotated_real&stage_id=stage-1&scope_kind=object&scope_id=object%3Afilm&snapshot_id=snapshot-1&phase_rad=1.5&max_samples=1200&geometry_scope=surface&component=y",
      ),
    ).toEqual(
      canonicalFieldVectorQuery("m", {
        component: "y",
        geometry_scope: "surface",
        max_samples: 1200,
        phase_rad: 1.5,
        scope_id: "film",
        scope_kind: "object",
        snapshot_id: "snapshot-1",
        stage_id: "stage-1",
        view: "phase_rotated_real",
      }),
    );
  });
});
