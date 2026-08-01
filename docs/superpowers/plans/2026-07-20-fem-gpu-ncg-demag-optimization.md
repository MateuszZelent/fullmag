# FEM GPU NCG and Demag Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make steady FEM GPU nonlinear-CG relaxation reuse its exact accepted endpoint and persistent HYPRE setup so the no-backtrack hot loop falls from two demag solves to one, while repairing canonical Armijo energy increments and replacing the global CUDA barrier with exact HYPRE-stream ordering.

**Architecture:** First migrate the managed FEM image as one tested pair from MFEM 4.7/HYPRE 2.32.0 to MFEM 4.9/HYPRE 3.1.0 without changing Fullmag numerics. Then keep the backend-neutral direct-minimizer contract in `src/relaxation_numerics.hpp`, place reusable CUDA direct-energy evaluation inside the GPU relaxation owner, and store only bounded validity metadata beside existing GPU relaxation buffers. Keep HYPRE setup and stream interop inside the CUDA Poisson-demag subsystem; strict execution uses the exact HYPRE 3.1.0 compute stream and fails closed when its compile-time contract is unavailable.

**Tech Stack:** C++17, CUDA Runtime API, MFEM 4.7.0, HYPRE 2.32.0, CMake/CTest, repository-managed Docker/`just` FEM runtime, Python benchmark validator.

## Global Constraints

- Solver lane is FEM GPU; CPU physics semantics remain the reference contract.
- Distinct trial endpoints use deterministic fresh zero-initial Poisson solves at `rtol <= 1e-12` for production relaxation.
- Never weaken tolerances, mesh quality, field quality, artifact fidelity, or convergence criteria for speed.
- Do not add physics or workflow ownership to `Context`, `mfem_bridge.cpp`, Rust dispatch, or generic orchestration modules.
- Strict GPU execution remains device-resident and fails closed; no silent host solver or unaudited barrier fallback.
- Preserve the opt-in bounded solver profiler and allocate/log nothing when it is disabled.
- Public Python, ProblemIR, planner, OpenAPI, capability, and UI contracts do not change.
- Upgrade MFEM and HYPRE together to exactly `v4.9` and `v3.1.0`; keep CUDA base, libCEED, PETSc, and SLEPc unchanged.
- Fullmag explicitly sets solver tolerances, iteration limits, preconditioner, and AMG policy; upstream defaults must not change results.
- Do not modify `external_solvers/3` or `tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.
- Native build and runtime evidence comes from container-backed repository `just` recipes, not host builds.
- Runtime readiness and benchmark success are not full NIST SP4 qualification.

---

## File Map

**Create**

- `backends/fem/gpu/cuda/relaxation/direct_energy_increment.hpp` — internal CUDA direct-minimizer endpoint snapshot, polarized increment, and bounded refinement interface.
- `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp` — shared PG-BB/NCG implementation using existing energy and CUDA reduction owners.
- `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp` — strict version-pinned stream-ordering interface.
- `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp` — HYPRE 2.32.0 exact compute-stream adapter and CUDA event bridge.

**Modify**

- `docker/fem-gpu/Dockerfile` — managed MFEM 4.9/HYPRE 3.1.0 pins.
- `docs/guides/mfem-host-parity-setup-ubuntu22.md` — supported managed dependency pair.
- `backends/fem/tests/source_facade_export_progress_contract.cpp` — dependency-pin and runtime-export contract.
- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` — canonical accepted-endpoint reuse and NCG direct-increment semantics.
- `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md` — persistent setup, exact HYPRE stream, and synchronization telemetry.
- `docs/physics/0560-all-in-gpu-fem-runtime.md` — strict event ordering and fail-closed version contract.
- `backends/fem/CMakeLists.txt` — register the two focused new source owners.
- `backends/fem/gpu/cuda/relaxation/pgbb.cpp` — consume shared direct-increment evaluator without changing PG-BB policy.
- `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` — canonical Armijo increment and one-shot accepted endpoint reuse.
- `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp` — bounded accepted-evaluation token and counters.
- `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp` — deterministic token reset on allocation/free.
- `backends/fem/gpu/cuda/state/gpu_state.cpp` — invalidate endpoint metadata on state uploads and destruction.
- `backends/fem/gpu/cuda/demag_poisson/operators.hpp` — setup and stream-interoperability state owned by the workspace.
- `backends/fem/gpu/cuda/demag_poisson/operators.cpp` — destroy borrowed/event resources through the interop owner.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.hpp` — replace per-RHS rebuild API with setup-once API.
- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` — explicit setup once, solver-signature validation, zero-guess reuse.
- `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` — exact stream waits, no raw global barrier, truthful setup counters.
- `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp` — bounded setup/fresh-guess/event/global-sync counters.
- `backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp` — publish truthful existing timing fields and internal profiler counters where supported.
- `backends/fem/tests/relaxation_source_contract.cpp` — source boundary and NCG direct-increment/cache contract tests.
- `backends/fem/tests/relaxation_energy_derivative_contract.cpp` — cancellation/refinement decision tests.
- `backends/fem/tests/demag_poisson_contract.cpp` — persistent setup and zero-initial iterate tests.
- `backends/fem/tests/cuda_demag_timing_contract.cpp` — canonical exact-stream bridge and no-global-sync source test.
- `backends/fem/tests/source_facade_gpu_rk_contract.cpp` — remove the contradictory global-barrier expectation.
- `backends/fem/tests/cuda_periodic_demag_contract.cpp` — runtime setup reuse and strict ordering coverage.
- `scripts/analysis/fem_gpu_benchmark.py` — NCG solve-count/setup/synchronization acceptance.
- `justfile` — include dependency, CUDA interop, and benchmark assertions in named managed gates.

