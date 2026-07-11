# FEM Riemannian PG-BB Demag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambient FEM PG-BB secant with a transported tangent-space secant, prove the correction on CPU and CUDA, and restore FEM PG-BB with demagnetization only if the managed production qualification passes.

**Architecture:** The existing normalization retraction remains unchanged. CPU and CUDA project the accepted chord and previous gradient into the tangent space at the accepted magnetization before accumulating the existing `mu0 Ms_i V_i` BB products; Armijo, BB decision policy, demag formulation, and runtime state ownership remain unchanged. Planner/UI quarantine changes are a separate, evidence-gated phase after the native CPU/GPU benchmark.

**Tech Stack:** C++20, MFEM, CUDA, CMake, Rust planner tests, Python benchmark harness, React/Vitest/Playwright-style smoke scripts, container-backed `just` recipes.

## Global Constraints

- Update the publication-style physics contract before changing native physics code.
- Preserve `lambda` in `m/A` and the energy metric `mu0 Ms_i V_i`.
- Preserve strict Armijo and exact nonincrease recovery; do not add a noise window.
- Preserve deterministic fresh-start demag trials and require effective `rtol<=1e-12`.
- Do not substitute NCG, CPU, another precision, or another demag realization.
- Native FEM builds and qualification use repository container-backed `just` recipes.
- Preserve all pre-existing dirty-tree changes; edit only the named expressions and tests.
- Do not change OpenAPI or generated frontend types because the existing algorithm vocabulary is sufficient.

---

### Task 1: Publish the transported PG-BB physics contract

**Files:**
- Modify: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md:224-270`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md:180-215`
- Test: `scripts/test_validate_fem_relaxation_runtime_log.py`

**Interfaces:**
- Consumes: approved design `docs/superpowers/specs/2026-07-11-fem-riemannian-pgbb-demag-design.md`.
- Produces: canonical definitions `s_tilde=P_m_new(m_new-m_old)` and `y_tilde=g_new-P_m_new(g_old)` used by both native lanes.

- [ ] **Step 1: Replace the ambient secant equations in the physics note**

Insert the following definition before the BB products:

```markdown
Because the admissible FEM magnetization is a product of nodal spheres,
successive tangent gradients cannot be subtracted in the ambient space. With
the normalization retraction, use projection transport into the accepted
tangent space:

\[
P_{m_k}v = v-(m_k\cdot v)m_k,
\qquad
\widetilde s_k=P_{m_k}(m_k-m_{k-1}),
\qquad
\widetilde y_k=g_k-P_{m_k}g_{k-1}.
\]

The BB products and BB1/BB2 quotients use `widetilde s_k` and
`widetilde y_k` in the physical `mu0 Ms_i V_i` metric. CPU and CUDA implement
the same projection transport at the accepted state.
```

- [ ] **Step 2: Reconcile the canonical equilibrium note**

State explicitly:

```markdown
For constrained PG-BB, secant history is defined in one tangent space. An
ambient `g_k-g_{k-1}` is not canonical and must not be used by a production
backend. Vector transport changes neither the public algorithm name nor the
`m/A` line-search-step unit.
```

- [ ] **Step 3: Run the documentation contract**

Run:

```bash
python3 scripts/test_validate_fem_relaxation_runtime_log.py
```

Expected: exit `0`; all relaxation documentation/recipe assertions pass.

- [ ] **Step 4: Commit only the physics contract**

```bash
git add docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md docs/physics/0580-canonical-relaxation-equilibrium-contract.md
git diff --cached --name-only
git commit -m "docs: define transported FEM PG-BB secants"
```

Expected staged paths: exactly the two physics notes.

---

### Task 2: Add failing CPU and CUDA transported-secant regression tests

**Files:**
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp:540-720`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp:1070-1360`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**
- Consumes: planned CPU function `relaxation::transported_bb_secant(...)` from Task 3 and the unchanged CUDA wrapper `fullmag_cuda_relax_bb_curvature_blocks(...)`.
- Produces: a numerical oracle that distinguishes transported products from the existing ambient products.

- [ ] **Step 1: Add a one-node CPU manufactured test**

