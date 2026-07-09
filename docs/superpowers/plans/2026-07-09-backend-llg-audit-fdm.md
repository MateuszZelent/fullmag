# Backend LLG Audit FDM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every native FDM backend file and its Rust/public caller chain for physical, numerical, validation, and maturity defects in statics, relaxation, deterministic and stochastic dynamics, and GPU precision variants.

**Architecture:** Partition all `backends/fdm/**` paths from the frozen inventory, inspect the ABI/runtime/field/integrator chain in dependency order, compare native GPU behavior with the Rust CPU reference, and write one coverage row and zero or more complete findings per file. Existing repository tests and public `just` workflows provide evidence only for the properties they actually assert.

**Tech Stack:** C++/CUDA, cuFFT, cuRAND, Rust FDM reference engine, C ABI, CMake/CTest definitions, Fullmag planner/runner, repository `just` recipes.

## Global Constraints

- Audit only: do not edit FDM code, tests, examples, ABI headers, planner, runner, physics docs, or build recipes.
- Every path beginning `backends/fdm/` in the frozen inventory receives exactly one coverage row.
- Treat Rust FDM CPU as a reference implementation, not proof of native GPU behavior.
- Treat FP32 and FP64 as separate realizations; compare formulas, boundary handling, region coefficients, and feature dispatch before applying tolerances.
- Verify every interaction's equation, SI units, sign, mask, material heterogeneity, boundary condition, energy relation, and public reachability.
- Verify every integrator's tableau/order, normalization, rejected-step rollback, FSAL/history validity, accepted-state accounting, and stochastic-step semantics.
- A native CUDA test can close a GPU claim only when a repository-managed build/run path executes the implicated kernel on the intended precision and feature combination.
- Seed findings below are hypotheses from preliminary inspection. Re-anchor and prove them against the frozen HEAD; delete or downgrade any hypothesis contradicted by complete current source/caller evidence.
- Write intermediate evidence only below `.fullmag/audits/2026-07-09-backend-llg/fdm/` and preserve unrelated worktree changes.

---