---

### Task 0: Upgrade and qualify the managed MFEM/HYPRE pair

**Files:**

- Modify: `docker/fem-gpu/Dockerfile`
- Modify: `docs/guides/mfem-host-parity-setup-ubuntu22.md`
- Modify: `backends/fem/tests/source_facade_export_progress_contract.cpp`
- Modify: `justfile`
- Verify: `.fullmag/runtimes/fem-gpu-host/include/mfem/config/_config.hpp`
- Verify: `.fullmag/runtimes/fem-gpu-host/include/HYPRE_config.h`

**Interfaces:**

- Consumes: existing CUDA 12.4.1, libCEED 0.12.0, MPI, PETSc/SLEPc and managed export pipeline.
- Produces: one supported `MFEM_VERSION == 40900` and `HYPRE_RELEASE_NUMBER == 30100` runtime bundle; no Fullmag solver behavior change.

- [ ] **Step 1: Write the failing dependency-pin contract**

Extend `source_facade_export_progress_contract.cpp` to read `docker/fem-gpu/Dockerfile` and the parity guide:

```cpp
check(
    dockerfile.find("ENV MFEM_REF=v4.9") != std::string::npos,
    "managed FEM image must pin MFEM 4.9");
check(
    dockerfile.find("ENV HYPRE_REF=v3.1.0") != std::string::npos,
    "managed FEM image must pin HYPRE 3.1.0");
check(
    guide.find("MFEM v4.9") != std::string::npos &&
        guide.find("hypre v3.1.0") != std::string::npos,
    "host parity guide must match managed dependency pins");
```

Add a managed focused recipe that builds and executes the existing contract target:

```make
verify-fem-dependency-stack-contract:
    docker compose --profile fem-gpu run --rm \
      fem-gpu bash -lc 'cd /workspace && cmake --build native/build --target fem_source_facade_export_progress_contract && LD_LIBRARY_PATH=/workspace/native/build/backends/fem:${LD_LIBRARY_PATH:-} native/build/backends/fem/fem_source_facade_export_progress_contract'
```

- [ ] **Step 2: Verify RED in the managed contract target**

Run:

```bash
just verify-fem-dependency-stack-contract
```

Expected: `fem_source_facade_export_progress_contract` fails because the image still contains `v4.7` and `v2.32.0`.

- [ ] **Step 3: Update only the two dependency pins and guide**

Use exact tags:

```dockerfile
ENV MFEM_REF=v4.9
ENV LIBCEED_REF=v0.12.0
ENV HYPRE_REF=v3.1.0
```

Do not change CUDA, compiler, MPI, libCEED, PETSc/SLEPc, build flags, AMG policy, or Fullmag numerical code in this commit.

- [ ] **Step 4: Rebuild the managed image and runtime bundle**

Run:

```bash
just rebuild-fem-runtime
```

Expected: exit zero and a refreshed runtime manifest. If compilation fails, capture the first upstream API incompatibility and repair only the minimal Fullmag compatibility surface; do not introduce solver optimizations in this task.

- [ ] **Step 5: Prove the exported versions**

Run through the managed container/runtime:

```bash
rg -n '#define MFEM_VERSION 40900' \
  .fullmag/runtimes/fem-gpu-host/include/mfem/config/_config.hpp
rg -n '#define HYPRE_RELEASE_NUMBER 30100' \
  .fullmag/runtimes/fem-gpu-host/include/HYPRE_config.h
```

Expected: one match for each exact macro. Also inspect the HYPRE 3.1.0 installed private header for the exact compute-stream accessor before Task 5; record its spelling in the plan if upstream renamed it.

- [ ] **Step 6: Run the no-solver-change qualification matrix**

Run individually:

```bash
just verify-fem-demag-poisson-contract
just verify-fem-time-domain-native-contract
just verify-fem-frequency-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-cpu-gpu-consistency-smoke
```

Expected: every command exits zero with unchanged Fullmag tolerances and policy. Failures caused by upstream default changes must be repaired by making the existing Fullmag policy explicit, not by loosening acceptance.

- [ ] **Step 7: Record the upgraded-stack baseline**

Run:

```bash
FULLMAG_BENCH_RELAX_ALGORITHMS=nonlinear_cg \
FULLMAG_BENCH_SCENARIOS=box500_airbox_exchange_demag \
FULLMAG_BENCH_DEMAG_SOLVERS=CG \
FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG \
FULLMAG_BENCH_DEMAG_RTOLS=1e-12 \
FULLMAG_BENCH_STEPS=32 \
just verify-fem-gpu-demag-performance-benchmark
```

Expected: a valid before-optimization CSV/JSON on the upgraded pair. Record total step, demag apply, solve count, iteration count, residual, energy, torque, and strict-residency counters.

- [ ] **Step 8: Commit the isolated dependency upgrade**

```bash
git add docker/fem-gpu/Dockerfile \
  docs/guides/mfem-host-parity-setup-ubuntu22.md \
  backends/fem/tests/source_facade_export_progress_contract.cpp justfile
git commit -m "build: upgrade FEM runtime to MFEM 4.9 and HYPRE 3.1"
```

Do not continue to solver optimization unless the managed build and qualification matrix establish that this dependency pair is production-executable.

### Task 1: Publish the numerical and runtime contract

**Files:**

- Modify: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
- Modify: `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
- Modify: `docs/physics/0560-all-in-gpu-fem-runtime.md`
- Test: `backends/fem/tests/interaction_docs_contract.cpp`

**Interfaces:**

- Consumes: approved design `docs/superpowers/specs/2026-07-20-fem-gpu-ncg-demag-optimization-design.md`.
- Produces: canonical prose used by all source-contract tests and runtime claims.

- [ ] **Step 1: Write failing documentation-contract assertions**

Add assertions requiring these exact contract phrases:

```cpp
check(
    relaxation_note.find("accepted endpoint token is consumed at most once") !=
        std::string::npos,
    "FEM GPU NCG docs must bound accepted endpoint reuse");
check(
    demag_policy.find("hypre_HandleComputeStream(hypre_handle())") !=
        std::string::npos,
    "GPU demag docs must name the exact pinned HYPRE stream accessor");
check(
    gpu_runtime.find("device-wide compatibility barrier is not strict GPU") !=
        std::string::npos,
    "strict GPU docs must reject a hidden global synchronization fallback");
```

- [ ] **Step 2: Verify the documentation contract fails**

Run:

```bash
just verify-fem-time-domain-native-contract
```

Expected: `fem_interaction_docs_contract` or the focused documentation assertion fails because the new phrases are absent.

- [ ] **Step 3: Update the three canonical notes**

Document, with equations and SI units preserved:

```text
For accepted NCG endpoint m_{k+1}, the already evaluated tuple
(m_{k+1}, H_demag(m_{k+1}), H_eff(m_{k+1}), E(m_{k+1})) may seed exactly
one next-step current evaluation when state, drive, material, interaction,
solver, tolerance, refinement and residency signatures match. A new trial
state always performs a fresh zero-initial demag solve.

The strict CUDA bridge records Fullmag-ready on the Fullmag compute stream,
makes hypre_HandleComputeStream(hypre_handle()) wait, records HYPRE-done on
that exact stream, then makes Fullmag wait. A device-wide compatibility
barrier is not strict GPU.
```

Also correct the stale statement that the existing default-stream event bridge already proves this ordering.

- [ ] **Step 4: Verify the documentation contract passes**

Run `just verify-fem-time-domain-native-contract`.

Expected: the documentation/source contract target passes; any unrelated managed failure is recorded separately and investigated before continuing.

- [ ] **Step 5: Commit the publication update**

```bash
git add docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md \
  docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md \
  docs/physics/0560-all-in-gpu-fem-runtime.md \
  backends/fem/tests/interaction_docs_contract.cpp
git commit -m "docs: define FEM GPU solver reuse contract"
```

### Task 2: Share the canonical CUDA direct-energy increment

**Files:**

- Create: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.hpp`
- Create: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Test: `backends/fem/tests/relaxation_source_contract.cpp`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**

- Consumes: `relaxation::EnergyDifference`, `GpuFinalScalarSlot`, existing CUDA energy-difference and reduction kernels.
- Produces:

```cpp
struct GpuDirectEnergySnapshot {
    double total_energy_j = 0.0;
    std::array<double, kGpuFinalScalarSlots> terms_j{};
};

struct GpuDirectArmijoResult {
    relaxation::EnergyDifference difference{};
    relaxation::ArmijoDifferenceDecision decision =
        relaxation::ArmijoDifferenceDecision::Reject;
    bool refinement_attempted = false;
    bool refinement_accepted = false;
};

bool gpu_direct_energy_snapshot(
    Context &, cudaStream_t, int node_count, int block_count,
    GpuDirectEnergySnapshot &, std::string &);
bool gpu_direct_armijo_evaluate(
    Context &, cudaStream_t, int node_count, int block_count,
    const FemGpuComponentField &base_m,
    const FemGpuComponentField &base_h_demag,
    const GpuDirectEnergySnapshot &base,
    double armijo_rhs_j,
    GpuDirectArmijoResult &, std::string &);
```

