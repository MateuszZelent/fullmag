import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { resource } = vi.hoisted(() => {
  const profile = {
    schema_version: "execution_profile.v1",
    profile_id: "exec:interactive",
    version: "2",
    description: "Interactive GPU profile",
    defaults: {
      backend: "fdm",
      device: "gpu",
      precision: "double",
      mode: "strict",
      resources: {
        target: { kind: "local" },
        cpu: { threads: 4, affinity: "compact" },
        gpu: {
          selector: "allow_list",
          device_uuids: ["GPU-0123456789abcdef"],
          devices_per_task: 1,
          vram_per_device_bytes: 8 * 1024 ** 3,
        },
        ram: { reservation_bytes: 16 * 1024 ** 3 },
        scratch: { reservation_bytes: 2 * 1024 ** 3 },
        parallelism: { kind: "single_process" },
        placement: "balanced",
      },
    },
  };

  return {
    resource: {
      data: {
        schema_version: "execution_profile_catalog.v1",
        revision: 3,
        total: 1,
        offset: 0,
        next_offset: null,
        entries: [{
          profile,
          profile_sha256: "a".repeat(64),
          client_intent_id: "intent-profile-1",
          published_at: "2026-10-13T12:00:00.000Z",
          revision: 2,
        }],
      },
      status: "ready",
      error: null,
      refreshError: null,
      refetch: vi.fn(),
      publish: vi.fn(),
      findPublication: vi.fn(),
      scope: "test-resource-scope",
    },
  };
});

vi.mock("@/kernel/resources/useExecutionProfilesResource", () => ({
  useExecutionProfilesResource: () => resource,
}));

import { ExecutionProfilesSettings } from "./ExecutionProfilesSettings";

describe("execution profile settings", () => {
  it("inspects resolved profile defaults and offers duplicate and new-version actions", () => {
    const html = renderToStaticMarkup(<ExecutionProfilesSettings />);

    expect(html).toContain("<summary>Inspect</summary>");
    expect(html).toContain("CPU threads/task");
    expect(html).toContain("GPU-0123456789abcdef");
    expect(html).toContain("8 GiB");
    expect(html).toContain("16 GiB");
    expect(html).toContain("Duplicate");
    expect(html).toContain("New version");
  });
});
