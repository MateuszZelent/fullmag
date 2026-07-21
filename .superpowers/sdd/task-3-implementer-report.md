# Task 3 implementer report: stage-scoped FEM mesh ownership

## Outcome

Removed `FemMeshPayload` from the runner `StepUpdate` and CLI `LiveStepView`
hot path. FEM topology is now owned once by `LocalLiveWorkspaceState` and the
top-level API session mesh resource. Step traffic carries only
`fem_mesh_generation_id`.

- Initial stage materialization and real remesh/adaptive transitions replace
  the stage mesh and generation together.
- Publish deltas send a mesh once per generation and suppress it on later
  steps.
- Scalar, field, preview, artifact, resume, remesh, finalization, and API
  consumers resolve mesh topology from the stage/session resource.
- The API accepts a deprecated nested mesh only as input, promotes it to the
  top-level resource, and never serializes it in step output.
- Callback offsetting now takes ownership of `StepUpdate`; heartbeat state
  keeps a control-only update without magnetization or preview arrays.

## Hot-path evidence

The production stage-mesh builder has test-only scoped instrumentation. The
regression passes 12 updates through the production ownership/offset adapter:

- mesh payload builds: **1 per unchanged stage generation**;
- callback `step_update_deep_clone_count`: **0**;
- mesh publication: **1** for the first delta and **0** for each of the next
  11 deltas;
- a real mesh-coordinate change rebuilds once and produces a different
  generation fingerprint.

Payload accounting:

- before: every FEM `StepUpdate` could own the complete node/element/boundary/
  mesh-part payload, so per-step topology bytes and clone cost were `O(mesh)`;
  the old path did not record a trustworthy numeric serialized-byte baseline;
- after: per-step mesh topology bytes are **0** and per-step deep FEM mesh
  clones are **0**; only the bounded generation string remains;
- the full payload is serialized once when its generation is first published.

No numeric pre-change byte value is claimed because it was not measured by an
authoritative baseline. This task proves the stronger structural invariant:
the payload type is absent from runtime step ownership and guarded by a
committed semantic source contract.

## Semantic source gate

`scripts/verify_fem_mesh_hot_loop_source_contract.sh` is invoked by
`just verify-fem-relaxation-source-contract`. It inventories and classifies the
full runner/CLI/API surface on every run:

- 104 `StepUpdate` sites;
- 187 exact `.fem_mesh` accesses;
- every real constructor is generation-only and contains no mesh payload;
- runner nested mesh access is forbidden;
- CLI nested step mesh access is forbidden;
- API nested access is limited to input-only legacy promotion and its tests;
- inline `FemMeshPayload::from(...)` generation construction in step callbacks
  is forbidden.

## Verification

- Production builder/fingerprint regression: passed.
- Twelve-step publish-once regression: passed.
- Ownership-offset/deep-clone regression: passed.
- API mesh-once/preserve-across-12-frames regression: passed.
- `cargo test -p fullmag-cli --no-run`: passed.
- `cargo test -p fullmag-api --no-run`: passed.
- `cargo check -p fullmag-runner`: passed.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract`:
  passed, including the semantic gate and native FEM source contracts.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: passed;
  managed bundle validation and GPU/CPU relaxation smoke completed.
- `COMPOSE_PROJECT_NAME=fullmag FULLMAG_BENCH_REPEAT=5 just
  verify-fem-gpu-performance-regression`: passed, 10/10 rows and 25/25 CPU/GPU
  pairs.

Five-repeat performance distribution:

- GPU wall-time p50: **5268.774 ms**;
- CPU wall-time p50: **10495.246 ms**;
- GPU demag-solve p50: **54.719 ms**;
- CPU demag-solve p50: **119.122 ms**;
- accepted-baseline regression failures: **0**.

The performance CSV does not expose the opt-in solver-profiler interval gap,
and the managed benchmark runs with that profiler disabled. Therefore a gap
p50 is **not available from this gate** and is not inferred from total wall
time. The Task 3 attribution is instead direct: topology bytes and deep mesh
clones in step traffic are both zero, while the remaining measured wall time is
dominated by solver execution (notably demag) and other non-mesh host work.

Workspace-wide `cargo fmt --check` continues to report pre-existing formatting
drift in files outside Task 3. `.superpowers/sdd/progress.md` remained unstaged
and was not edited by this task.