Add this function and invoke it from `main()`:

```cpp
void transported_bb_secant_lives_in_the_accepted_tangent_space()
{
    fullmag::fem::Context ctx;
    ctx.mesh.magnetic_node_mask = {1u};
    const double inv_sqrt_two = 1.0 / std::sqrt(2.0);
    const std::vector<double> previous_m = {1.0, 0.0, 0.0};
    const std::vector<double> accepted_m = {inv_sqrt_two, inv_sqrt_two, 0.0};
    const std::vector<double> previous_g = {0.0, 2.0, 1.0};
    const std::vector<double> accepted_g = {
        -3.0 * inv_sqrt_two, 3.0 * inv_sqrt_two, 1.0};
    std::vector<double> s;
    std::vector<double> y;

    check(
        fullmag::fem::relaxation::transported_bb_secant(
            ctx, previous_m, accepted_m, previous_g, accepted_g, s, y),
        "transported BB secant must accept conforming active-node fields");

    const auto dot = [](const std::vector<double> &a, const std::vector<double> &b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    };
    check(std::abs(dot(accepted_m, s)) <= 32.0 * std::numeric_limits<double>::epsilon(),
        "transported BB step must be tangent at accepted m");
    check(std::abs(dot(accepted_m, y)) <= 64.0 * std::numeric_limits<double>::epsilon(),
        "transported BB gradient difference must be tangent at accepted m");

    const std::vector<double> ambient_s = {
        accepted_m[0] - previous_m[0], accepted_m[1], 0.0};
    check(std::abs(dot(accepted_m, ambient_s)) > 1.0e-3,
        "manufactured fixture must distinguish ambient and transported steps");
}
```

- [ ] **Step 2: Change the CUDA calibration oracle to transported products**

In `cuda_heterogeneous_nodal_ms_pgbb_ncg_calibration()`, use normalized,
non-collinear `previous_m` and `trial_m`. Replace the ambient expected loop by:

```cpp
const std::array<double, 3> m1 = {trial_x[node], trial_y[node], trial_z[node]};
const std::array<double, 3> raw_s = {
    m1[0] - previous_x[node],
    m1[1] - previous_y[node],
    m1[2] - previous_z[node],
};
const double m1_dot_raw_s =
    m1[0] * raw_s[0] + m1[1] * raw_s[1] + m1[2] * raw_s[2];
const std::array<double, 3> s = {
    raw_s[0] - m1_dot_raw_s * m1[0],
    raw_s[1] - m1_dot_raw_s * m1[1],
    raw_s[2] - m1_dot_raw_s * m1[2],
};
const double m1_dot_g0 =
    m1[0] * previous_gx[node] +
    m1[1] * previous_gy[node] +
    m1[2] * previous_gz[node];
const std::array<double, 3> y = {
    trial_gx[node] - (previous_gx[node] - m1_dot_g0 * m1[0]),
    trial_gy[node] - (previous_gy[node] - m1_dot_g0 * m1[1]),
    trial_gz[node] - (previous_gz[node] - m1_dot_g0 * m1[2]),
};
```

Keep the existing heterogeneous `Ms`, volume weights, inactive sentinel node,
BB1/BB2 decision assertions, and reduction tolerance.

- [ ] **Step 3: Add a CUDA source-ownership assertion**

Require `bb_curvature_kernel` to contain the three accepted-state projections:

```cpp
check(
    kernels_source.find("m_dot_raw_s", kernels_source.find("bb_curvature_kernel")) !=
            std::string::npos &&
        kernels_source.find("m_dot_previous_g", kernels_source.find("bb_curvature_kernel")) !=
            std::string::npos &&
        kernels_source.find("transported_previous_g", kernels_source.find("bb_curvature_kernel")) !=
            std::string::npos,
    "native FEM CUDA PG-BB curvature must transport its secant pair into the accepted tangent space");
```

- [ ] **Step 4: Run the managed native contract and record RED**

Run:

```bash
just verify-fem-time-domain-native-contract
```