### Task 1: Partition and Classify the FDM Source Set

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/coverage-rows.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/metadata.md`

**Interfaces:**
- Consumes: frozen backend inventory and contract ledger.
- Produces: the exhaustive FDM work queue and final FDM annex fragment.

- [ ] **Step 1: Assert the snapshot and extract FDM ownership**

Run:

```bash
test "$(cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt)" = "$(git rev-parse HEAD)"
rg '^backends/fdm/' .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt > .fullmag/audits/2026-07-09-backend-llg/fdm/files.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/fdm/files.txt
```

Expected: identity passes; the file count is recorded in `metadata.md` and later equals the number of unique FDM coverage rows.

- [ ] **Step 2: Assign one file role and subsystem before judging behavior**

Use these deterministic groups:

```text
build: backends/fdm/CMakeLists.txt
ABI: backends/fdm/api/**, backends/fdm/include/**
runtime: backends/fdm/gpu/cuda/runtime/**
demag: backends/fdm/gpu/cuda/demag/**, backends/fdm/gpu/cuda/interactions/demag_*.cu
exchange: backends/fdm/gpu/cuda/interactions/exchange*.cu
multilayer interactions: backends/fdm/gpu/cuda/interactions/multilayer_*.cu
integrators: backends/fdm/gpu/cuda/integrators/**
validation: backends/fdm/tests/**
```

Start `coverage-rows.md` with one row per `files.txt` entry using the master schema. Set `Reviewed` to `no`; no other verdict may be filled from filename alone.

- [ ] **Step 3: Verify one-to-one initial rows**

Run:

```bash
sed -n 's/^| `\(backends\/fdm\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fdm/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fdm/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fdm/files.txt .fullmag/audits/2026-07-09-backend-llg/fdm/covered-files.txt
```

Expected: no output.

### Task 2: Audit ABI, Validation, Context Ownership, and Reachability

**Files:**
- Read: `native/include/fullmag_fdm.h`
- Read: `crates/fullmag-fdm-sys/src/lib.rs`
- Read: `backends/fdm/api/c_api.cpp`
- Read: `backends/fdm/api/error.cpp`
- Read: `backends/fdm/include/context.hpp`
- Read: `backends/fdm/include/kernels.hpp`
- Read: `backends/fdm/gpu/cuda/runtime/context.cu`
- Read: `backends/fdm/gpu/cuda/runtime/device_info.cpp`
- Read: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`
- Read: `backends/fdm/gpu/cuda/runtime/streams.cu`
- Read: `backends/fdm/gpu/cuda/runtime/telemetry.cu`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/abi-runtime-notes.md`

**Interfaces:**
- Consumes: public reachability map and FDM contracts.
- Produces: validated creation/step/state/error/telemetry chains and ABI/runtime findings.

- [ ] **Step 1: Trace both legacy and v2 plan creation paths field by field**

For every public plan member, record: header type/unit, Rust binding type, caller initialization, backend validation, context storage, kernel consumption, and error behavior. Include dimensions, cell counts, precision, integrator, dt, gamma, alpha, Ms, exchange, demag spectra, PBC, volume fractions, active/region masks, anisotropy, DMI, Zeeman, thermal, STT, SOT, Oersted, and multilayer arrays.

- [ ] **Step 2: Audit validation as a set of executable invariants**

Check finite/range validation, null-plus-length pairs, overflow in products/byte sizes, enum validation, normalized axes, positive dimensions/cell sizes/Ms/dt/gamma, mask/region bounds, FFT shape, PBC legality, mutually exclusive inputs, unsupported precision-feature combinations, and cleanup on partial allocation failure. Record whether legacy and v2 paths enforce the same invariant.

- [ ] **Step 3: Audit context lifetime and state transitions**

Trace allocation, upload, initialization, per-step mutable state, adaptive snapshots, history/FSAL buffers, thermal state, streams/events, statistics, asynchronous snapshots, errors, and destruction. For every pointer, identify owner, precision-dependent element type, initialization before first read, rollback behavior, and free path.

- [ ] **Step 4: Audit step dispatch and public reachability**

Map each ABI integrator/precision/interaction combination to its exact kernel path or explicit rejection. Compare this with `crates/fullmag-plan`, `crates/fullmag-runner`, and the claim ledger. Silent substitution, accepted-but-unimplemented flags, ignored fields, and stale provenance become `ABI-*` or `CAP-*` candidates.

- [ ] **Step 5: Update coverage rows and write complete candidates**

Set `Reviewed=yes` for each ABI/runtime file only after its callers and consumers are traced. Write candidate finding records in `.fullmag/audits/2026-07-09-backend-llg/fdm/findings.md` using the master template.

### Task 3: Audit Demagnetization and Newell Convolution

**Files:**
- Read: `backends/fdm/gpu/cuda/demag/newell_gpu_fp64.cu`
- Read: `backends/fdm/gpu/cuda/demag/newell_gpu_fp32.cu`
- Read: `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu`
- Read: `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`
- Read: `backends/fdm/gpu/cuda/interactions/demag_fp32.cu`
- Read: `backends/fdm/gpu/cuda/interactions/demag_boundary_fp64.cu`
- Read: `crates/fullmag-engine/src/fdm/cpu/fft.rs`
- Read: `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs`
- Read: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/demag-notes.md`

**Interfaces:**
- Consumes: demag/Newell/PBC contracts and runtime ownership notes.
- Produces: demag sign, normalization, padding, boundary, precision, and reachability verdicts.

- [ ] **Step 1: Derive the discrete convolution pipeline end to end**

Trace physical magnetization input, volume fraction/mask application, padded layout, forward FFT normalization, six tensor spectra, symmetric off-diagonal signs, spectral multiplication, inverse normalization, crop, H-field units, energy/torque consumers, and boundary correction.

- [ ] **Step 2: Audit every Newell generation path**

For both precisions, verify tensor component formulas, displacement indexing, self term, parity/symmetry, cell-volume normalization, zero padding, 2D thin-film versus 3D shape, PBC image/supercell handling, stream synchronization, and the exact destination buffers consumed by convolution.

- [ ] **Step 3: Revalidate the automatic-kernel seed hypothesis**

Preliminary hypothesis: `context.cu` allocates `ctx.demag_kernel`, invokes automatic Newell generation, and marks the kernel available, while the generator may transform different temporary arrays and never copy spectra into the six context buffers later read by `demag_fp32.cu`/`demag_fp64.cu`.

Prove or reject this by writing the complete pointer/data-flow chain from allocation through generator output to the first convolution read. If any explicit copy, alias, or in-place transform resolves the concern, cite it and close the hypothesis. If the first read can observe uninitialized allocation, classify severity by public reachability and record an exact minimal configuration.

- [ ] **Step 4: Compare FP32, FP64, multilayer, PBC, and boundary behavior**

Create a parity table for tensor generation, PBC, boundary phi/H correction, mask/volume fraction, multilayer layer offsets, convolution batching, and energy/telemetry. Missing functionality must either reject publicly or become a lane-divergence finding.

- [ ] **Step 5: Assess current tests against physical oracles**

For `batched_demag_fft_contract.cpp`, `tier_a_compare.cu`, `tier_b_compare.cu`, and runner physics tests, record whether they test initialized automatic kernels, analytic tensor values, uniform/prism/ellipsoid fields, PBC seams, convolution sign, energy derivative, both precisions, and the public caller path.

### Task 4: Audit Exchange and Local/Driven Interactions

**Files:**
- Read: `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu`
- Read: `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu`
- Read: `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu`
- Read: `backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu`
- Read: `backends/fdm/gpu/cuda/interactions/multilayer_exchange.cu`
- Read: `backends/fdm/gpu/cuda/interactions/multilayer_dmi.cu`
- Read: `backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu`
- Read: `backends/fdm/gpu/cuda/interactions/multilayer_effective_field.cu`
- Read: `crates/fullmag-engine/src/fdm/shared/terms.rs`
- Read: `crates/fullmag-engine/src/fdm/cpu/fields.rs`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/interaction-notes.md`

**Interfaces:**
- Consumes: exchange/anisotropy/DMI/Zeeman/thermal/STT/SOT/Oersted contracts.
- Produces: per-interaction equation, energy, mask, boundary, and parity verdicts.

- [ ] **Step 1: Audit exchange coefficient and stencil families**

For standard, T0, T1, region-owned, and multilayer exchange, derive the discrete field from the documented energy. Verify `2 A/(mu0 Ms)`, cell-size powers, neighbor/interface coefficient rule, PBC wrap, free-boundary behavior, region/mask/volume fraction, nonmagnetic cells, units, and energy consistency.

- [ ] **Step 2: Revalidate the T0/T1 coefficient seed hypothesis**

Preliminary hypothesis: the T0/T1 FP64 paths may multiply by exchange stiffness once while accumulating the stencil and again in the final prefactor, creating an `A^2` coefficient and omitting the region mask.

Trace the units and every multiplication from loaded magnetization to output field. Compare a uniform field, a one-dimensional sinusoid, and a two-region interface algebraically with standard FP64 and the Rust reference. Retain a finding only if the complete current expressions prove the mismatch.

- [ ] **Step 3: Audit all local and driven terms hidden in effective-field kernels**

Inspect both `demag_fp32.cu` and `demag_fp64.cu`, context preprocessing, and multilayer composition for Zeeman, uniaxial/cubic anisotropy, interfacial/bulk DMI, thermal Brown field, STT, SOT, and Oersted. Classify each as conservative field, nonconservative field-equivalent, or direct torque; verify whether reported energy includes only valid conservative terms.

- [ ] **Step 4: Revalidate the arbitrary-axis Oersted seed hypothesis**

Preliminary hypothesis: the public ABI accepts an arbitrary unit `oersted_axis[3]`, while analytic cylinder preprocessing may construct only a z-axis azimuthal field.

Trace planner lowering, ABI copy, preprocessing geometry, axis use in every coordinate transform, time dependence, and kernel addition. Test the algebra at points around x-, y-, and z-axis cylinders. An unsupported axis must reject before execution or be reported as a wrong-field defect.

- [ ] **Step 5: Build a complete precision/feature parity matrix**

Rows: each interaction and boundary feature. Columns: Rust CPU, native FP64, native FP32, multilayer FP64, multilayer FP32, planner legality, ABI validation, current test. Record exact divergence and whether it is deliberate, rejected, silently ignored, or undocumented.

### Task 5: Audit Deterministic and Stochastic Integrators

**Files:**
- Read: `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_fp32.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_rk4_fp64.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_rk4_fp32.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_rk23_fp64.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_rk23_fp32.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_dp45_fp64.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_dp45_fp32.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_abm3_fp64.cu`
- Read: `backends/fdm/gpu/cuda/integrators/llg_abm3_fp32.cu`
- Read: `backends/fdm/gpu/cuda/integrators/multilayer_heun.cu`
- Read: `backends/fdm/gpu/cuda/integrators/multilayer_explicit_rk.cu`
- Read: `crates/fullmag-engine/src/fdm/cpu/integrators.rs`
- Read: `crates/fullmag-engine/src/fdm/shared/problem.rs`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/integrator-notes.md`

**Interfaces:**
- Consumes: common LLG, integrator, relaxation, and stochastic contracts.
- Produces: one numerical-method verdict per precision/integrator/feature combination.

- [ ] **Step 1: Derive and compare the LLG RHS**

Verify gamma convention and `mu0`, the Gilbert denominator, precession direction, damping sign, direct torque composition, tangent property, nonmagnetic zeroing, and alpha/material fields in native FP32/FP64 and Rust CPU.

- [ ] **Step 2: Reconstruct every deterministic method**

For Heun, RK4, BS23/RK23, Dormand-Prince RK45, ABM3, multilayer Heun, and multilayer explicit RK, tabulate stage nodes, `a`, `b`, embedded weights, error norm, normalization points, field evaluation times, FSAL/history ownership, startup method, adaptive exponent/clamps, acceptance decision, rollback, time/step counters, statistics, and final H-field freshness. Compare the implementation to the advertised method, not just its filename.

- [ ] **Step 3: Audit stochastic amplitude and state**

Derive thermal sigma from the contract using the exact gamma convention accepted by the ABI. Trace actual dt assignment, volume, Ms, alpha, temperature, seed, cell counter, step/attempt counter, precision conversion, and how one noise realization is shared across RK stages.

- [ ] **Step 4: Revalidate the thermal seed hypotheses**

Preliminary hypotheses: native thermal sigma may apply an extra `mu0`; `Context::current_dt` may retain its default rather than the requested step; and the native seed may be `step_count` without a public global seed. Separately, adaptive rejection may resample or retain noise inconsistently with the documented SDE method.

Prove or reject each by tracing runner dt/seed through ABI/context to cuRAND initialization and through accepted/rejected attempts. Quantify any amplitude error symbolically before assigning severity.

- [ ] **Step 5: Audit relaxation semantics on the FDM public path**

Trace whether `relax` is a dedicated method or repeated LLG stepping, which damping/integrator/dt is used, energy/torque stop definitions, max-step/time guards, final field refresh, artifact state, and CPU/GPU selection. A stable loop with a mismatched stop unit or stale final field is a defect.

### Task 6: Audit Tests, Oracles, and Seed Findings

**Files:**
- Read: `backends/fdm/tests/adaptive_error_reduction_contract.cpp`
- Read: `backends/fdm/tests/async_snapshot_contract.cpp`
- Read: `backends/fdm/tests/batched_demag_fft_contract.cpp`
- Read: `backends/fdm/tests/exchange_fp64_parity.cu`
- Read: `backends/fdm/tests/heun_fp64_parity.cu`
- Read: `backends/fdm/tests/multilayer_abi_v2_contract.cpp`
- Read: `backends/fdm/tests/multilayer_create_v2_contract.cpp`
- Read: `backends/fdm/tests/region_owned_abi_contract.cpp`
- Read: `backends/fdm/tests/smoke_context.cpp`
- Read: `backends/fdm/tests/source_layout_contract.cpp`
- Read: `backends/fdm/tests/stats_mode_contract.cpp`
- Read: `backends/fdm/tests/tier_a_compare.cu`
- Read: `backends/fdm/tests/tier_b_compare.cu`
- Read: `backends/fdm/CMakeLists.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/test-matrix.md`

**Interfaces:**
- Consumes: all source findings and CMake test registrations.
- Produces: exact statement of what current tests prove and miss.

- [ ] **Step 1: Classify every test assertion**

Use columns:

```text
Test path | CMake/runner target | Executed lane and precision | Fixture | Physical/numerical assertion | Tolerance and origin | Public caller exercised | Result | Blind spots | Finding IDs
```

Distinguish source-text/layout checks, construction smokes, kernel unit tests, reference parity, convergence tests, analytical physics tests, and public runtime tests.

- [ ] **Step 2: Audit tolerances and reference independence**

For each numerical comparison, derive the expected discretization/roundoff error. Flag shared-code oracles, copied formulas, hard-coded expected values produced by the implementation under test, and unexplained 5–10% tolerances.

- [ ] **Step 3: Consolidate preliminary hypotheses only after proof**

Explicitly close, retain, or downgrade every preliminary item below against the frozen source and caller chain:

1. automatic Newell generation destination and first convolution read;
2. bulk-DMI field sign versus energy, docs, and Rust CPU reference;
3. T0/T1 exchange stiffness multiplication, masks, incomplete payloads, and PBC legality;
4. FP32 PBC, boundary correction, volume fraction, T0/T1 dispatch, and field-energy divergence;
5. thermal gamma/`mu0`, actual dt, seed/replay, stage reuse, and adaptive retry;
6. nonblocking compute-stream ordering around backup, FSAL, reject restore, and default-stream RHS kernels;
7. FSAL and ABM3 invalidation after magnetization upload, thermal activation, and discontinuous fields;
8. RK stage times and final refresh for sinusoidal/pulsed Oersted;
9. arbitrary-axis Oersted geometry;
10. SOT units/gamma/Gilbert transform and inactive-mask behavior, plus Zhang–Li mask/PBC behavior;
11. masked multilayer push/pull moment conservation;
12. interfacial/bulk DMI free-boundary closure;
13. partial-cell energy weights and active-interaction completeness of `E_total`;
14. legacy/v2 enum, dt, finite-value, region-ID, and partial-payload validation;
15. registered CTest source paths and skip/pass semantics;
16. adaptive-controller contract, ABM3 variable-step order, stats initialization, and input magnetization normalization.

### Task 7: Run Focused FDM Evidence Gates

**Files:**
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/commands.tsv`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/runtime-evidence.md`

**Interfaces:**
- Consumes: test matrix and proven/high-confidence findings.
- Produces: executable evidence without modifying the audited source.

- [ ] **Step 1: Run the Rust CPU reference tests**

Run:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-backend-llg-audit-fdm-target cargo +nightly test -p fullmag-engine fdm
CARGO_TARGET_DIR=/tmp/fullmag-backend-llg-audit-fdm-target cargo +nightly test -p fullmag-runner physics_validation
```

Expected: record exact exit codes and full logs. Passing tests support only the assertions mapped in `test-matrix.md`; failures are diagnosed before any retry.

- [ ] **Step 2: Run public CPU reachability smokes**

Run each separately and retain stdout/stderr:

```bash
just run-fdm-cpu-smoke
just run-fdm-hysteresis-smoke
just run-fdm-hysteresis-snapshot-smoke
just run-hysteresis-fdm-macrospin-sw-smoke
just run-hysteresis-fdm-thinfilm-oop-ip-smoke
```

Expected: each command's exit code, resolved backend/device/precision/integrator, artifact path, and asserted physical property are recorded. A zero exit code proves reachability, not correctness of every interaction.

- [ ] **Step 3: Inspect native CUDA test accessibility before execution**

Run:

```bash
rg -n 'add_test\(NAME fdm_' backends/fdm/CMakeLists.txt
rg -n '^([A-Za-z0-9_-]*fdm[A-Za-z0-9_-]*|[A-Za-z0-9_-]*gpu[A-Za-z0-9_-]*fdm[A-Za-z0-9_-]*):' justfile
```

Expected: identify the exact repository-managed recipe, if any, that builds and runs native FDM CTest targets. If none exists, record `VAL-*` as a managed GPU validation gap; do not invent a host-first CMake or raw Docker route and do not claim the CUDA tests were runtime-proven.

- [ ] **Step 4: Assign evidence states conservatively**

Use `proven_test` only for a focused test that reproduces the exact defect, `proven_runtime` only for the intended public native lane, and `physics_validated` only for an analytical/convergence/standard-problem comparison. Source proof remains `proven_static` even when a nearby smoke passes.

### Task 8: Close FDM Coverage and Handoff

**Files:**
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fdm/coverage-rows.md`
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fdm/findings.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fdm/workstream-summary.md`

**Interfaces:**
- Consumes: all FDM notes, tests, commands, and findings.
- Produces: synthesis-ready FDM evidence.

- [ ] **Step 1: Finalize every row**

Every FDM row must have `Reviewed=yes`, a contract verdict, reachability verdict, test verdict, evidence state, finding IDs or `none`, and a meaningful note. Build/test files are judged for whether they compile/run the intended physics, not assigned `not applicable` without explanation.

- [ ] **Step 2: Verify exhaustive unique coverage**

Run:

```bash
sed -n 's/^| `\(backends\/fdm\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fdm/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fdm/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fdm/files.txt .fullmag/audits/2026-07-09-backend-llg/fdm/covered-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/fdm/covered-files.txt
rg -n '\| no \||T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|not yet revie[w]ed' .fullmag/audits/2026-07-09-backend-llg/fdm
```

Expected: all searches/comparisons print nothing.

- [ ] **Step 3: Write the FDM verdict**

Summarize separately: Rust CPU reference, public FDM CPU execution, native GPU FP64, native GPU FP32, multilayer, statics/relaxation, deterministic dynamics, stochastic dynamics, implemented interactions, public reachability, runtime evidence, physics validation, P0–P3 counts, and blocked claims.

- [ ] **Step 4: Confirm the workstream changed no tracked files**

Run:

```bash
git status --short --untracked-files=all
```

Expected: no FDM audit work appears outside ignored `.fullmag/audits/`; unrelated changes are untouched.
