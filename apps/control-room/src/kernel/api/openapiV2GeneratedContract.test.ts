import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createOpenApiV2Transport } from "./generated/openapi-v2-client";
import { ControlRoomApi } from "./ControlRoomApi";
import {
  assertOpenApiV2Path,
  openApiV2PathLiterals,
  openApiV2Path,
} from "./generated/openapi-v2-paths";
import * as apiPaths from "./apiPaths";

describe("generated OpenAPI v2 transport", () => {
  it("documents every field-vector response header with its generated schema type", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const headers =
      document.paths[
        "/v2/sessions/current/data/fields/{quantity_id}/samples/vector"
      ].get.responses["200"].headers;
    const expected = {
      "x-fullmag-component": "string",
      "x-fullmag-domain-generation-id": "string",
      "x-fullmag-encoding": "string",
      "x-fullmag-field-indexing": "string",
      "x-fullmag-field-revision": "string",
      "x-fullmag-mesh-topology-hash": "string",
      "x-fullmag-n-comp": "integer",
      "x-fullmag-node-index-count": "integer",
      "x-fullmag-payload-state": "string",
      "x-fullmag-point-count": "integer",
      "x-fullmag-quantity-id": "string",
      "x-fullmag-scope-id": "string",
      "x-fullmag-scope-kind": "string",
      "x-fullmag-snapshot-id": "string",
      "x-fullmag-value-count": "integer",
    } as const;
    expect(Object.keys(headers).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, type] of Object.entries(expected)) {
      expect(headers[name].schema.type, name).toBe(type);
    }
  });

  it("is generated from the backend v2 resource tree", () => {
    expect(openApiV2PathLiterals).toContain("/v2/sessions/current/status");
    expect(openApiV2PathLiterals).toContain("/v2/sessions/current/model/scene");
    expect(openApiV2PathLiterals).toContain(
      "/v2/sessions/current/simulation/commands",
    );
    expect(openApiV2Path("/v2/sessions/current/status")).toBe(
      "/v2/sessions/current/status",
    );
    expect(() => assertOpenApiV2Path("/not-in-openapi")).toThrow(
      /not present in generated OpenAPI v2/,
    );
  });

  it("generates typed content for the session collection", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const sessionList =
      document.paths["/v2/sessions"].get.responses["200"].content?.[
        "application/json"
      ];

    expect(sessionList?.schema?.$ref).toBe(
      "#/components/schemas/SessionListResource",
    );
    expect(document.components.schemas.SessionListResource).toBeDefined();
    expect(document.components.schemas.SessionSummaryResource).toBeDefined();
  });

  it("publishes immutable planar sample tokens and separated stale revisions", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const meta = document.components.schemas.PlanarFieldMetaResource;
    expect(meta.required).toEqual(expect.arrayContaining([
      "sample_token",
      "scene_revision",
      "source",
      "carrier_revision",
      "field_revision",
    ]));
    for (const revision of [
      "scene_revision",
      "mesh_revision",
      "carrier_revision",
      "field_revision",
    ]) {
      expect(meta.properties[revision].type, revision).toBe("string");
    }
    const scalarParameters = document.paths[
      "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar"
    ].get.parameters.map((parameter: { name: string }) => parameter.name);
    expect(scalarParameters).toEqual(expect.arrayContaining([
      "sample_token",
      "expected_scene_revision",
      "expected_monitor_revision",
      "expected_carrier_revision",
      "expected_field_revision",
    ]));
    for (const parameter of document.paths[
      "/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar"
    ].get.parameters) {
      if (parameter.name.startsWith("expected_")) {
        expect(parameter.schema.type, parameter.name).toBe("string");
      }
    }
  });

  it("publishes typed default and authored-monitor planar source families", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const defaultResources = [
      "meta",
      "scalar",
      "vectors",
      "empty-mask",
      "mesh-overlay",
      "probe",
      "render.png",
    ];
    for (const resource of defaultResources) {
      expect(
        document.paths[
          `/v2/sessions/current/data/fields/{quantity_id}/planar-default/${resource}`
        ],
        resource,
      ).toBeDefined();
    }
    const source = document.components.schemas.PlanarSampleSourceResource;
    expect(source.oneOf).toHaveLength(2);
    expect(source.oneOf.map((variant: { properties: { kind: { enum: string[] } } }) =>
      variant.properties.kind.enum[0],
    )).toEqual(expect.arrayContaining(["default", "monitor"]));
    expect(
      document.components.schemas.PlanarFieldMetaResource.properties.source.$ref,
    ).toBe("#/components/schemas/PlanarSampleSourceResource");
  });

  it("declares structured planar data-plane error responses", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    for (const resource of [
      "meta",
      "scalar",
      "vectors",
      "empty-mask",
      "mesh-overlay",
      "probe",
      "render.png",
    ]) {
      const responses = document.paths[
        `/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/${resource}`
      ].get.responses;
      for (const status of ["404", "409", "422"]) {
        expect(
          responses[status].content["application/json"].schema.$ref,
          `${resource} ${status}`,
        ).toBe("#/components/schemas/ApiErrorResponse");
      }
    }
  });

  it("declares metadata and binary not-modified responses without bodies", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    for (const resource of [
      "meta",
      "scalar",
      "vectors",
      "empty-mask",
      "mesh-overlay",
    ]) {
      const response = document.paths[
        `/v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/${resource}`
      ].get.responses["304"];
      expect(response?.description, resource).toBe("Not modified");
      expect(response?.content, resource).toBeUndefined();
    }
  });

  it("exposes an openapi-fetch transport wrapper", async () => {
    const calls: string[] = [];
    const transport = createOpenApiV2Transport({
      baseUrl: "http://127.0.0.1:8765",
      fetch: async (input) => {
        calls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          JSON.stringify({
            api_contract_version: "v2",
            resources: { session: 1 },
            runtime_bundle_version: "dev",
            session: { state: "idle" },
          }),
          { status: 200 },
        );
      },
    });

    const result = await transport.GET(openApiV2Path("/v2/sessions/current/status"));

    expect(result.response.status).toBe(200);
    expect(calls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/status",
    ]);
  });

  it("promotes every generated OpenAPI path through the handwritten API path boundary", () => {
    const promotedPaths = new Set(
      Object.values(apiPaths).flatMap((value) =>
        typeof value === "string" && value.startsWith("/v2/") ? [value] : [],
      ),
    );

    expect(
      openApiV2PathLiterals.filter((path) => !promotedPaths.has(path)),
    ).toEqual([]);
  });

  it("promotes frozen-spins resources through canonical paths and the API facade", () => {
    expect(apiPaths.MODEL_FROZEN_SPINS_PATH).toBe(
      "/v2/sessions/current/model/frozen-spins",
    );
    expect(apiPaths.MODEL_FROZEN_SPIN_PATH).toBe(
      "/v2/sessions/current/model/frozen-spins/{constraint_id}",
    );
    expect(apiPaths.MODEL_FROZEN_SPINS_PREVIEWS_PATH).toBe(
      "/v2/sessions/current/model/frozen-spins/previews",
    );
    expect(apiPaths.MODEL_FROZEN_SPINS_PREVIEW_PATH).toBe(
      "/v2/sessions/current/model/frozen-spins/previews/{preview_id}",
    );
    expect(apiPaths.DATA_FROZEN_SPINS_RESOLVED_MASK_PATH).toBe(
      "/v2/sessions/current/data/frozen-spins/resolved-masks/{mask_id}",
    );

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(api.model).toHaveProperty("frozenSpins");
    expect(Object.keys((api.model as unknown as Record<string, unknown>).frozenSpins as object)).toEqual(
      expect.arrayContaining([
        "list",
        "get",
        "create",
        "patch",
        "delete",
        "createPreview",
        "getPreview",
        "resolvedMask",
      ]),
    );

    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const schemas = document.components.schemas;
    expect(schemas.FrozenSpinsPreviewAuthority.enum).toEqual([
      "speculative_authoring_preview",
    ]);
    expect(schemas.FrozenSpinsPreviewResponse.required).toEqual(
      expect.arrayContaining(["authority", "solver_binding"]),
    );
    expect(schemas.FrozenSpinsPreviewActivationResponse.required).toEqual(
      expect.arrayContaining([
        "activation_scope",
        "active_site_count",
        "authority",
        "free_site_count",
        "frozen_site_count",
        "runtime_application",
        "solver_binding",
      ]),
    );
    expect(schemas.FrozenSpinsRuntimeApplication.required).toEqual(
      expect.arrayContaining([
        "apply_boundary",
        "current_runtime_unchanged",
        "pending_revision",
        "state",
      ]),
    );
    expect(schemas.FrozenSpinsRuntimeApplicationState.enum).toEqual([
      "pending_runtime_plan",
    ]);
    expect(
      schemas.FrozenSpinsRuntimeApplication.properties.application_command_id,
    ).toEqual(expect.objectContaining({ type: ["string", "null"] }));
    expect(schemas.FrozenSpinsRuntimeApplication.required).not.toContain(
      "application_command_id",
    );
    expect(schemas.FrozenSpinsRuntimeApplyBoundary.enum).toEqual([
      "next_runtime_plan",
      "accepted_step",
    ]);
  });

  it("keeps structured-current closure authoring closed, typed, and region-scoped", () => {
    const document = JSON.parse(
      readFileSync(new URL("./generated/openapi-v2.json", import.meta.url), "utf8"),
    );
    const schemas = document.components.schemas;
    const knownTransport = JSON.stringify(
      schemas.KnownSceneCurrentTransport.properties.structured_current_closure,
    );
    const closure = schemas.SceneStructuredCurrentClosure.oneOf[0];
    const sourceCut = schemas.SceneStructuredCurrentSourceCut;
    const drive = schemas.SceneStructuredCurrentDrive;

    expect(knownTransport).toContain("#/components/schemas/SceneStructuredCurrentClosure");
    expect(closure.properties.kind.enum).toEqual(["closed_geometry"]);
    expect(closure.required).toEqual(expect.arrayContaining([
      "closure_id",
      "kind",
      "schema_version",
      "source_cuts",
    ]));
    expect(JSON.stringify(schemas.SceneStructuredCurrentClosure)).not.toContain("certified_import");
    expect(sourceCut.required).toEqual(expect.arrayContaining([
      "circuit_id",
      "drive",
      "plane",
      "region",
      "source_cut_id",
    ]));
    expect(JSON.stringify(drive)).toContain("impressed_potential_jump");
  });
});