- [ ] **Step 1: Write failing source-contract tests**

Require the new owner, require both PG-BB and NCG to call `gpu_direct_armijo_evaluate`, and forbid either algorithm from reimplementing `fullmag_cuda_relax_direct_energy_difference_blocks` after extraction.

```cpp
check(
    direct_increment.find("gpu_direct_armijo_evaluate(") != std::string::npos,
    "GPU direct minimizers need one direct Armijo evaluator");
check(
    projected_gradient.find("gpu_direct_armijo_evaluate(") != std::string::npos,
    "PG-BB must use shared direct Armijo evaluation");
check(
    nonlinear_cg.find("gpu_direct_armijo_evaluate(") != std::string::npos,
    "NCG must use shared direct Armijo evaluation");
```

- [ ] **Step 2: Verify RED through the managed source gate**

Run `just verify-fem-relaxation-source-contract`.

Expected: failure naming missing `direct_energy_increment` and missing NCG shared evaluator call.

- [ ] **Step 3: Implement the focused shared owner**

Move, without changing numerical formulas, the existing PG-BB logic for:

```cpp
fullmag_cuda_relax_direct_energy_difference_blocks(...);
fullmag_cuda_legacy_sparse_exchange_difference_blocks(...);
fullmag_cuda_dmi_energy_difference(...);
relaxation::strict_armijo_difference_decision(...);
```

The implementation must copy the base `H_demag` only into caller-provided persistent scratch, use the current canonical trial fields, and repeat both fresh current and fresh trial solves only in the bounded refinement branch. Return `false` on any incomplete refinement; never accept the ordinary value after refinement failure.

- [ ] **Step 4: Replace PG-BB duplication with the shared API**

Keep PG-BB trial creation, rollback, BB curvature, and recovery policy in `pgbb.cpp`. Replace only its snapshot and direct Armijo body:

```cpp
GpuDirectEnergySnapshot current_snapshot{};
if (!gpu_direct_energy_snapshot(
        ctx, stream, n, blocks, current_snapshot, reason) ||
    !gpu_rk_copy_component_device(
        gpu.fields.h_demag, gpu.rk.error, gpu.lifecycle.node_count, stream,
        "backup current H_demag", reason)) {
    return fail_and_restore(...);
}

GpuDirectArmijoResult armijo{};
if (!gpu_direct_armijo_evaluate(
        ctx, stream, n, blocks, gpu.rk.m_backup, gpu.rk.error,
        current_snapshot, armijo_rhs, armijo, reason)) {
    return fail_and_restore(...);
}
```

- [ ] **Step 5: Run focused green tests**

Run:

```bash
just verify-fem-relaxation-source-contract
just verify-fem-time-domain-native-contract
```

Expected: both exit zero, and existing PG-BB direct-increment/refinement assertions remain green.

- [ ] **Step 6: Commit the shared evaluator**

```bash
git add backends/fem/CMakeLists.txt \
  backends/fem/gpu/cuda/relaxation/direct_energy_increment.hpp \
  backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp \
  backends/fem/gpu/cuda/relaxation/pgbb.cpp \
  backends/fem/tests/relaxation_source_contract.cpp \
  backends/fem/tests/relaxation_energy_derivative_contract.cpp
git commit -m "refactor: share FEM GPU direct Armijo increments"
```

### Task 3: Repair NCG Armijo and publish a one-shot endpoint token

**Files:**

- Modify: `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`
- Modify: `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp`
- Modify: `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp`
- Modify: `backends/fem/gpu/cuda/state/gpu_state.cpp`
- Test: `backends/fem/tests/relaxation_source_contract.cpp`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**

- Consumes: Task 2 `GpuDirectEnergySnapshot` and `gpu_direct_armijo_evaluate`.
- Produces:

```cpp
struct FemGpuAcceptedEvaluationToken {
    bool valid = false;
    uint64_t accepted_step = 0;
    uint64_t state_generation = 0;
    uint64_t configuration_signature = 0;
    uint64_t solver_signature = 0;
    double total_energy_j = 0.0;
    uint64_t hits = 0;
    uint64_t misses = 0;
    uint64_t invalidations = 0;
};

void gpu_relax_invalidate_accepted_evaluation(
    FemGpuRelaxationDeviceState &state) noexcept;
```

- [ ] **Step 1: Write failing NCG contract tests**

Require:

```cpp
check(ncg.find("gpu_direct_armijo_evaluate(") != std::string::npos,
      "NCG uses canonical direct Armijo increments");
check(ncg.find("consume_ncg_accepted_evaluation(") != std::string::npos,
      "NCG consumes accepted evaluation once");
check(ncg.find("backtracks + 1u + current_evaluation_count") !=
          std::string::npos,
      "NCG RHS accounting reflects endpoint reuse");
```