Expected before Tasks 3 and 4: nonzero exit caused by the missing
`transported_bb_secant` CPU interface and/or CUDA curvature mismatch. Confirm
that the failure is the new regression test, not an unrelated build failure.

Do not commit the failing state.

---

### Task 3: Implement the CPU transported BB secant

**Files:**
- Modify: `backends/fem/cpu/mfem/relaxation/relaxation_math.hpp:70-85`
- Modify: `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp:564-610`
- Modify: `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp:56-128`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**
- Consumes: `relaxation::project_tangent(...)` and the test fixture from Task 2.
- Produces:

```cpp
bool transported_bb_secant(
    const Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &accepted_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &accepted_gradient,
    std::vector<double> &transported_step,
    std::vector<double> &transported_gradient_difference);
```

- [ ] **Step 1: Declare the helper in `relaxation_math.hpp`**

Add the exact signature from the Interfaces block beside `project_tangent`.

- [ ] **Step 2: Implement the helper through the existing projection owner**

```cpp
bool transported_bb_secant(
    const Context &ctx,
    const std::vector<double> &previous_m,
    const std::vector<double> &accepted_m,
    const std::vector<double> &previous_gradient,
    const std::vector<double> &accepted_gradient,
    std::vector<double> &transported_step,
    std::vector<double> &transported_gradient_difference)
{
    const size_t size = accepted_m.size();
    if (size == 0u || size % 3u != 0u || previous_m.size() != size ||
        previous_gradient.size() != size || accepted_gradient.size() != size) {
        transported_step.clear();
        transported_gradient_difference.clear();
        return false;
    }
    std::vector<double> ambient_step(size, 0.0);
    for (size_t i = 0; i < size; ++i) {
        ambient_step[i] = accepted_m[i] - previous_m[i];
    }
    transported_step = project_tangent(ctx, accepted_m, ambient_step);
    const std::vector<double> previous_gradient_transported =
        project_tangent(ctx, accepted_m, previous_gradient);
    transported_gradient_difference.assign(size, 0.0);
    for (size_t i = 0; i < size; ++i) {
        transported_gradient_difference[i] =
            accepted_gradient[i] - previous_gradient_transported[i];
    }
    const auto finite = [](const std::vector<double> &field) {
        return std::all_of(field.begin(), field.end(), [](double value) {
            return std::isfinite(value);
        });
    };
    return finite(transported_step) &&
        finite(transported_gradient_difference);
}
```

- [ ] **Step 3: Use the transported fields in `update_bb_step_size`**

Before the weighted node loop:

```cpp
std::vector<double> transported_step;
std::vector<double> transported_gradient_difference;
const bool secant_valid = relaxation::transported_bb_secant(
    ctx,
    previous_m,
    trial_m,
    previous_gradient,
    trial_gradient,
    transported_step,
    transported_gradient_difference);
```

Use `transported_step[idx]` and
`transported_gradient_difference[idx]` for `s` and `y`. If `secant_valid` is
false, pass NaN products to the existing `bb_step_decision` so the existing
bounded reset policy owns recovery.

- [ ] **Step 4: Run the managed contract**

```bash
just verify-fem-time-domain-native-contract
```

Expected at this point: CPU manufactured test passes; CUDA transported oracle
still fails until Task 4.

---

### Task 4: Implement the CUDA transported BB curvature without new state

**Files:**
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu:252-288`
- Verify unchanged: `backends/fem/gpu/cuda/relaxation/pgbb_kernels.hpp:81-101`
- Verify unchanged: `backends/fem/gpu/cuda/relaxation/pgbb.cpp:622-708`
- Test: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`

**Interfaces:**
- Consumes: existing old/new magnetization, old/new gradient, `Ms`, lumped mass, and mask pointers already passed to `bb_curvature_kernel`.
- Produces: the same three reduction arrays `ss`, `sy`, `yy`; no ABI, allocation, or readback change.

- [ ] **Step 1: Replace ambient CUDA secants with accepted-state projections**

Inside the active-node branch, implement:

