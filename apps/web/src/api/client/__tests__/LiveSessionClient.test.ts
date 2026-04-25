import { describe, expect, it } from "vitest";
import {
  openApiV2PathLiterals,
  assertOpenApiV2Path,
} from "../../generated/openapi-v2-paths";
import { sessionApiPaths } from "../sessionPaths";

describe("LiveSessionClient v2 transport contract", () => {
  it("generates only v2 browser paths", () => {
    expect(openApiV2PathLiterals.length).toBeGreaterThan(0);
    expect(openApiV2PathLiterals.filter((path) => path.startsWith("/v1"))).toEqual([]);
  });

  it("keeps session path helpers backed by generated OpenAPI v2 literals", () => {
    assertOpenApiV2Path(sessionApiPaths.status);
    assertOpenApiV2Path(sessionApiPaths.data.quantities);
    assertOpenApiV2Path(sessionApiPaths.data.fields);
    assertOpenApiV2Path(sessionApiPaths.visualization.display);
    assertOpenApiV2Path(sessionApiPaths.simulation.commands);
    assertOpenApiV2Path(sessionApiPaths.simulation.runsCurrent);
    assertOpenApiV2Path(sessionApiPaths.meshing.sharedDomainTopology);
    assertOpenApiV2Path(sessionApiPaths.workspace.selection);
  });
});
