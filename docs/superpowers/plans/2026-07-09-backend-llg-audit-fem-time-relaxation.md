# Backend LLG Audit FEM Time Domain and Relaxation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit every semantically selected FEM time-domain/static/relaxation backend file and its public caller chain for physical, numerical, residency, observable, validation, and maturity defects in statics, relaxation, deterministic LLG, and stochastic LLG.

**Architecture:** Own every path selected as `include` by the frozen semantic `backends/fem` scope ledger, then inspect core/material import, CPU/MFEM physics, GPU/CUDA physics, integrators, direct minimizers, ABI/state I/O, and tests as one connected contract. Repository-managed `just` routes provide native evidence; source, public execution, runtime proof, and physics validation remain distinct.

**Tech Stack:** C++20, MFEM, hypre, libCEED, CUDA, Rust planner/runner/bindings, C ABI, CMake contracts, repository container-backed `just` recipes.

## Global Constraints

- Audit only: do not edit FEM source, tests, examples, public ABI, planner, runner, capabilities, canonical notes, build scripts, or runtime recipes.
- Every frozen backend-universe path receives one semantic scope decision; every selected time-domain/static/relaxation path receives exactly one coverage row, including mixed build/ABI/API, example, test, compatibility, and generated files.
- Shared non-frequency FEM core/API files are owned here; their coverage rows assess only time-domain, statics, and relaxation consumers.
- Keep CPU/MFEM and GPU/CUDA realizations separate while judging them against one backend-neutral physics contract.
- Trace material data as fields, not just scalar defaults; verify conformal element data, nodal data, region masks, nonmagnetic masks, mass weights, and energy weights independently.
- Conservative fields must satisfy the discrete energy derivative; thermal and spin torques must not enter direct energy minimizers without a documented work functional.
- Verify all supported explicit RK integrators, not only Heun, and verify final-field/observable freshness after accepted steps.
- Native FEM/MFEM/CUDA/hypre/libCEED evidence starts with matching repository `just` recipes. Host builds and direct binaries cannot close native runtime claims.
- Seed findings below are preliminary hypotheses. Revalidate on the frozen HEAD and retain only complete, current source/caller evidence.
- Write intermediate evidence only below `.fullmag/audits/2026-07-09-backend-llg/fem-time/` and preserve unrelated changes.

---

### Task 1: Partition and Classify the Non-Frequency FEM Source Set

