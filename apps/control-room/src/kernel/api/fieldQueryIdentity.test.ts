import { describe, expect, it } from "vitest";

import {
  canonicalFieldVectorQuery,
  fieldVectorComponentsSemanticallyEqual,
  fieldVectorResourceKey,
  isCanonicalU64Decimal,
  parseCanonicalFieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "./fieldQueryIdentity";

describe("fieldQueryIdentity", () => {
  it.each([
    ["0", true],
    ["18446744073709551615", true],
    ["18446744073709551616", false],
    ["01", false],
    ["+1", false],
    ["-1", false],
    [" 1", false],
    ["1 ", false],
    ["1a", false],
    ["", false],
  ])("validates canonical u64 decimal string %j", (value, expected) => {
    expect(isCanonicalU64Decimal(value)).toBe(expected);
  });

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
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
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
      "/v2/sessions/current/data/fields/m/samples/vector?component=y&expected_carrier_revision=carrier-7&expected_generation_id=generation-3&geometry_scope=surface&max_samples=1200&phase_rad=1.5&scope_id=film&scope_kind=object&snapshot_id=snapshot-1&stage_id=stage-1&view=phase_rotated_real",
    );
  });

  it("keeps an owner-qualified FDM region request distinct in the resource identity", () => {
    const first = fieldVectorResourceKey("m", {
      component: "full",
      owner_object_id: "body-a",
      scope_id: "shared",
      scope_kind: "region",
    });
    const second = fieldVectorResourceKey("m", {
      component: "full",
      owner_object_id: "body-b",
      scope_id: "shared",
      scope_kind: "region",
    });

    expect(first).toBe(
      "/v2/sessions/current/data/fields/m/samples/vector?component=full&owner_object_id=body-a&scope_id=shared&scope_kind=region",
    );
    expect(second).not.toBe(first);
    expect(parseCanonicalFieldVectorResourceKey(first)).toMatchObject({
      ownerObjectId: "body-a",
      scopeId: "shared",
      scopeKind: "region",
    });
  });

  it("parses an exact recommended fetch regardless of query parameter order", () => {
    expect(
      parseCanonicalFieldVectorResourceKey(
        "/v2/sessions/current/data/fields/m/samples/vector?view=phase_rotated_real&stage_id=stage-1&scope_kind=object&scope_id=object%3Afilm&snapshot_id=snapshot-1&phase_rad=1.5&max_samples=1200&geometry_scope=surface&expected_generation_id=generation-3&expected_carrier_revision=carrier-7&component=y",
      ),
    ).toEqual(
      canonicalFieldVectorQuery("m", {
        component: "y",
        expected_carrier_revision: "carrier-7",
        expected_generation_id: "generation-3",
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

  it.each([
    ["x", "c0"],
    ["y", "c1"],
    ["z", "c2"],
    ["abs_x", "abs_c0"],
    ["expr:abs_y", "abs_c1"],
    ["expr:m2", "magnitude_squared"],
    ["expr:magnitude_squared", "magnitude_squared"],
    ["full", "full"],
    ["magnitude", "magnitude"],
  ])("treats %s and %s as the same component evidence", (left, right) => {
    expect(fieldVectorComponentsSemanticallyEqual(left, right)).toBe(true);
  });

  it("does not equate distinct component evidence", () => {
    expect(fieldVectorComponentsSemanticallyEqual("x", "c1")).toBe(false);
    expect(fieldVectorComponentsSemanticallyEqual("full", "magnitude")).toBe(false);
  });
});
