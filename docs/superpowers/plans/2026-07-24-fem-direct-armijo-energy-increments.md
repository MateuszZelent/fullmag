# FEM Direct Armijo Energy Increments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct FEM CPU/GPU PG-BB energy-difference cancellation without loosening strict Armijo, while retaining the canonical four-control-sync GPU budget and completing Task 8's identity-pinned production matrix.

**Architecture:** Introduce a backend-neutral term-composition contract that accepts explicit endpoint-residual operands and direct discrete increments. Add a focused CPU/MFEM polarized exchange owner and make CUDA classify every energy slot exactly once in the existing direct Armijo batch. Validate each layer independently, then rebuild one final managed runtime and run identity-pinned focused A/B plus the exact five-repeat production gate.

**Tech Stack:** C++17, MFEM 4.9, HYPRE 3.1.0, CUDA/Thrust, repository-managed Docker/`just`, Python benchmark validators.

## Global Constraints

- Preserve the strict Armijo inequality, `c1`, BB1/BB2, restart, fresh-zero demag, rollback, physical tolerances, energy monotonicity, ABI, and profiler semantics.
- Never accept a resolved uphill increment; unresolved ambiguity refines through an existing qualified owner or fails closed as non-converged after rollback.
- Every enabled energy term is classified exactly once as `direct`, `endpoint_residual`, or `unsupported`; no omission or double counting.
- CPU and GPU use the same signs, SI-joule convention, and discrete energy objective.
- Add no physics or cross-cutting state to `Context`, `mfem_bridge.cpp`, Rust orchestration, Python DSL, ProblemIR, OpenAPI, or UI.
- Add no baseline GPU host synchronization; PG-BB remains `initial_syncs + 4 * executed_steps + max(0, total_rhs_evals - 2 * executed_steps)`.
- Do not modify or silently replace accepted fixtures, mesh signatures, tolerances, or baselines to make a gate green.
- Native FEM/MFEM/CUDA verification uses the container-backed repository `just` recipes as authoritative evidence.
- Preserve `.superpowers/sdd/progress.md` as an unstaged local ledger; inspect `git diff --cached --name-only` separately before every commit.

---

### Task 1: Make endpoint-residual uncertainty explicit

**Files:**

- Modify: `backends/fem/src/relaxation_numerics.hpp`
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp`

**Interfaces:**

- Consumes: `EnergyDifference`, `strict_armijo_difference_decision`.
- Produces:

```cpp
EnergyDifference compose_term_complete_energy_difference(
    double endpoint_residual_delta_joules,
    double endpoint_residual_operand_absolute_sum_joules,
    double direct_delta_joules,
    double direct_absolute_term_sum_joules,
    std::size_t scalar_term_count);
```

- The second argument is the sum of absolute base/trial operands used to form residual endpoint differences. It is never `abs(endpoint_residual_delta_joules)`.
- Task 1 adds this new, explicitly named helper without changing the semantics of the existing `compose_direct_energy_difference` caller. Task 3 migrates the production CUDA caller and deletes the old helper atomically, preventing a same-signature semantic transition from compiling with misordered values.

- [ ] **Step 1: Add RED tests for catastrophic cancellation and strict uphill rejection**

Add a manufactured test with the retained failure scale:

```cpp
const double endpoint_total = -2.0e-17;
const double exchange_direct = -2.1037518401e-39;
const double zeeman_direct = 7.9035597018e-49;
const auto difference = compose_term_complete_energy_difference(
    0.0,
    0.0,
    exchange_direct + zeeman_direct,
    std::abs(exchange_direct) + std::abs(zeeman_direct),
    96u);
check(difference.delta_joules < -2.103751e-39,
      "term-complete composition must retain the descending exchange increment");
check(strict_armijo_difference_decision(difference, -6.0314e-43) ==
          ArmijoDifferenceDecision::Accept,
      "retained GPU Zeeman failure components must satisfy strict Armijo");

const auto residual = compose_term_complete_energy_difference(
    0.0,
    2.0 * std::abs(endpoint_total),
    7.9035597018e-49,
    std::abs(7.9035597018e-49),
    96u);
check(residual.roundoff_bound_joules > 1.0e-33,
      "endpoint residual bound must retain endpoint operand scale");

const EnergyDifference uphill{1.0e-34, 1.0e-34, 0.0};
check(strict_armijo_difference_decision(uphill, -5.0e-35) ==
          ArmijoDifferenceDecision::Reject,
      "resolved uphill increments remain rejected");