Add pure signature/consumption tests demonstrating exact hit, one-shot second miss, solver mismatch, accepted-step mismatch, and explicit invalidation.

- [ ] **Step 2: Verify RED**

Run `just verify-fem-relaxation-source-contract`.

Expected: failure naming missing token and canonical NCG evaluator.

- [ ] **Step 3: Add bounded token state and invalidation**

Use scalar metadata only; do not allocate field payloads. Increment `state_generation` on magnetization/effective-field upload and reset. Compute the configuration and solver signatures from canonical enum/scalar values with an explicit deterministic combiner:

```cpp
inline uint64_t mix_signature(uint64_t seed, uint64_t value) noexcept
{
    return seed ^ (value + 0x9e3779b97f4a7c15ULL + (seed << 6) + (seed >> 2));
}
```

The signature must cover demag mode, linear solver, preconditioner, exact bit patterns of tolerances, maximum iterations, material/interaction enablement, and applied-field configuration. It must not hash pointer addresses.

- [ ] **Step 4: Consume a valid endpoint before current demag evaluation**

Refactor the current-evaluation helper to accept `bool evaluate_fields`:

```cpp
const bool reused_current = consume_ncg_accepted_evaluation(ctx, current_energy);
const uint32_t current_evaluation_count = reused_current ? 0u : 1u;
if (!gpu_relax_compute_energy_gradient_and_direction(
        ctx, stream, n, blocks, gpu.rk.k[0],
        !reused_current, current_energy, gradient_norm_sq,
        gradient_energy_norm_sq, p_dot_g, direction_norm_sq, reason)) {
    return restore(...);
}
```

When `evaluate_fields == false`, form the tangent gradient and direction metrics from the existing canonical `m` and `H_eff` only; do not rerun energy reductions or demag.

- [ ] **Step 5: Replace endpoint-total Armijo with direct increments**

Snapshot base terms and base `H_demag`, then call Task 2 for every trial. The Armijo RHS is the increment quantity:

```cpp
const double armijo_rhs_j =
    kArmijoCoefficient * trial_step * p_dot_g;
GpuDirectArmijoResult decision{};
if (!gpu_direct_armijo_evaluate(
        ctx, stream, n, blocks, gpu.rk.m_backup, gpu.rk.error,
        current_snapshot, armijo_rhs_j, decision, reason)) {
    return restore(...);
}
line_search_accepted =
    decision.decision == relaxation::ArmijoDifferenceDecision::Accept ||
    decision.refinement_accepted;
```

Apply the same evaluator to the recovery line search; no endpoint-total or monotone bypass remains.

- [ ] **Step 6: Publish the token only after successful accepted-state finalization**

```cpp
publish_ncg_accepted_evaluation(
    ctx,
    accepted_step,
    trial_energy,
    configuration_signature(ctx),
    solver_signature(ctx));
out_stats.rhs_evaluations =
    backtracks + 1u + current_evaluation_count;
```

Rollback restores the prior token metadata. Any failed evaluation, rejected terminal line search, state upload, snapshot overwrite, or stage reset invalidates it.

- [ ] **Step 7: Run managed focused gates**

Run:

```bash
just verify-fem-relaxation-source-contract
just verify-fem-time-domain-native-contract
```

Expected: exit zero, NCG source contract uses direct increments, and solve accounting is structurally `2, 1, 1, ...` for no-backtrack accepted steps.

- [ ] **Step 8: Commit NCG correctness and reuse**

```bash
git add backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp \
  backends/fem/gpu/cuda/relaxation/relaxation_state.hpp \
  backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp \
  backends/fem/gpu/cuda/state/gpu_state.cpp \
  backends/fem/tests/relaxation_source_contract.cpp \
  backends/fem/tests/relaxation_energy_derivative_contract.cpp
git commit -m "perf: reuse accepted FEM GPU NCG evaluations"
```

### Task 4: Set up HYPRE and AMG once per compatible workspace

**Files:**

- Modify: `backends/fem/gpu/cuda/demag_poisson/operators.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp`
- Test: `backends/fem/tests/demag_poisson_contract.cpp`
- Test: `backends/fem/tests/cuda_periodic_demag_contract.cpp`

**Interfaces:**

- Consumes: invariant `A_par`, `b_par`, `x_par`, solver and preconditioner in `GpuDemagPoissonWorkspace`.
- Produces:

```cpp
struct GpuDemagPoissonWorkspace {
    // existing members
    uint64_t solver_signature = 0;
    uint64_t setup_count = 0;
    uint64_t fresh_zero_guess_count = 0;
    uint64_t warm_start_count = 0;
    bool solver_setup_complete = false;
};

bool setup_demag_poisson_hypre_device_solver(
    Context &, GpuDemagPoissonWorkspace &, std::string &);
bool prepare_demag_poisson_hypre_device_solver_apply(
    const Context &, GpuDemagPoissonWorkspace &, bool fresh_zero,
    std::string &);
```