```cpp
const double raw_sx = trial_mx[i] - previous_mx[i];
const double raw_sy = trial_my[i] - previous_my[i];
const double raw_sz = trial_mz[i] - previous_mz[i];
const double m_dot_raw_s =
    trial_mx[i] * raw_sx + trial_my[i] * raw_sy + trial_mz[i] * raw_sz;
const double sx = raw_sx - m_dot_raw_s * trial_mx[i];
const double sy_comp = raw_sy - m_dot_raw_s * trial_my[i];
const double sz = raw_sz - m_dot_raw_s * trial_mz[i];

const double m_dot_previous_g =
    trial_mx[i] * previous_gx[i] +
    trial_my[i] * previous_gy[i] +
    trial_mz[i] * previous_gz[i];
const double transported_previous_gx =
    previous_gx[i] - m_dot_previous_g * trial_mx[i];
const double transported_previous_gy =
    previous_gy[i] - m_dot_previous_g * trial_my[i];
const double transported_previous_gz =
    previous_gz[i] - m_dot_previous_g * trial_mz[i];
const double yx = trial_gx[i] - transported_previous_gx;
const double yy_comp = trial_gy[i] - transported_previous_gy;
const double yz = trial_gz[i] - transported_previous_gz;
```

Keep the existing `kMu0 * ms[i] * node_weight(...)` products and block
reductions exactly as they are.

- [ ] **Step 2: Run the managed native contract GREEN**

```bash
just verify-fem-time-domain-native-contract
```

Expected: exit `0`; CPU and CUDA transported-secant tests, source contract,
energy derivative contract, operator contract, STT contract, and CUDA tetra
gradient contract all pass.

- [ ] **Step 3: Prove the regression test is sensitive**

Temporarily restore only `bb_curvature_kernel` to ambient `s`/`y`, rerun:

```bash
just verify-fem-time-domain-native-contract
```

Expected: nonzero exit at the transported CUDA BB product assertions. Restore
the transported kernel and rerun the same command; expected exit `0`.

- [ ] **Step 4: Commit the native correction and its tests**

```bash
git add backends/fem/cpu/mfem/relaxation/relaxation_math.hpp \
  backends/fem/cpu/mfem/relaxation/relaxation_math.cpp \
  backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp \
  backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu \
  backends/fem/tests/relaxation_energy_derivative_contract.cpp \
  backends/fem/tests/relaxation_source_contract.cpp
git diff --cached --name-only
git commit -m "fix: transport FEM PG-BB secant history"
```

Expected staged paths: exactly the six listed files.

---

### Task 5: Run the controlled runtime experiment while quarantine remains public

**Files:**
- Modify conditionally: `scripts/analysis/fem_gpu_benchmark.py:1097-1110`
- Modify conditionally: `scripts/test_validate_fem_relaxation_runtime_log.py:1840-1885`
- Modify conditionally: `crates/fullmag-plan/src/fem.rs:2003-2017`
- Modify conditionally: `crates/fullmag-plan/src/tests.rs:4452-4565`
- Artifacts: `.fullmag/reports/fullmag_relaxation_production_benchmark.csv`
- Artifacts: `.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json`

**Interfaces:**
- Consumes: transported native implementation and existing demag accuracy policy.
- Produces: an evidence-backed boolean decision: promote FEM PG-BB+demag or retain quarantine.

- [ ] **Step 1: Write failing planner promotion tests**

Replace the quarantine test with the exact resolved-policy test:

```rust
#[test]
fn fem_demag_projected_gradient_bb_resolves_missing_solver_policy_to_armijo_accuracy() {
    let planned = plan(&fem_demag_relaxation_policy_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
    ))
    .expect("qualified FEM PG-BB demag must plan without fallback");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let relaxation = fem.relaxation.expect("FEM relaxation control");
    assert_eq!(
        relaxation.algorithm,
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
    );
    let policy = fem
        .demag_solver_policy
        .expect("PG-BB demag must carry its resolved solver policy");
    assert_eq!(policy.rtol, 1.0e-12);
    assert!(planned.provenance.notes.iter().any(|note| {
        note.contains("algorithm=projected_gradient_bb")
            && note.contains("requested=default")
            && note.contains("resolved_rtol=1.000000e-12")
    }));
}
```

