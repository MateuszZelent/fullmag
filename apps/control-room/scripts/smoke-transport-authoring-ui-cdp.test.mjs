import assert from "node:assert/strict";
import { it } from "vitest";

import * as smoke from "./smoke-transport-authoring-ui-cdp.mjs";

const { startFixtureServer } = smoke;

it("keyboard select plan does not clear a value already selected by a dependent control", () => {
  assert.equal(typeof smoke.keyboardSelectPlan, "function");
  assert.deepEqual(
    smoke.keyboardSelectPlan("added-current", ["", "added-current", "known-current"], "added-current"),
    [],
  );
  assert.deepEqual(
    smoke.keyboardSelectPlan("", ["", "added-current", "known-current"], "known-current"),
    ["Home", "ArrowDown", "ArrowDown"],
  );
});

it("transport authoring fixture serves complete resources used by region selection and workspace chrome", async () => {
  const fixture = await startFixtureServer();
  try {
    const getJson = async (path) => {
      const response = await fetch(`${fixture.baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      return response.json();
    };

    const regions = await getJson("/v2/sessions/current/model/regions");
    assert.ok(Array.isArray(regions.regions));
    assert.ok(regions.regions.some((region) =>
      region.owner_object_id === "film" && region.region_id === "free"
    ));

    const materialFields = await getJson("/v2/sessions/current/model/material-fields");
    assert.ok(Array.isArray(materialFields.fields));

    const diagnostics = await getJson("/v2/sessions/current/model/region-diagnostics");
    assert.ok(Array.isArray(diagnostics.diagnostics));

    const couplings = await getJson("/v2/sessions/current/model/couplings");
    assert.ok(Array.isArray(couplings.couplings));

    const objectMetrics = await getJson("/v2/sessions/current/simulation/objects/film/metrics");
    assert.equal(objectMetrics.object_id, "film");
    assert.equal(objectMetrics.energies.total, 0);

    const fieldCatalog = await getJson("/v2/sessions/current/data/fields");
    assert.ok(Array.isArray(fieldCatalog.quantities));
    assert.equal(typeof fieldCatalog.domain_generation_id, "string");
  } finally {
    fixture.close();
  }
});

it("transport authoring fixture fails closed for an unknown GET", async () => {
  const fixture = await startFixtureServer();
  try {
    const path = "/v2/sessions/current/model/not-a-real-resource";
    const response = await fetch(`${fixture.baseUrl}${path}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      code: "unsupported_fixture_request",
      message: `Transport authoring smoke fixture does not implement GET ${path}.`,
    });
  } finally {
    fixture.close();
  }
});

it("browser error collection does not hide websocket failures", () => {
  assert.equal(typeof smoke.browserLogError, "function");
  assert.equal(
    smoke.browserLogError({
      level: "error",
      text: "WebSocket connection failed: realtime unexpectedly started",
      url: "http://127.0.0.1/workspace",
    }),
    "WebSocket connection failed: realtime unexpectedly started (http://127.0.0.1/workspace)",
  );
});

it("unhandled fixture requests fail the final gate without a browser log error", () => {
  assert.equal(typeof smoke.transportAuthoringSmokeFailure, "function");
  assert.match(
    smoke.transportAuthoringSmokeFailure([], [
      {
        method: "GET",
        path: "/v2/sessions/current/model/not-a-real-resource",
      },
    ]),
    /unhandledRequests=.*not-a-real-resource/,
  );
});
