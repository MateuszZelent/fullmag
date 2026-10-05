// Interpreted production TypeScript through Node's native type erasure.
// No test bundles, Rust tests, runtime or solver are compiled by this driver.
import assert from "node:assert/strict";
import { newProfileDraft, profileFromDraft, sameProfile } from "../src/modules/start/model/executionProfileDraft.ts";

const fresh = newProfileDraft();
fresh.profile.profile_id = "exec:interactive";
const inherited = profileFromDraft(fresh);
assert.deepEqual(inherited.defaults, {});
fresh.profile.defaults.device = "auto";
fresh.threads = "auto";
const auto = profileFromDraft(fresh);
assert.equal(auto.defaults.device, "auto");
assert.equal(auto.defaults.resources.cpu.threads, "auto");
assert.equal(fresh.profile.defaults.resources, undefined, "materialization must not mutate the draft");

const saved = {
  ...auto,
  defaults: {
    ...auto.defaults,
    resources: {
      cpu: { threads: 8, affinity: "spread", core_policy: null, numa_node: null },
      gpu: { selector: "required", device_uuids: ["GPU-fixture"], devices_per_task: 1, vram_per_device_bytes: 4096 },
      ram: { reservation_bytes: 8192 },
      scratch: { reservation_bytes: null },
    },
  },
};
const clone = newProfileDraft(saved);
assert.equal(clone.profile.version, "", "new versions must be explicit");
clone.profile.version = "2";
clone.threads = "";
const changed = profileFromDraft(clone);
assert.equal(changed.defaults.resources.cpu.threads, undefined);
assert.deepEqual(changed.defaults.resources.gpu, saved.defaults.resources.gpu);
assert.deepEqual(changed.defaults.resources.ram, saved.defaults.resources.ram);
assert.equal(changed.defaults.resources.cpu.core_policy, null);
assert.equal(changed.defaults.resources.scratch.reservation_bytes, null);
assert.equal(saved.defaults.resources.cpu.threads, 8, "published version must stay immutable");
for (const threads of ["0", "-1", "1.5", "4294967296", "Infinity", "NaN"]) {
  assert.throws(() => profileFromDraft({ ...clone, threads }), /CPU threads/);
}
assert.equal(profileFromDraft({ ...clone, threads: "4294967295" }).defaults.resources.cpu.threads, 4294967295);
clone.profile.version = "latest";
assert.throws(() => profileFromDraft(clone), /fixed version/);
assert.ok(sameProfile(saved, { defaults: saved.defaults, ...saved }));
assert.equal(sameProfile(saved, changed), false);
assert.equal(sameProfile(saved, { ...saved, defaults: { ...saved.defaults, resources: { ...saved.defaults.resources, scratch: {} } } }), false);
console.log(JSON.stringify({ state: "passed", production_type_erasure: true, unit_test_compilation: false }));