- [ ] **Step 2: Make the benchmark manifest include PG-BB demag**

Delete the `if "demag" in interactions` filtering block from
`relaxation_algorithms_for_scenario`. Replace the harness test with:

```python
def test_fem_pgbb_demag_is_included_in_production_manifest() -> None:
    benchmark = load_benchmark_module()
    algorithms = ["llg_overdamped", "projected_gradient_bb", "nonlinear_cg"]
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_demag", algorithms
    ) == algorithms
    assert benchmark.relaxation_algorithms_for_scenario(
        "box500_airbox_exchange_zeeman", algorithms
    ) == algorithms
```

- [ ] **Step 3: Remove only the planner hard quarantine**

Delete the `enable_demag && ProjectedGradientBb` rejection block. Retain the
shared direct-minimizer policy:

```rust
if enable_demag && matches!(
    relaxation.algorithm,
    RelaxationAlgorithm::ProjectedGradientBb |
        RelaxationAlgorithm::NonlinearCg |
        RelaxationAlgorithm::TangentPlaneImplicit
) {
    // Existing canonical missing-rtol resolution and explicit-loose-policy
    // rejection remain the sole demag accuracy gate.
}
```

- [ ] **Step 4: Run focused planner and harness tests**

```bash
cargo test -p fullmag-plan fem_demag_
python3 scripts/test_validate_fem_relaxation_runtime_log.py
```

Expected: exit `0`; PG-BB plans on CPU/GPU at effective `rtol=1e-12`, explicit
looser policies still reject, and the manifest contains PG-BB demag cases.

- [ ] **Step 5: Rebuild and validate the managed runtime**

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
```

Expected: both commands exit `0`; the managed bundle freshness check accepts
the newly built native runtime.

- [ ] **Step 6: Run the smallest cross-lane runtime proof**

```bash
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb \
FULLMAG_BENCH_STEPS=4 \
just verify-fem-relaxation-cpu-gpu-consistency-smoke
```

Expected: exit `0`; CPU and GPU execute the requested PG-BB algorithm with no
fallback and satisfy the existing energy/torque comparison.

- [ ] **Step 7: Run the authoritative production qualification**

```bash
just verify-fem-relaxation-production-benchmark
```

Expected: exit `0`; summary has zero failures and includes required CPU and GPU
PG-BB rows for every demag interaction scenario at effective `rtol<=1e-12`.
Inspect both CSV and JSON; command success without those rows is a failed
qualification.

- [ ] **Step 8: Apply the qualification decision**

If Steps 6 or 7 fail in PG-BB demag, restore the four conditional files in
this task to their pre-task content, retain the native transported-secant fix,
and record the first failing curvature/Armijo/demag evidence. Do not proceed to
Task 6 and do not weaken Armijo.

If both pass, commit exactly the four conditional files:

```bash
git add crates/fullmag-plan/src/fem.rs crates/fullmag-plan/src/tests.rs \
  scripts/analysis/fem_gpu_benchmark.py \
  scripts/test_validate_fem_relaxation_runtime_log.py
git diff --cached --name-only
git commit -m "feat: qualify FEM PG-BB demag planning"
```

---

### Task 6: Promote the qualified capability through UI and canonical docs

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts:211-221`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts:192-215`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx:554-578`
- Modify: `apps/control-room/scripts/smoke-study-authoring-ui.mjs:249-254`
- Modify: `docs/specs/capability-matrix-v0.md:203-205,254`
- Modify: `docs/specs/capability-matrix-v0.json:59`
- Modify: `docs/specs/problem-ir-v0.md:191-200`
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Modify: `docs/validation/2026-07-11-relaxation-qualification-matrix.md`

**Interfaces:**
- Consumes: passing managed production artifacts from Task 5.
- Produces: planner/UI/docs agreement that FEM CPU/CUDA PG-BB+demag is executable at effective `rtol<=1e-12` without fallback.

- [ ] **Step 1: Remove the hard-coded UI disablement**

In `relaxationAlgorithmAvailability`, delete only the FEM+demag PG-BB disabled
branch. Keep all unrelated algorithm, backend, and capability gates.