- [ ] **Step 1: Write failing setup-reuse tests**

Require initialization order `b_par/x_par -> Setup`, forbid `solver.reset()` and `preconditioner.reset()` from the fresh-RHS function, and assert setup counters:

```cpp
check(hypre_solver.find("solver->Setup(*workspace.b_par, *workspace.x_par)") !=
          std::string::npos,
      "GPU demag initializes HYPRE setup once after vectors exist");
check(fresh_rhs_body.find("solver.reset()") == std::string::npos,
      "fresh RHS must preserve solver setup");
check(fresh_rhs_body.find("preconditioner.reset()") == std::string::npos,
      "fresh RHS must preserve AMG hierarchy");
```

- [ ] **Step 2: Verify RED**

Run `just verify-fem-demag-poisson-contract`.

Expected: failure because the current fresh-RHS path resets both objects.

- [ ] **Step 3: Move explicit setup to initialization**

After vectors exist, call the MFEM solver setup exactly once and time it:

```cpp
const auto setup_start = FemSteadyClock::now();
workspace.solver->Setup(*workspace.b_par, *workspace.x_par);
workspace.solver_setup_complete = true;
workspace.setup_count += 1u;
ctx.poisson_demag.last_setup_wall_time_ns = elapsed_ns(setup_start);
ctx.poisson_demag.last_solver_setup_reused = false;
```

If explicit `Setup` is unavailable for one supported solver wrapper, use its documented HYPRE setup call through the existing typed wrapper; do not force a dummy `Mult`.

- [ ] **Step 4: Make fresh RHS reset only the solution iterate**

```cpp
if (fresh_zero) {
    cudaMemsetAsync(solution, 0, bytes, fullmag_stream);
    workspace.x_par->HypreWrite();
    solver->SetZeroInitialIterate();
    workspace.fresh_zero_guess_count += 1u;
} else {
    workspace.x_par->HypreReadWrite();
    solver->iterative_mode = true;
    workspace.warm_start_count += 1u;
}
```

Reject a solver-signature mismatch instead of silently rebuilding inside the hot loop. Lifecycle code may explicitly reconstruct one compatible workspace.

- [ ] **Step 5: Publish truthful setup timing**

On every apply after initialization:

```cpp
ctx.poisson_demag.last_setup_wall_time_ns = 0;
ctx.poisson_demag.last_solver_setup_reused =
    workspace.solver_setup_complete && workspace.setup_count == 1u;
```

Do not hardcode reuse before verifying the workspace state.

- [ ] **Step 6: Run focused green gates**

Run:

```bash
just verify-fem-demag-poisson-contract
just verify-fem-frequency-domain-native-contract
```

Expected: exit zero; demag and frequency-domain users share the persistent workspace without setup regression.

- [ ] **Step 7: Commit persistent setup**

```bash
git add backends/fem/gpu/cuda/demag_poisson/operators.hpp \
  backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.hpp \
  backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp \
  backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp \
  backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp \
  backends/fem/tests/demag_poisson_contract.cpp \
  backends/fem/tests/cuda_periodic_demag_contract.cpp
git commit -m "perf: preserve FEM GPU demag AMG setup"
```

### Task 5: Replace the global barrier with exact HYPRE-stream interop

**Files:**

- Create: `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp`
- Create: `backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/gpu/cuda/demag_poisson/operators.hpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/operators.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
- Test: `backends/fem/tests/cuda_demag_timing_contract.cpp`
- Test: `backends/fem/tests/source_facade_gpu_rk_contract.cpp`
- Test: `backends/fem/tests/cuda_periodic_demag_contract.cpp`

**Interfaces:**

- Consumes: upgraded `HYPRE_RELEASE_NUMBER == 30100`, `MFEM_VERSION == 40900`, the exact HYPRE 3.1.0 compute-stream accessor verified in Task 0, and workspace CUDA events.
- Produces:

```cpp
struct HypreStreamInterop {
    cudaStream_t hypre_stream = nullptr; // borrowed
    cudaEvent_t fullmag_ready = nullptr;
    cudaEvent_t hypre_done = nullptr;
    uint64_t event_wait_count = 0;
    uint64_t global_sync_count = 0;
    bool ready = false;
};

bool initialize_hypre_stream_interop(HypreStreamInterop &, std::string &);
bool hypre_wait_for_fullmag(
    HypreStreamInterop &, cudaStream_t fullmag_stream, std::string &);
bool fullmag_wait_for_hypre(
    HypreStreamInterop &, cudaStream_t fullmag_stream, std::string &);
void destroy_hypre_stream_interop(HypreStreamInterop &) noexcept;
```

- [ ] **Step 1: Replace contradictory tests with one failing canonical contract**

Remove the assertion requiring `Mult -> cudaDeviceSynchronize -> recovery`. Require:

```cpp
check(stage.find("cudaDeviceSynchronize()") == std::string::npos,
      "strict GPU demag cannot use a device-wide barrier");