```

- [ ] **Step 2: Run managed RED**

Run:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

Expected: failure in the new endpoint-operand-scale contract because the old helper replaces the scale with `abs(residual_delta_joules)`.

- [ ] **Step 3: Replace the helper contract**

Implement:

```cpp
inline EnergyDifference compose_term_complete_energy_difference(
    double endpoint_residual_delta_joules,
    double endpoint_residual_operand_absolute_sum_joules,
    double direct_delta_joules,
    double direct_absolute_term_sum_joules,
    std::size_t scalar_term_count)
{
    const double absolute_term_sum_joules =
        endpoint_residual_operand_absolute_sum_joules +
        direct_absolute_term_sum_joules;
    return {
        endpoint_residual_delta_joules + direct_delta_joules,
        absolute_term_sum_joules,
        reduction_roundoff_bound(scalar_term_count) *
            absolute_term_sum_joules,
    };
}
```

Preserve the old `compose_direct_energy_difference` unchanged until its only production caller migrates in Task 3. Preserve fail-closed handling in `strict_armijo_difference_decision`; do not clamp, floor, or convert ambiguity to acceptance.

- [ ] **Step 4: Update all test callers to the new semantics and run GREEN**

Every caller must pass actual residual operand magnitudes. Add a source test that rejects `std::abs(residual_delta_joules)` as the second operand inside the helper.

Run the managed source contract again. Expected: exit 0 and the complete relaxation energy-derivative matrix passes.

- [ ] **Step 5: Commit**

Stage only the three Task 1 files, inspect cached names separately, and commit:

```bash
git commit -m "fix: preserve FEM Armijo residual uncertainty"
```

---

### Task 2: Add the CPU/MFEM polarized exchange increment owner

**Files:**

- Create: `backends/fem/cpu/mfem/interactions/exchange_energy_difference.hpp`
- Create: `backends/fem/cpu/mfem/interactions/exchange_energy_difference.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Modify: `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp`

**Interfaces:**

- Consumes: the already assembled symmetric `ctx.exchange.mfem.exchange_form`, current/trial AoS nodal magnetization, MFEM audited host/device access.
- Produces:

```cpp
relaxation::EnergyDifference exchange_energy_difference(
    Context &ctx,
    const std::vector<double> &base_m_xyz,
    const std::vector<double> &trial_m_xyz,
    bool allow_interrupt,
    std::string &error);
```

- [ ] **Step 1: Add a RED long-double oracle**

Use a small symmetric matrix and near-nullspace vectors. The oracle evaluates
`sum_i (trial_i-base_i) * (K*(trial+base))_i` in `long double`, plus the componentwise absolute sum. Require the production owner to match the oracle and separately require agreement with endpoint `m^T K m` subtraction at a resolvable scale.

Also add a case where endpoint binary64 energies compare equal but the polarized oracle is negative; the direct owner must retain that negative value.

- [ ] **Step 2: Run managed RED**

Run the source contract. Expected: missing header/function/source ownership and failing CPU direct-exchange test.

- [ ] **Step 3: Implement the focused MFEM owner**

For each component, form MFEM vectors `difference = trial - base` and `sum = trial + base`, apply `exchange_form.Mult(sum, applied)`, then accumulate:

```cpp
double delta = 0.0;
double absolute_terms = 0.0;
for (int i = 0; i < difference.Size(); ++i) {
    const double term = difference_host[i] * applied_host[i];
    delta += term;
    absolute_terms += std::abs(term);
}
```

Use `audited_host_write/read`, `mfem::Device::IsEnabled()`, interrupt polling, exact size/finite checks, and one `TransferAuditScope` owned by exchange interop. Return:

```cpp
return {
    delta,
    absolute_terms,
    relaxation::reduction_roundoff_bound(3u * node_count) * absolute_terms,
};
```

Do not mass-project to `H_ex`: the energy identity consumes the symmetric exchange bilinear form directly.

- [ ] **Step 4: Integrate CPU PG-BB without changing line-search policy**

Call `exchange_energy_difference(...)` in `pgbb_direct_energy_difference`. Remove exchange endpoint subtraction from `residual`. Build the remaining endpoint residual term-by-term:

```cpp
const auto add_residual = [&](double base, double trial) {
    residual_delta += trial - base;
    residual_operand_abs += std::abs(base) + std::abs(trial);
};
```

Use direct demag, Zeeman, uniaxial, and exchange increments once each. Keep DMI, magnetoelastic, and cubic-anisotropy endpoint residuals until they receive qualified direct owners. Sum each owner's own roundoff bound plus the residual bound; do not replace those independent bounds with `abs(total_delta)`.

- [ ] **Step 5: Run focused and managed GREEN**

