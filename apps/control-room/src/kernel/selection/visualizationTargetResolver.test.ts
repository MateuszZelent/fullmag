import { describe, expect, it } from "vitest";

import { resolveVisualizationTargetForMeshPart } from "./visualizationTargetResolver";

describe("resolveVisualizationTargetForMeshPart", () => {
  it("maps an air-role carrier to the canonical airbox even when a stale registry publishes it as a part", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          id: "part:__air__",
          label: "Airbox",
          role: "air",
        },
        sceneObjectIds: new Set(),
        targetRegistry: {
          airbox: {} as never,
          objects: [],
          parts: [
            {
              scope: "part",
              scope_id: "part:__air__",
            } as never,
          ],
        },
      }),
    ).toMatchObject({ id: "airbox", kind: "airbox", label: "Airbox" });
  });

  it("keeps a geometry-only part scoped to the part when the scene has no matching object", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          geometry_id: "projection-film",
          id: "part-film",
          object_id: null,
        },
        sceneObjectIds: new Set(),
        targetRegistry: null,
      }),
    ).toMatchObject({ id: "part-film", kind: "part" });
  });

  it("maps a geometry-only part to an object when the scene confirms its normalized id", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          geometry_id: "projection-film",
          id: "part-film",
          object_id: null,
        },
        sceneObjectIds: new Set(["projection-film"]),
        targetRegistry: null,
      }),
    ).toMatchObject({ id: "object:projection-film", kind: "object" });
  });

  it("maps an explicitly owned part to its object when the registry does not classify it as a part", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          id: "part-film",
          object_id: "projection-film",
        },
        sceneObjectIds: new Set(["projection-film"]),
        targetRegistry: {
          airbox: {} as never,
          objects: [],
          parts: [],
        },
      }),
    ).toMatchObject({ id: "object:projection-film", kind: "object" });
  });

  it("does not create a ghost object target from a stale explicit owner id", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          id: "part-orphan",
          label: "Recovered volume",
          object_id: "deleted-object",
        },
        sceneObjectIds: new Set(["film"]),
        targetRegistry: null,
      }),
    ).toMatchObject({
      id: "part-orphan",
      kind: "part",
      label: "Recovered volume",
    });
  });

  it("honors a backend-classified part target before explicit object ownership", () => {
    expect(
      resolveVisualizationTargetForMeshPart({
        part: {
          id: "part-film",
          label: "Film mesh",
          object_id: "projection-film",
        },
        sceneObjectIds: new Set(["projection-film"]),
        targetRegistry: {
          airbox: {} as never,
          objects: [],
          parts: [
            {
              scope: "part",
              scope_id: "part-film",
            } as never,
          ],
        },
      }),
    ).toMatchObject({
      id: "part-film",
      kind: "part",
      label: "Film mesh",
    });
  });
});