check(stage.find("hypre_wait_for_fullmag(") < stage.find("solver->Mult("),
      "HYPRE waits for Fullmag producer");
check(stage.find("fullmag_wait_for_hypre(") > stage.find("solver->Mult("),
      "Fullmag consumer waits for exact HYPRE stream");
```

- [ ] **Step 2: Verify RED**

Run `just verify-fem-time-domain-native-contract`.

Expected: current raw `cudaDeviceSynchronize()` and default-stream event usage fail the canonical test.

- [ ] **Step 3: Implement the version-pinned adapter**

The implementation includes HYPRE private utilities only inside this translation unit:

```cpp
#include <HYPRE_config.h>
#include <mfem/config/_config.hpp>
#include <_hypre_utilities.h>

#if MFEM_VERSION != 40900
#error "FEM GPU HYPRE stream interop requires MFEM 4.9.0"
#endif

static_assert(
    HYPRE_RELEASE_NUMBER == 30100,
    "FEM GPU HYPRE stream interop requires HYPRE 3.1.0");

interop.hypre_stream = hypre_HandleComputeStream(hypre_handle());
if (interop.hypre_stream == nullptr) {
    error = "strict FEM GPU demag could not borrow the HYPRE compute stream";
    return false;
}
```

Use the HYPRE 3.1.0 `HYPRE_RELEASE_NUMBER == 30100` macro proven by Task 0; do not compare version strings at runtime.

- [ ] **Step 4: Implement exact event ordering**

```cpp
cudaEventRecord(interop.fullmag_ready, fullmag_stream);
cudaStreamWaitEvent(interop.hypre_stream, interop.fullmag_ready, 0);
// solver->Mult executes here
cudaEventRecord(interop.hypre_done, interop.hypre_stream);
cudaStreamWaitEvent(fullmag_stream, interop.hypre_done, 0);
interop.event_wait_count += 2u;
```

No `cudaDeviceSynchronize`, `cudaStreamSynchronize`, or NULL-stream wait is allowed in the strict solve path. Validation/stat reads that synchronously enter HYPRE must occur only after the exact HYPRE-done event has been established.

- [ ] **Step 5: Add a runtime non-global-barrier proof**

In the CUDA-enabled periodic-demag fixture, launch a long independent kernel/event on a separate nonblocking stream, run the demag dependency bridge, and assert the independent event is not forced complete by the bridge. Separately assert producer/consumer sentinels have the expected values after their explicit stream dependency.

- [ ] **Step 6: Run focused managed gates**

Run:

```bash
just verify-fem-time-domain-native-contract
just verify-fem-demag-poisson-contract
```

Expected: exit zero; source contract has no strict raw global barrier and CUDA integration proves ordered data without globally completing independent work.

- [ ] **Step 7: Commit stream interop**

```bash
git add backends/fem/CMakeLists.txt \
  backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.hpp \
  backends/fem/gpu/cuda/demag_poisson/hypre_stream_interop.cpp \
  backends/fem/gpu/cuda/demag_poisson/operators.hpp \
  backends/fem/gpu/cuda/demag_poisson/operators.cpp \
  backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp \
  backends/fem/tests/cuda_demag_timing_contract.cpp \
  backends/fem/tests/source_facade_gpu_rk_contract.cpp \
  backends/fem/tests/cuda_periodic_demag_contract.cpp
git commit -m "perf: order FEM demag on the exact HYPRE stream"
```

### Task 6: Make profiler and benchmark acceptance truthful

**Files:**

- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp`
- Modify: `backends/fem/tests/cuda_demag_timing_contract.cpp`
- Modify: `backends/fem/tests/demag_poisson_contract.cpp`
- Modify: `scripts/analysis/fem_gpu_benchmark.py`
- Modify: `justfile`

**Interfaces:**

- Consumes: Tasks 3-5 counters.
- Produces: managed benchmark failures for repeated NCG solve, repeated setup, or global strict-GPU sync.

- [ ] **Step 1: Write failing telemetry/validator tests**

Add benchmark unit fixtures with rows representing:

```python
good = {
    "algorithm": "nonlinear_cg",
    "step": 2,
    "demag_solves": 1,
    "demag_setup_count": 0,
    "demag_fresh_zero_guess_count": 1,
    "gpu_global_sync_count": 0,
    "accepted_evaluation_cache_hits": 1,
}
```

Require rejection when `demag_solves != 1` after step one, setup count is positive in the steady window, or global sync count is positive in strict GPU mode.

- [ ] **Step 2: Verify RED**

Add the cases to `scripts/test_validate_fem_relaxation_runtime_log.py` and run:

```bash
python3 -m pytest -q scripts/test_validate_fem_relaxation_runtime_log.py
```

Expected: missing fields/assertions fail.

- [ ] **Step 3: Wire bounded counters into the existing profiler path**