Run the managed source contract and a one-repeat managed CPU PG-BB reproduction for exchange-only and exchange-plus-uniaxial using the exact existing fixture. Require no false convergence and no accepted resolved uphill step. If the aliased fixture still reaches honest numerical stagnation, retain it as non-converged and record that result; do not add a gradient floor.

- [ ] **Step 6: Commit**

Stage only Task 2 files and commit:

```bash
git commit -m "fix: evaluate FEM CPU exchange Armijo increments directly"
```

---

### Task 3: Make CUDA direct energy composition term-complete

**Files:**

- Modify: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.hpp`
- Modify: `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp`
- Modify: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` only if implementation reveals a contract clarification

**Interfaces:**

- Consumes: `GpuDirectEnergySnapshot::terms_j`, existing direct exchange/local/DMI/demag reductions, `GpuFinalScalarSlot`.
- Produces an internal exhaustive classification:

```cpp
enum class GpuEnergyIncrementOwner : uint8_t {
    NotEnergy,
    Direct,
    EndpointResidual,
    Unsupported,
};

GpuEnergyIncrementOwner gpu_energy_increment_owner(
    const Context &ctx,
    GpuFinalScalarSlot slot);
```

- [ ] **Step 1: Add RED exhaustive-classification tests**

Require every enum value from `ExchangeEnergy` through `MagnetoelasticEnergy` to have exactly one owner for each representative interaction configuration. Observable slots (`MaxHEff` onward and `MaxRhs`) must be `NotEnergy`. A newly added energy slot without classification must fail the source/runtime contract.

Add the retained GPU Zeeman numbers and require the composed result to equal the sum of direct exchange plus direct local/Zeeman increments rather than the cancelled endpoint total.

- [ ] **Step 2: Run managed RED**

Expected: no exhaustive owner and old `endpoint_replaced_delta` composition still present.

- [ ] **Step 3: Implement exhaustive slot ownership**

Classify enabled terms according to existing qualified kernels:

- `ExchangeEnergy`: `Direct`;
- `DemagEnergy`: `Direct` when enabled, otherwise excluded;
- `ExternalEnergy`, `DriveEnergy`, `AnisotropyEnergy`: `Direct` when enabled by the existing local direct-difference kernel;
- `DmiEnergy`, `BulkDmiEnergy`: `Direct` when enabled;
- `CubicAnisotropyEnergy` and `MagnetoelasticEnergy`: `EndpointResidual` only when enabled and not already included by a direct owner;
- `DemagRobinBoundaryEnergy`: `NotEnergy` for Armijo composition. Robin is already part of the demag operator/endpoint field and adding this diagnostic scalar would double-count the variational boundary form. Tests require zero Armijo ownership regardless of the diagnostic slot value;
- disabled energy terms: excluded with a tested zero value;
- unknown enabled energy semantics: `Unsupported`, fail closed with the slot name.

Do not infer enablement from a nonzero scalar. Use `Context` capability state.

- [ ] **Step 4: Replace endpoint-total reconstruction**

Delete `trial.total_energy_j - base.total_energy_j` and `endpoint_replaced_delta` from the decision path. Iterate classified energy slots:

```cpp
double residual_delta = 0.0;
double residual_operand_abs = 0.0;
for (const auto slot : endpoint_residual_slots) {
    const double base_term = base.terms_j[index(slot)];
    const double trial_term = trial.terms_j[index(slot)];
    residual_delta += trial_term - base_term;
    residual_operand_abs += std::abs(base_term) + std::abs(trial_term);
}
difference = relaxation::compose_term_complete_energy_difference(
    residual_delta,
    residual_operand_abs,
    direct_delta,
    direct_absolute,
    scalar_term_count);
```

Keep `trial_snapshot.total_energy_j` for published observables only. It must not determine Armijo acceptance. In the same change, delete the now-unused legacy `compose_direct_energy_difference`; no stale cancellation-prone helper remains after Task 3.

- [ ] **Step 5: Preserve refinement and diagnostics**

Refinement must recompute the uncertain demag owner only. If ambiguity comes from an endpoint residual with no qualified refinement, reject/fail closed after rollback. Rename or remove `endpoint_replaced_delta_j` diagnostics so logs cannot imply the deleted algorithm; add explicit `endpoint_residual_delta_j` and operand-scale information only if this fits the existing internal struct without ABI growth.

- [ ] **Step 6: Run managed GREEN and focused GPU reproduction**

Run the source contract, managed relaxation runtime, and one-repeat GPU exchange-plus-Zeeman reproduction. Require:

- direct combined increment approximately `-2.103751839e-39 J`;
- strict Armijo acceptance against approximately `-6.0314e-43 J`;
- no accepted resolved uphill step;
- rollback on any rejected trial;
- exactly the canonical four-sync budget.