**Files:**
- Read: `.fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/files.txt`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/metadata.md`

**Interfaces:**
- Consumes: frozen inventory and common contract ledger.
- Produces: exhaustive non-frequency FEM work queue and annex fragment.

- [ ] **Step 1: Assert snapshot identity and extract ownership**

Run:

```bash
test "$(cat .fullmag/audits/2026-07-09-backend-llg/snapshot/head.txt)" = "$(git rev-parse HEAD)"
cp .fullmag/audits/2026-07-09-backend-llg/snapshot/backend-files.txt .fullmag/audits/2026-07-09-backend-llg/fem-time/files.txt
wc -l .fullmag/audits/2026-07-09-backend-llg/fem-time/files.txt
```

Expected: identity passes; the recorded count later equals the number of unique coverage rows.

- [ ] **Step 2: Assign initial roles without inferring correctness**

Classify by exact leading path:

```text
backends/fem/core/**: backend-neutral state/material/mesh/buffer core
backends/fem/cpu/mfem/**: CPU/MFEM production or bootstrap implementation
backends/fem/gpu/cuda/**: GPU/CUDA production or bootstrap implementation
backends/fem/include/**: ABI/internal contracts and state ownership
backends/fem/src/**: shared/API implementation
backends/fem/tests/**: validation, excluding /frequency_domain/
backends/fem/examples/**: embedded examples
backends/fem/cmake/** and CMakeLists.txt: build/configuration
```

Create one master-schema row per file with `Reviewed=no`.

- [ ] **Step 3: Prove initial one-to-one coverage**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fem-time/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fem-time/files.txt .fullmag/audits/2026-07-09-backend-llg/fem-time/covered-files.txt
```

Expected: no output.

### Task 2: Audit Core State, Material Lowering, ABI, and Runtime Reachability

**Files:**
- Read: `backends/fem/core/**`
- Read: `backends/fem/include/context.hpp`
- Read: `backends/fem/include/fullmag_fem_private.hpp`
- Read: `backends/fem/src/api.cpp`
- Read: `native/include/fullmag_fem.h`
- Read: `crates/fullmag-fem-sys/src/lib.rs`
- Read: `crates/fullmag-plan/src/fem.rs`
- Read: `crates/fullmag-runner/src/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/core-abi-notes.md`

**Interfaces:**
- Consumes: public reachability map and material/LLG contracts.
- Produces: exact data ownership, validation, requested/resolved, and field-propagation verdicts.

- [ ] **Step 1: Trace every public plan field to its backend consumer**

For mesh/domain, magnetization, active mask, regions, scalar and spatial material properties, exchange, demag strategy, Zeeman, anisotropy, DMI, thermal, STT, Oersted, magnetoelasticity, integrator, adaptive controller, relaxation algorithm, solver policy, and observables, record `DSL -> ProblemIR -> planner -> runner -> sys -> C ABI -> Context -> CPU/GPU consumer`.

- [ ] **Step 2: Audit ABI versioning, sizes, and validation**

Check time-domain `abi_version`/`struct_size`, enum/range/finite validation, null-plus-length pairs, mesh/index bounds, material array lengths, strict-device requests, unsupported combinations, error handles, stats initialization, and compatibility behavior against the public FEM ABI.

- [ ] **Step 3: Build a material-propagation matrix**

Rows: `Ms`, `A`, alpha, gamma, temperature, anisotropy constants/axes, DMI, current/torque coefficients, strain/magnetoelastic constants. Columns: scalar default, nodal field, element field, region representation, CPU field, CPU energy, GPU field, GPU energy, relaxation gradient, observable. Record all fallback precedence and units.

- [ ] **Step 4: Revalidate the conformal element-Ms seed hypothesis**

Preliminary hypothesis: the planner can produce `ms_element_field` while suppressing a nodal `Ms_field`; only CPU exchange consumes element `Ms`, and demag, Zeeman, anisotropy, DMI, thermal, STT, magnetoelasticity, GPU coefficient upload, and energies fall back to one scalar material value.

Trace the complete current lowering and every consumer. Use the invariant that swapping which material is chosen as the scalar base must not change an otherwise identical heterogeneous physical problem. If current code cannot preserve that invariant, record exact affected terms and public legality; recommend rejection until semantics are implemented.

- [ ] **Step 5: Audit context and state lifecycle**

Trace mesh ownership, MFEM spaces/grid functions, GPU resident buffers, coefficient upload/revision, demag solver state/cache, accepted/trial magnetization, current/pseudo time, step/attempt counters, profiler state, observable buffers, snapshot/export, errors, cancellation, and destruction. Identify every host/device synchronization and stale-data risk.

### Task 3: Audit CPU/MFEM Interactions, Demag, Energy, and Observables

**Files:**
- Read: `backends/fem/cpu/mfem/interactions/**`
- Read: `backends/fem/cpu/mfem/demag/**`
- Read: selected paths below `backends/fem/cpu/mfem/runtime/**` listed in
  `snapshot/backend-files.txt`; explicitly exclude `eigen_dense.cpp` and
  `eigen_dense.hpp`
- Read: `backends/fem/cpu/mfem/integrators/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/cpu-physics-notes.md`

**Interfaces:**
- Consumes: contract and material ledgers.
- Produces: CPU per-interaction equation/energy/discretization and observable verdicts.

- [ ] **Step 1: Audit exchange and local conservative interactions**

For exchange, Zeeman, uniaxial/cubic anisotropy, interfacial/bulk DMI, and prescribed-strain magnetoelasticity, derive field or weak residual from the documented energy. Verify signs, `mu0`/`Ms`, quadrature/mass projection, heterogeneous coefficients, material interfaces, boundary terms, mesh orientation, active mask, nonmagnetic zeroing, and energy density/total energy.

- [ ] **Step 2: Audit every demag strategy and policy**

Trace Poisson-airbox, periodic/static variants, FEM/BEM/Fredkin–Koehler, gauge/BC, RHS sign and `Ms`, field recovery, airbox versus magnet domains, energy, cache/warm start, solver/preconditioner/tolerance, residual, failure behavior, and provenance. Keep bootstrap/reference and production paths separate.

- [ ] **Step 3: Audit direct and stochastic terms**

For thermal Brown, Slonczewski, Zhang–Li, and Oersted, verify units,
gamma/alpha convention, stage-time dependence, masks, current/polarization
direction, direct-torque composition, and whether energy/minimizer paths reject
nonconservative configurations. SOT has no native FEM implementation in this
scope; inspect only that public FEM requests reject it explicitly and
truthfully.

- [ ] **Step 4: Audit CPU observables and final-state freshness**

Trace `m`, averages, energies, energy densities, H components, demag phi, H_demag, H_eff, H_OE, torque, step metrics, and artifacts. Verify volume or moment weighting, scalar/spatial alpha, precession-enabled behavior, current scaling, full-domain versus magnetic-domain semantics, and that values correspond to the accepted state/time.

### Task 4: Audit GPU/CUDA Interactions, Residency, Energy, and Observables

**Files:**
- Read: `backends/fem/gpu/cuda/demag/**`
- Read: `backends/fem/gpu/cuda/demag_poisson/**`
- Read: `backends/fem/gpu/cuda/exchange/**`
- Read: `backends/fem/gpu/cuda/fields/**`
- Read: `backends/fem/gpu/cuda/interactions/**`
- Read: `backends/fem/gpu/cuda/materials/**`
- Read: `backends/fem/gpu/cuda/reductions/**`
- Read: `backends/fem/gpu/cuda/runtime/**`
- Read: `backends/fem/gpu/cuda/state/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/gpu-physics-notes.md`

**Interfaces:**
- Consumes: CPU verdicts and shared contract ledger.
- Produces: strict GPU correctness/parity/residency verdicts independent of CPU.

- [ ] **Step 1: Repeat the per-interaction derivation for GPU kernels**

Do not infer parity from shared headers. For every interaction, trace coefficient upload, kernel formula, indexing, masks, material fields, output buffer, energy reduction, and field composition; compare algebraically with the common contract and then with CPU.

- [ ] **Step 2: Audit strict-device residency and solver boundaries**

Record allocations, uploads, downloads, Hypre/device ownership, libCEED/MFEM interop, `cudaDeviceSynchronize`, scalar readbacks, per-stage demag solve count, cache/warm start, rollback, profiler events, and any host fallback. A strict GPU request that executes a host operator or silently resolves to CPU is a capability defect.

- [ ] **Step 3: Revalidate observable seed hypotheses**

Preliminary hypotheses to prove or reject individually:

1. GPU `DEMAG_PHI` may expose stale host `gf_potential` after a device solve updates only the GPU Poisson solution.
2. GPU H_demag recovery may zero airbox nodes while CPU exposes a full-domain visualization field, making nominally identical observables semantically different.
3. Cylinder `H_OE` may publish the unit-current buffer instead of `I(t) H_unit`.
4. `TORQUE` may ignore `precession_enabled` and spatial alpha.
5. `mx/my/mz` may be an unweighted nodal mean and change under local mesh refinement.

For each, trace update time, buffer identity, scale, domain, weighting, and public metadata.

- [ ] **Step 4: Audit CPU/GPU comparison tests for shared blind spots**

Check whether both lanes reuse the same wrong scalar material fallback, omit the same energy term, compare only final scalars, ignore airbox values, or allow host fallback. Shared error is not parity proof.

### Task 5: Audit Explicit RK, Adaptive Control, Thermal SDE, and Non-Autonomous Fields

**Files:**
- Read: `backends/fem/cpu/mfem/integrators/**`
- Read: `backends/fem/gpu/cuda/integrators/**`
- Read: `backends/fem/gpu/cuda/llg/**`
- Read: `backends/fem/gpu/cuda/fields/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/integrator-notes.md`

**Interfaces:**
- Consumes: LLG/RK/thermal/Oersted contracts.
- Produces: one method verdict per CPU/GPU integrator and stochastic mode.

- [ ] **Step 1: Derive CPU and GPU LLG RHS independently**

Verify gamma convention, Gilbert denominator, `mu0`, precession/damping signs, field and direct-torque transformation, spatial alpha/gamma, tangent projection, inactive nodes, normalization, NaN/zero handling, and accepted-state norm.

- [ ] **Step 2: Reconstruct every supported RK method**

For Heun, RK4, BS23/RK23, RK45, and every shared tableau/dispatch path, record stages, nodes, coefficients, embedded pair, error norm, normalization, field/demag evaluation count, final refresh, acceptance/rejection, snapshots, state counters, and CPU/GPU differences. Verify observed method claims are not inferred from one Heun smoke.

- [ ] **Step 3: Audit adaptive controller mathematics**

Check `dt_initial/min/max`, estimator order, PI gains/exponents, safety and clamps, previous-error state, forced acceptance, retry cap, rollback of magnetization/fields/demag cache/RNG/counters, projected versus unprojected error, and failure on NaN/Inf.

- [ ] **Step 4: Revalidate the Oersted stage-time seed hypothesis**

Preliminary hypothesis: CPU/GPU RK RHS evaluation does not receive `t_n+c_s dt`; Oersted reads only `current_time`, which advances after final refresh. Trace time through all stage evaluators and final artifacts. Quantify the order loss and wrong pulse-boundary sampling for every affected integrator.

- [ ] **Step 5: Revalidate thermal convention and retry semantics**

Derive sigma from the exact ABI gamma convention. Trace CPU/GPU seed keys, nodal volume, Ms, alpha, temperature, dt, stage reuse, accepted/rejected attempts, and counter advancement. Preliminary evidence suggests CPU retry hashes time/dt while GPU keys only seed/node/component/step index; prove whether Wiener increments are resampled, scaled, or retained and whether the documented SDE method justifies it. If not executable, classify `risk_requires_test`, not a proven amplitude bug.

- [ ] **Step 6: Define required numerical proofs**

For each deterministic method require a macrospin or manufactured ODE observed-order study plus norm/final-field checks. For thermal require variance scaling with `T`, alpha, `1/Ms`, `1/V`, `1/dt`, seed replay, and Boltzmann equilibrium with stated confidence bounds before `physics_validated` status.

### Task 6: Audit Overdamped LLG and Direct Minimizers

**Files:**
- Read: `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- Read: `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- Read: `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`
- Read: `backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp`
- Read: `backends/fem/cpu/mfem/relaxation/**.hpp`
- Read: `backends/fem/gpu/cuda/relaxation/**`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/relaxation-notes.md`

**Interfaces:**
- Consumes: energy derivative, metric, demag, and stopping contracts.
- Produces: independent verdicts for overdamped LLG, PG-BB, NCG, and TPI on CPU/GPU.

- [ ] **Step 1: Audit the optimization geometry**

For each algorithm, derive tangent projection, mass/volume/Ms metric, Riemannian gradient, retraction, vector transport, BB step, CG beta/restart, line search, preconditioner, trial/accepted state, and stopping torque/gradient units.

- [ ] **Step 2: Revalidate gradient/Armijo dimensional consistency**

Preliminary hypothesis: CPU and GPU direct minimizers use `g=-P_m H_eff` with only volume weights, while a Joule-valued energy derivative requires `-mu0 Ms P_m H_eff`; Armijo then compares quantities with incompatible units and heterogeneous Ms weighting is wrong.

Derive the discrete gradient for the actual chosen metric, track units of step length and `<g,d>`, and inspect every energy comparison. A constant rescaling for homogeneous Ms may preserve direction but does not repair a dimensionally inconsistent Armijo condition.

- [ ] **Step 3: Revalidate nonconservative-term legality**

Trace which terms enter H_eff, direct torque, and E_total. Preliminary evidence says Oersted and thermal can enter H_eff while E_total omits them, and STT has no energy. Verify that PG-BB/NCG/TPI reject thermal and spin torque, and reject Oersted unless a matching conservative energy is implemented. Silent execution becomes a correctness finding.

- [ ] **Step 4: Revalidate demag-cache behavior in minimizers**

Preliminary hypothesis: demag refresh is keyed only by physical `current_time`, while direct minimizers reset or do not advance it, so `demag_interval_s` can freeze H_demag across changing trial states. Trace every cache key, trial, rejection, acceptance, and pseudo-time update; count actual demag solves.

- [ ] **Step 5: Revalidate the TPI operator scaling**

Preliminary hypothesis: TPI combines an Ms-weighted mass matrix with raw exchange stiffness lacking the required `2/mu0` scale, local/DMI/demag blocks use different weighting, and the trial step may be applied both inside the operator and again in retraction.

Write the assembled/matrix-free operator equation term by term with units and compare to a small explicit matrix oracle. Keep its current under-development status separate from conflicting production-executable docs.

- [ ] **Step 6: Audit relaxation time and completion semantics**

Determine whether reported `dt_seconds`/`pseudo_time_s` have physical time units for each algorithm, how max steps/time guards apply, whether energy is monotone where expected, how convergence is defined, and whether the final field/energy/torque/artifact is recomputed at the accepted final state.

### Task 7: Audit Tests and Run Managed Native Evidence Gates

**Files:**
- Read: `backends/fem/tests/**` excluding `backends/fem/tests/frequency_domain/**`
- Read: `backends/fem/CMakeLists.txt`
- Read: `justfile`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/test-matrix.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/commands.tsv`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/runtime-evidence.md`

**Interfaces:**
- Consumes: all FEM time/relaxation findings.
- Produces: exact test-proof map and managed runtime evidence.

- [ ] **Step 1: Classify every non-frequency FEM test**

Use columns:

```text
Test path | CMake/just target | Lane/device | Fixture | Exact assertion | Tolerance origin | Public caller | Result | Blind spots | Finding IDs
```

Distinguish source-string contracts, algebraic unit tests, synthetic operators, native unit tests, managed runtime smokes, convergence studies, cross-device comparisons, and analytical physics validation.

- [ ] **Step 2: Inspect each recipe before running it**

Read the full `justfile` body for each selected target and confirm it exercises the implicated formula, lane, interaction, material representation, integrator, and observable. Passing a homogeneous Heun smoke cannot close heterogeneous-Ms, RK45, TPI, thermal, or observable findings.

- [ ] **Step 3: Establish the managed runtime**

Run:

```bash
just ensure-managed-fem-runtime
```

Expected: a current managed runtime and manifest or a fully recorded container/dependency/driver failure. Do not replace this with a host build.

- [ ] **Step 4: Run focused source and runtime gates separately**

Run and retain full stdout/stderr for each:

```bash
just verify-fem-relaxation-source-contract
just verify-fem-exchange-runtime
just verify-fem-demag-poisson-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just bench-fem-box500-consistency quick
```

Expected: record exact exit code, resolved CPU/GPU path, integrators/algorithms actually selected, artifact paths, and claims asserted. A failure is classified as solver, test, dependency, container, driver, resource, or evidence-contract failure before retrying.

- [ ] **Step 5: Assign evidence states**

`proven_runtime` requires the public managed lane and exact implicated behavior; `physics_validated` additionally requires an independent analytical, convergence, or standard-problem oracle. A passing source-contract remains source evidence.

### Task 8: Close FEM Time/Relaxation Coverage and Handoff

**Files:**
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md`
- Finalize: `.fullmag/audits/2026-07-09-backend-llg/fem-time/findings.md`
- Create: `.fullmag/audits/2026-07-09-backend-llg/fem-time/workstream-summary.md`

**Interfaces:**
- Consumes: all workstream evidence.
- Produces: synthesis-ready FEM time-domain and relaxation verdict.

- [ ] **Step 1: Finalize every owned coverage row**

Every row must have `Reviewed=yes`, complete contract/reachability/test/evidence verdicts, finding IDs or `none`, and a meaningful note. Shared files must state which in-scope time-domain, statics, and relaxation consumers were checked.

- [ ] **Step 2: Consolidate all mandatory seed checks**

Explicitly close, retain, or downgrade: conformal element Ms propagation; demag cache in minimizers; gradient/Armijo units; nonconservative minimizer legality; Oersted stage time; GPU phi/airbox/H_OE/torque/average observables; TPI operator scale; thermal gamma/retry convention; adaptive PI/order/projected error; normalization NaN handling; pseudo-time units; ABI versioning; STT Lambda documentation; strict-GPU sync/transfer limitations.

- [ ] **Step 3: Verify exhaustive unique coverage and no placeholders**

Run:

```bash
sed -n 's/^| `\(backends\/fem\/[^`]*\)`.*/\1/p' .fullmag/audits/2026-07-09-backend-llg/fem-time/coverage-rows.md | LC_ALL=C sort > .fullmag/audits/2026-07-09-backend-llg/fem-time/covered-files.txt
comm -3 .fullmag/audits/2026-07-09-backend-llg/fem-time/files.txt .fullmag/audits/2026-07-09-backend-llg/fem-time/covered-files.txt
uniq -d .fullmag/audits/2026-07-09-backend-llg/fem-time/covered-files.txt
rg -n '\| no \||T[B]D|TO[D]O|FIXM[E]|PLACEH[O]LDER|not yet revie[w]ed' .fullmag/audits/2026-07-09-backend-llg/fem-time
```

Expected: all comparisons/searches print nothing.

- [ ] **Step 4: Write independent lane/workflow verdicts**

Summarize CPU/MFEM and strict GPU separately for statics, overdamped LLG, PG-BB, NCG, TPI, deterministic RK, stochastic LLG, every interaction, demag strategies, heterogeneous materials, observables, implemented/public-executable/runtime-proven/physics-validated maturity, P0–P3 counts, and blocked claims.

- [ ] **Step 5: Confirm no tracked files changed**

Run:

```bash
git status --short --untracked-files=all
```

Expected: workstream evidence is ignored and unrelated changes remain untouched.
