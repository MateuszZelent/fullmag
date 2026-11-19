// Renderer proofs may read a running session, but must never author into it.
export async function installViewportReadOnlyReplica(page, { apiBase, transformVisualizationState } = {}) {
  const deniedMutations = [];
  const responses = new Map();
  await page.route("**/v2/**", async (route) => {
    const request = route.request();
    const parsed = new URL(request.url());
    if (request.method() !== "GET") {
      deniedMutations.push({ method: request.method(), path: parsed.pathname });
      return route.fulfill({ status: 403, body: "Read-only renderer verification" });
    }
    if (!apiBase) return route.continue();
    const resource = parsed.pathname + parsed.search;
    const key = `${resource}|range=${request.headers().range ?? ""}|scope=${request.headers()["x-fullmag-session-scope"] ?? ""}`;
    if (!responses.has(key)) {
      const response = await page.request.get(new URL(resource, apiBase).href, { headers: request.headers(), timeout: 120_000 });
      let body = await response.body();
      if (transformVisualizationState && parsed.pathname.endsWith("/visualization/state") && response.ok()) {
        body = Buffer.from(JSON.stringify(await transformVisualizationState(JSON.parse(body))));
      }
      const headers = { ...response.headers() };
      delete headers["content-length"];
      delete headers["content-encoding"];
      responses.set(key, { status: response.status(), headers, body });
    }
    return route.fulfill(responses.get(key));
  });
  return { deniedMutations };
}

/** Display-only orientation and camera fixture; field payloads remain unchanged. */
export function prepareViewportOrientationProof(state) {
  for (const target of state.targets?.objects ?? []) {
    target.settings.active_quantity_id = "m";
    target.settings.surface_color_source = "orientation";
    if (target.override) {
      target.override.quantity = { active_quantity_id: "m" };
      target.override.style = { ...target.override.style, surface_color_source: "orientation" };
    }
  }
  for (const override of state.overrides ?? []) {
    if (override.scope !== "object") continue;
    override.quantity = { active_quantity_id: "m" };
    override.style = { ...override.style, surface_color_source: "orientation" };
  }
  state.camera = { ...state.camera, position: [-3.730710e-6, -2.863532e-6, 3.654640e-6],
    target: [0, 0, 0], orthographic_scale: 7.5e-6 };
  return state;
}
