import { describe, expect, it } from "vitest";

import {
  canonicalFieldVectorQuery,
  parseCanonicalFieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "./fieldQueryIdentity";

describe("fieldQueryIdentity", () => {
  it("normalizes prefixed object and part scopes into one transport identity", () => {
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
    ).toMatchObject({ quantityId: "m", scopeId: "film_mesh", scopeKind: "part" });
  });

  it("serializes every field-vector identity dimension in a stable order", () => {
    const key = serializeCanonicalFieldVectorResourceKey(
      canonicalFieldVectorQuery("m", {
        component: "y",
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
      "/v2/sessions/current/data/fields/m/samples/vector?component=y&max_samples=1200&phase_rad=1.5&scope_id=film&scope_kind=object&snapshot_id=snapshot-1&stage_id=stage-1&view=phase_rotated_real",
    );
  });

  it("parses an exact recommended fetch regardless of query parameter order", () => {
    expect(
      parseCanonicalFieldVectorResourceKey(
        "/v2/sessions/current/data/fields/m/samples/vector?view=phase_rotated_real&stage_id=stage-1&scope_kind=object&scope_id=object%3Afilm&snapshot_id=snapshot-1&phase_rad=1.5&max_samples=1200&component=y",
      ),
    ).toEqual(
      canonicalFieldVectorQuery("m", {
        component: "y",
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