- [ ] **Step 2: Invert the focused UI tests and smoke assertion**

Use these semantic expectations:

```ts
expect(relaxationAlgorithmAvailability("projected_gradient_bb", context)).toEqual({
  available: true,
});
```

In the Inspector test, assert the PG-BB option is enabled for FEM demag. In
the browser smoke, replace the `not qualified for FEM demag` text assertion
with an enabled-option assertion. Do not change the NCG or TPI expectations.

- [ ] **Step 3: Update capability and provenance documentation**

Record all of the following facts in the Markdown and JSON matrix entries:

```text
FEM CPU and FEM CUDA projected_gradient_bb with demag are production-executable
after transported tangent-space BB qualification. Missing demag solver rtol
resolves to 1e-12; explicitly looser rtol rejects before runtime. The requested
PG-BB algorithm is preserved and no NCG/device/precision fallback is permitted.
```

Update the validation report with the exact new benchmark row count, required
coverage count, CPU/GPU pair count, artifact paths, and command log names read
from Task 5 outputs. Do not predeclare numeric counts in source before reading
the generated summary.

- [ ] **Step 4: Run focused frontend verification**

```bash
pnpm --dir apps/control-room test -- \
  StudyStageAuthoringModel.test.ts StudyInspectorPanel.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
```

Expected: every command exits `0`, with no warnings.

- [ ] **Step 5: Run the study-authoring browser smoke**

Run:

```bash
pnpm --dir apps/control-room smoke:study-authoring-ui
```

Expected: exit `0`; FEM demag PG-BB is visibly enabled and selectable.

- [ ] **Step 6: Commit the capability promotion**

```bash
git add apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts \
  apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts \
  apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.test.tsx \
  apps/control-room/scripts/smoke-study-authoring-ui.mjs \
  docs/specs/capability-matrix-v0.md docs/specs/capability-matrix-v0.json \
  docs/specs/problem-ir-v0.md docs/architecture/backend-golden-masterplan.md \
  docs/validation/2026-07-11-relaxation-qualification-matrix.md
git diff --cached --name-only
git commit -m "docs: promote qualified FEM PG-BB demag"
```

---

### Task 7: Final verification and evidence audit

**Files:**
- Verify: all files changed in Tasks 1-6
- Verify artifacts: `.fullmag/reports/fullmag_relaxation_production_benchmark.csv`
- Verify artifacts: `.fullmag/reports/fullmag_relaxation_production_benchmark_summary.json`

**Interfaces:**
- Consumes: completed native correction and, only on qualification success, capability promotion.
- Produces: final evidence-backed completion or an explicit retained-quarantine report.

- [ ] **Step 1: Re-run native contracts from a fresh managed build**

```bash
just verify-fem-time-domain-native-contract
just rebuild-fem-runtime
just ensure-managed-fem-runtime
```

Expected: all commands exit `0`.

- [ ] **Step 2: Re-run relaxation runtime and convergence gates**

```bash
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-relaxation-production-benchmark
```

Expected: every command exits `0`; no requested algorithm fallback, norm
failure, Armijo failure, demag-policy failure, or CPU/GPU consistency failure.

- [ ] **Step 3: Re-run cross-layer focused suites**

```bash
cargo test -p fullmag-plan fem_demag_
python3 scripts/test_validate_fem_relaxation_runtime_log.py
pnpm --dir apps/control-room test -- \
  StudyStageAuthoringModel.test.ts StudyInspectorPanel.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint -- --max-warnings=0
```

Expected: every command exits `0`.

- [ ] **Step 4: Audit the final diff and artifacts**

```bash
git diff --check
git status --short
```

Read the production summary and verify CPU/GPU PG-BB demag rows, resolved
`rtol`, requested/reported algorithm equality, failure count, Armijo outcome,
torque, energy, norm defect, and residency evidence. Report unrelated dirty
files separately; do not include them in task commits.

- [ ] **Step 5: Request code review before integration**

Use the repository code-review workflow on the task commits and address only
findings that trace to this design. Re-run the affected proof command after
every correction.