Reset per-step counters at the same lifecycle boundary as `step_solver_apply_wall_time_ns`. Increment counters only at actual setup, fresh zero, token hit/miss, event wait, and audited global synchronization sites. Keep cumulative diagnostics bounded scalars; do not append samples outside the existing profiler ring.

- [ ] **Step 4: Add benchmark acceptance switches**

Add explicit options with production recipe defaults:

```python
parser.add_argument("--require-ncg-accepted-endpoint-reuse", action="store_true")
parser.add_argument("--require-demag-single-setup", action="store_true")
parser.add_argument("--require-zero-strict-gpu-global-sync", action="store_true")
```

Update `verify-fem-relaxation-production-benchmark` and `verify-fem-gpu-demag-performance-benchmark` to pass the switches for GPU NCG rows. Do not apply the NCG solve-count rule to RK or PG-BB.

- [ ] **Step 5: Run focused green tests**

Run the Python validator test and:

```bash
just verify-fem-time-domain-native-contract
just verify-fem-demag-poisson-contract
```

Expected: all exit zero with truthful counters and no hardcoded setup-reuse value.

- [ ] **Step 6: Commit telemetry and gates**

```bash
git add backends/fem/cpu/mfem/interactions/demag_poisson_runtime.hpp \
  backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp \
  backends/fem/tests/cuda_demag_timing_contract.cpp \
  backends/fem/tests/demag_poisson_contract.cpp \
  scripts/analysis/fem_gpu_benchmark.py justfile
git commit -m "test: enforce FEM GPU demag reuse telemetry"
```

### Task 7: Rebuild, qualify, and measure the production path

**Files:**

- Verify only: repository-managed runtime and `.fullmag/reports/` artifacts.
- Modify only on a demonstrated test defect: files already named in Tasks 1-6.

**Interfaces:**

- Consumes: complete implementation and managed recipes.
- Produces: fresh build, numerical/runtime evidence, before/after performance table, and honest remaining qualification status.

- [ ] **Step 1: Check scope before the final build**

Run:

```bash
git status --short
git diff --check
git diff --name-only HEAD~5..HEAD
```

Expected: only plan-owned files differ; user-owned SP4 scenario and submodule are absent in the isolated worktree diff.

- [ ] **Step 2: Rebuild the managed FEM runtime**

Run `just rebuild-fem-runtime`.

Expected: explicit exit zero and a fresh valid FEM GPU runtime bundle. A cached/progress log without final exit zero is not proof.

- [ ] **Step 3: Run native correctness gates**

Run, individually and retain exit codes:

```bash
just verify-fem-demag-poisson-contract
just verify-fem-time-domain-native-contract
just verify-fem-frequency-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
just verify-fem-relaxation-cpu-gpu-consistency-smoke
```

Expected: every command exits zero. Fix production defects, not acceptance thresholds.

- [ ] **Step 4: Run the controlled NCG performance benchmark**

Use the same workload shape as the supplied profile and production tolerance:

```bash
FULLMAG_BENCH_RELAX_ALGORITHMS=nonlinear_cg \
FULLMAG_BENCH_SCENARIOS=box500_airbox_exchange_demag \
FULLMAG_BENCH_DEMAG_SOLVERS=CG \
FULLMAG_BENCH_DEMAG_PRECONDITIONERS=AMG \
FULLMAG_BENCH_DEMAG_RTOLS=1e-12 \
FULLMAG_BENCH_STEPS=32 \
just verify-fem-gpu-demag-performance-benchmark
```

Expected: after the first accepted step, no-backtrack rows report one demag solve, no steady setup, one token hit, zero global strict sync, converged residual at the unchanged tolerance, and consistent energy/torque.

- [ ] **Step 5: Run the production matrix benchmark**

Run:

```bash
FULLMAG_BENCH_RELAX_ALGORITHMS=nonlinear_cg \
FULLMAG_BENCH_STEPS=32 \
just verify-fem-relaxation-production-benchmark
```

Expected: CG/AMG and declared comparison policies pass their existing correctness limits; median steady NCG step time improves by at least 1.5x versus the recorded 704.2 ms baseline on the same device/workload. If workload equivalence cannot be established, report the measurement as a new baseline, not a speedup claim.

- [ ] **Step 6: Inspect runtime evidence**

Read the generated CSV/JSON rather than relying on recipe exit alone. Record:

```text
median total step ms
median demag solve/apply ms
demag solves per accepted step
Krylov iterations per solve
AMG setup count and time
endpoint token hits/misses
event waits and global sync count
energy/torque parity and stop reason
```

- [ ] **Step 7: Run final diff and scope verification**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: clean implementation branch, scoped commits, no untracked generated artifacts intended for source control.

- [ ] **Step 8: Finish through branch-completion workflow**

Invoke `finishing-a-development-branch`, present integration choices, and do not merge/push without the user's choice. The handoff must distinguish `implemented`, `production_executable`, measured performance, and incomplete NIST SP4 qualification.