- [ ] **Step 7: Commit**

Stage Task 3 files only and commit:

```bash
git commit -m "fix: compose FEM GPU Armijo energy term by term"
```

---

### Task 4: Identity-pin Task 8 qualification and close the production matrix

**Files:**

- Modify: `scripts/analysis/fem_gpu_benchmark.py`
- Modify: `scripts/test_validate_fem_relaxation_runtime_log.py`
- Modify: `justfile`
- Modify: `.superpowers/sdd/task-8-report.md`
- Modify: `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
- Create: `.superpowers/sdd/task-8-direct-increment-report.md`

**Interfaces:**

- Consumes: final managed runtime manifest, source manifest, `libfullmag_fem` SHA-256, explicit fixture/mesh signature and Task 8 benchmark rows.
- Produces: identity-pinned focused A/B and final five-repeat Task 8 acceptance artifact.

- [ ] **Step 1: Add RED identity tests**

The benchmark validator must reject a row set when any of these differs between expected runtime metadata and executed rows/artifacts:

```text
source_manifest_sha256
runtime_manifest_sha256
libfullmag_fem_sha256
fixture_sha256
solver_mesh_signature
magnetic_node_indices_sha256
initial_m_sha256
device_name / compute capability
precision
OpenMP thread count
resolved demag policy
```

It must also reject incomplete CPU/GPU pairs and missing energy-monotonicity evidence. The old `98f832...` artifact must fail because its loaded native-library hash differs from the later runtime.

- [ ] **Step 2: Run Python RED, then implement exact metadata validation**

Use one validation owner in `fem_gpu_benchmark.py`; recipes pass expected manifest/library identity rather than reimplementing comparisons in shell. Run the focused Python tests until GREEN.

- [ ] **Step 3: Build one final managed runtime**

Run the repository-managed rebuild once after all native commits. Validate `sm_89`, HYPRE provider identity, source-manifest identity, and loaded `libfullmag_fem` hash. Preserve the runtime bundle as immutable qualification input.

- [ ] **Step 4: Run focused identity-pinned A/B**

Export/reuse one explicit mesh and initial magnetization for both runtimes. Run one repeat of the three diagnosed PG-BB pairs. Record base and candidate runtime/library hashes and require the candidate conditions from the design spec. Do not use separately generated meshes as A/B proof.

- [ ] **Step 5: Run the exact managed Task 8 gates**

Run:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract

COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-runtime

COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb \
FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP=4 \
FULLMAG_BENCH_REPEAT=5 \
just verify-fem-relaxation-production-benchmark
```

Acceptance: summary status pass; all expected rows present; complete CPU/GPU pairs; accepted trajectories monotone; no resolved uphill acceptance; no sync-budget overrun; fixture, runtime, and native-library identities exact.

- [ ] **Step 6: Update Task 8 evidence and commit**

Record RED/GREEN results, focused A/B, all final row counts and timing percentiles, exact artifact paths/hashes, and remaining fixture-quality caveat. Mark the old 95/110 artifact diagnostic-only.

Stage only Task 4 files and commit:

```bash
git commit -m "test: qualify FEM direct Armijo increments"
```

---

### Task 5: Independent Task 8 closure review

**Files:**

- Modify: `.superpowers/sdd/task-8-report.md` only if review corrections are required
- Modify: `.superpowers/sdd/progress.md` locally after approval; never commit it

**Interfaces:**

- Consumes: the full diff from `7c44dd22` through final Task 4 commit, design/spec, managed artifacts, and exact final runtime identities.
- Produces: independent spec and quality APPROVED verdicts for Task 8.

- [ ] **Step 1: Generate one review package**

Use the recorded pre-extension base `7c44dd2257bf2012966da27aaacbe39cdc0bfe78` and final HEAD, not `HEAD~1`.

- [ ] **Step 2: Review the complete numerical and validation scope**

The reviewer checks signs/factors, term ownership, uncertainty bounds, strict uphill rejection, rollback/refinement, CPU/GPU parity, source-test quality, runtime identity, four-sync accounting, and literal production acceptance. Managed suites already evidenced are not rerun.

- [ ] **Step 3: Resolve every Critical/Important finding and re-review**

Each fix reruns its focused covering test and the smallest authoritative managed gate. Do not waive a spec finding or substitute fixture changes.

- [ ] **Step 4: Close Task 8 ledger**

Only after spec and quality APPROVED, update the local progress ledger with commits, exact managed evidence, runtime/library identities, row counts, performance metrics, and review verdict. Then continue with Task 9 of the parent remediation plan.
