import { describe, expect, it } from "vitest";

import type { ExecutionProfile } from "@/kernel/api/apiTypes";

import {
  duplicateProfileDraft,
  newProfileDraft,
  profileFromDraft,
} from "./executionProfileDraft";

const GIB = 1024 ** 3;

function profile(): ExecutionProfile {
  return {
    schema_version: "execution_profile.v1",
    profile_id: "exec:gpu-sweep",
    version: "3",
    description: "GPU sweep",
    defaults: {
      device: "gpu",
      resources: {
        cpu: { threads: 4, affinity: "compact", core_policy: "physical_first" },
        gpu: {
          selector: "any_compatible",
          device_uuids: [],
          devices_per_task: 1,
          vram_per_device_bytes: 10 * GIB,
        },
        ram: { reservation_bytes: 24 * GIB },
        scratch: { reservation_bytes: 8 * GIB },
      },
    },
  };
}

function profileDraft(source?: ExecutionProfile) {
  const draft = newProfileDraft(source);
  return {
    ...draft,
    profile: {
      ...draft.profile,
      profile_id: draft.profile.profile_id || "exec:resource-test",
      version: draft.profile.version || "1",
    },
  };
}

describe("execution profile resource drafts", () => {
  it("duplicates an immutable version under a new profile identity", () => {
    const source = profile();
    const duplicate = duplicateProfileDraft(source, "exec:copy-123");

    expect(duplicate.profile).toEqual({
      ...source,
      profile_id: "exec:copy-123",
      version: "1",
    });
    expect(duplicate.threads).toBe("4");
    expect(duplicate.ramGiB).toBe("24");
    expect(source.profile_id).toBe("exec:gpu-sweep");
    expect(source.version).toBe("3");
  });

  it("round-trips resource reservations while editing another profile field", () => {
    const draft = profileDraft(profile());

    expect(draft).toMatchObject({ ramGiB: "24", scratchGiB: "8", vramGiB: "10" });

    const updated = profileFromDraft({ ...draft, threads: "8" });
    expect(updated.defaults.resources?.cpu).toMatchObject({
      threads: 8,
      affinity: "compact",
      core_policy: "physical_first",
    });
    expect(updated.defaults.resources?.ram).toEqual({ reservation_bytes: 24 * GIB });
    expect(updated.defaults.resources?.scratch).toEqual({ reservation_bytes: 8 * GIB });
    expect(updated.defaults.resources?.gpu).toEqual(profile().defaults.resources?.gpu);
  });

  it("writes sparse RAM, scratch, and GPU VRAM values from GiB inputs", () => {
    const draft = profileDraft();
    const updated = profileFromDraft({ ...draft, ramGiB: "12.5", scratchGiB: "2", vramGiB: "8" });

    expect(updated.defaults.resources?.ram).toEqual({ reservation_bytes: 12.5 * GIB });
    expect(updated.defaults.resources?.scratch).toEqual({ reservation_bytes: 2 * GIB });
    expect(updated.defaults.resources?.gpu).toEqual({
      selector: "any_compatible",
      device_uuids: [],
      devices_per_task: 1,
      vram_per_device_bytes: 8 * GIB,
    });
  });

  it("preserves explicit null resets unless the field is edited", () => {
    const source = profile();
    source.defaults.resources!.ram = { reservation_bytes: null };
    source.defaults.resources!.scratch = { reservation_bytes: null };
    source.defaults.resources!.gpu = null;

    const updated = profileFromDraft(profileDraft(source));

    expect(updated.defaults.resources?.ram).toEqual({ reservation_bytes: null });
    expect(updated.defaults.resources?.scratch).toEqual({ reservation_bytes: null });
    expect(updated.defaults.resources?.gpu).toBeNull();
  });

  it("clears an edited reservation and rejects invalid memory values", () => {
    const draft = profileDraft(profile());
    const cleared = profileFromDraft({ ...draft, ramGiB: "" });
    expect(cleared.defaults.resources?.ram).toBeUndefined();

    expect(() => profileFromDraft({ ...profileDraft(), ramGiB: "0" })).toThrow(/positive/);
    expect(() => profileFromDraft({ ...profileDraft(), vramGiB: "1e3" })).toThrow(/GiB/);
  });
});
