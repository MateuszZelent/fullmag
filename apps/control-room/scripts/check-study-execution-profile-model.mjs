import assert from "node:assert/strict";
// Native Node type erasure; no transpiled test bundle or emitted source.
import * as model from "../src/modules/inspector/panels/StudyExecutionProfileModel.ts";

const profile = {
  schema_version: "execution_profile.v1",
  profile_id: "exec:fixture",
  version: "7",
  description: "Immutable advanced version",
  defaults: {
    backend: "fem",
    device: "gpu",
    precision: "double",
    mode: "strict",
    resources: {
      cpu: { threads: 12, core_policy: "physical_first", affinity: "numa", numa_node: 2 },
      gpu: { selector: "allow_list", device_uuids: ["GPU-1"], devices_per_task: 1 },
      ram: { reservation_bytes: 17_179_869_184 },
      placement: "pinned",
    },
  },
};
const scriptLayer = {
  origin: { kind: "script", location: "fixture/script.py:study" },
  request: {
    backend: "fem",
    resources: {
      cpu: { core_policy: "logical", affinity: "numa", numa_node: 3, native_threads: "auto", blas_threads: 6 },
      gpu: { selector: "required", device_uuids: ["GPU-script"], devices_per_task: 1, vram_per_device_bytes: 4_294_967_296 },
      scratch: { reservation_bytes: 1_073_741_824 },
      parallelism: { kind: "single_process" },
      placement: "throughput",
    },
  },
};
const studyLayer = {
  origin: { kind: "study", location: "Existing Study override" },
  request: {
    device: "cpu",
    resources: { cpu: { threads: 8, core_policy: "physical_first", affinity: "compact", numa_node: 1, native_threads: "auto", blas_threads: 4 } },
  },
};
const scene = {
  revision: 41,
  study: { execution_profile: profile, execution_layers: [scriptLayer, studyLayer] },
};

const untouchedDraft = model.createStudyExecutionProfileDraft(scene);
assert.deepEqual(model.buildStudyExecutionProfileAssignment(untouchedDraft), {
  execution_profile: profile,
  execution_layers: [scriptLayer, studyLayer],
});

let edited = model.updateStudyExecutionProfileOverride(untouchedDraft, "cpuThreads", "4294967295");
edited = model.updateStudyExecutionProfileOverride(edited, "device", "gpu");
edited = model.updateStudyExecutionProfileOverride(edited, "backend", "");
const assignment = model.buildStudyExecutionProfileAssignment(edited);
const transaction = model.buildStudyExecutionProfileAssignmentMergePatch(assignment, 41);
assert.equal(transaction.kind, "assign_study_execution");
assert.equal(transaction.base_revision, 41);
assert.deepEqual(transaction.execution_profile, profile);
assert.deepEqual(transaction.execution_layers[0], scriptLayer);
assert.deepEqual(transaction.execution_layers[1], {
  origin: studyLayer.origin,
  request: {
    device: "gpu",
    resources: {
      cpu: { threads: 4_294_967_295, core_policy: "physical_first", affinity: "compact", numa_node: 1, native_threads: "auto", blas_threads: 4 },
    },
  },
});
assert.equal(Object.hasOwn(transaction.execution_layers[1].request, "backend"), false);

const retainEmptyRequest = {
  ...model.createStudyExecutionProfileDraft({
    study: {
      execution_profile: profile,
      execution_layers: [{ origin: { kind: "study", location: "Study" }, request: { device: "cpu" } }],
    },
  }),
};
const inherited = model.updateStudyExecutionProfileOverride(retainEmptyRequest, "device", "");
assert.deepEqual(model.buildStudyExecutionProfileAssignment(inherited).execution_layers, [
  { origin: { kind: "study", location: "Study" }, request: {} },
]);

for (const value of ["4294967296", "9007199254740992", "1.5", "0", "-1"]) {
  const candidate = model.updateStudyExecutionProfileOverride(untouchedDraft, "cpuThreads", value);
  assert.match(model.validateStudyExecutionProfileDraft(candidate), /CPU threads/);
}
for (const value of ["auto", "1", "4294967295"]) {
  const candidate = model.updateStudyExecutionProfileOverride(untouchedDraft, "cpuThreads", value);
  assert.equal(model.validateStudyExecutionProfileDraft(candidate), null);
}

const cleared = model.buildStudyExecutionProfileAssignmentMergePatch(
  { execution_profile: null, execution_layers: null },
  41,
);
assert.deepEqual(cleared, {
  base_revision: 41,
  kind: "merge_patch",
  merge_patch: { study: { execution_profile: null, execution_layers: null } },
});

assert.equal(model.hasChangeDeviceStudyStage({}, [{ kind: "  CHANGE_DEVICE  " }]), true);
assert.equal(model.hasChangeDeviceStudyStage({ study: { study_pipeline: { nodes: [{ stage_kind: " Change_Device " }] } } }, []), true);
assert.equal(model.hasChangeDeviceStudyStage({}, [{ kind: "relax" }]), false);

const malformed = model.createStudyExecutionProfileDraft({
  study: { execution_profile: profile, execution_layers: [{ origin: { kind: "study", location: "Study" }, request: { resources: { cpu: { unexpected: true } } } }] },
});
assert.equal(malformed.invalidLayerData, true);
assert.match(model.validateStudyExecutionProfileDraft(malformed), /execution layers are malformed/);
console.log("Study execution profile model checks passed (interpreted source, no test build).");
