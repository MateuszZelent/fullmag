import { describe, expect, it, vi } from "vitest";

import { VisualizationStateModule } from "../VisualizationStateModule";
import type { LiveSessionClient } from "../../LiveSessionClient";

function createClient() {
  const get = vi.fn();
  const put = vi.fn();
  const patch = vi.fn();
  const client = {
    get,
    put,
    patch,
  } as unknown as LiveSessionClient;
  return { client, get, put, patch };
}

describe("VisualizationStateModule", () => {
  it("gets visualization state through the canonical resource path", async () => {
    const { client, get } = createClient();
    get.mockResolvedValue({ revision: 1, schema_version: 2 });

    const module = new VisualizationStateModule(client);
    await module.get();

    expect(get).toHaveBeenCalledWith(
      "/v2/sessions/current/visualization/state",
      undefined,
    );
  });

  it("patches visualization state through the canonical resource path", async () => {
    const { client, patch } = createClient();
    patch.mockResolvedValue({ revision: 2, schema_version: 2 });
    const update = {
      layers: {
        vectors: {
          visible: true,
          density: 6,
        },
      },
    };

    const module = new VisualizationStateModule(client);
    await module.patch(update);

    expect(patch).toHaveBeenCalledWith(
      "/v2/sessions/current/visualization/state",
      update,
      undefined,
    );
  });

  it("replaces visualization state through the canonical resource path", async () => {
    const { client, put } = createClient();
    put.mockResolvedValue({ revision: 3, schema_version: 2 });
    const replacement = { revision: 2, schema_version: 2 };

    const module = new VisualizationStateModule(client);
    await module.replace(replacement as never);

    expect(put).toHaveBeenCalledWith(
      "/v2/sessions/current/visualization/state",
      replacement,
      undefined,
    );
  });
});
