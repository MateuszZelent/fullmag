# FEM Differential Armijo Demag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FEM PG-BB with demag evaluate strict Armijo from a direct energy increment and qualify the CPU/GPU lane only if every accepted production step remains strictly descending.

**Architecture:** Capture the accepted endpoint fields, evaluate trial fields through the existing fresh-snapshot path, and reduce `E(m_trial)-E(m_current)` locally rather than subtracting two total-energy observables. When the direct floating-point interval intersects the Armijo threshold, rerun deterministic fresh demag endpoint snapshots at an internally tighter tolerance; accept only if both ordinary and refined increments satisfy the unchanged strict inequality.

**Tech Stack:** C++20, MFEM/hypre, CUDA/CUB, existing native FEM relaxation contracts, Python benchmark harness, container-backed `just` recipes.

## Global Constraints

- Preserve the transported tangent BB secant already implemented for CPU and CUDA.
- Preserve `lambda` in `m/A`, the `mu0 Ms V` energy metric, `c1=1e-4`, and strict Armijo.
- Do not add a noise window, accept an uphill trial, declare ambiguity to be convergence, or use NCG/device/precision/demag fallback.
- Normal trials add no Poisson solve; refinement is finite, deterministic, and used only for an overlapping numerical interval.
- CPU and GPU retain separate implementation owners but one documented energy/sign/unit contract.
- Keep planner and UI PG-BB+demag quarantine until a fresh managed CPU/GPU qualification passes.
- Native FEM build and runtime evidence uses managed container-backed `just` recipes.
- Preserve unrelated dirty-tree changes and stage only paths owned by this work.

---

### Task 1: Publish and pin the differential Armijo contract

**Files:**
- Create: `docs/superpowers/specs/2026-07-11-fem-differential-armijo-demag-design.md`
- Modify: `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
- Modify: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`
- Test: `scripts/test_validate_fem_relaxation_runtime_log.py`

**Interfaces:**
- Produces canonical `DeltaE <= c1 lambda p_dot_g` and polarized Poisson-demag `DeltaE_demag` equations.

- [ ] Add the direct-increment Armijo and Poisson polarization equations, documenting that Robin is represented through the endpoint fields and `J` units.
- [ ] State that a normal trial has no extra solve; an overlapping numerical interval permits one bounded internal refinement and otherwise fails closed.
- [ ] Run `python3 scripts/test_validate_fem_relaxation_runtime_log.py`; expect exit `0`.

### Task 2: Add red CPU and CUDA difference-oracle contracts

**Files:**
- Modify: `backends/fem/tests/relaxation_energy_derivative_contract.cpp`
- Modify: `backends/fem/tests/relaxation_source_contract.cpp`
- Modify: `backends/fem/CMakeLists.txt` only if a new focused test target is needed.

**Interfaces:**
- Produces `relaxation::EnergyDifference` and `relaxation::strict_armijo_difference_accept(...)` declarations used by CPU PG-BB.
- Produces CUDA reduction API for direct current/trial energy increments.

- [ ] Write a manufactured fixture with endpoint totals near `-2e-17 J` and a descending increment near `-1e-31 J`; assert direct difference accepts while endpoint-total comparison cannot represent the decision.
- [ ] Write a demag polarized-increment fixture with heterogeneous `Ms`, lumped masses, and inactive node; assert CPU reference and CUDA reduction agree.
- [ ] Write an ambiguity fixture that requires refinement and asserts a refined disagreement is rejected.
- [ ] Run `just verify-fem-time-domain-native-contract`; expect the new tests to fail because direct-difference symbols or CUDA source ownership are absent. Do not commit red state.

### Task 3: Implement CPU direct increments and bounded refinement

**Files:**
- Modify: `backends/fem/cpu/mfem/relaxation/relaxation_math.hpp`
- Modify: `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- Modify: `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_energy.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/demag_poisson_energy.cpp`

**Interfaces:**
- `struct EnergyDifference { double delta_joules; double absolute_term_sum_joules; double roundoff_bound_joules; };`
- `enum class ArmijoDifferenceDecision { Accept, Reject, Refine };`
- `ArmijoDifferenceDecision strict_armijo_difference_decision(const EnergyDifference&, double armijo_rhs_joules);`

- [ ] Implement direct local/exchange energy differences and the demag polarized difference from saved current/trial fields in their existing energy owners.
- [ ] Compute a conservative reduction roundoff bound from the absolute term sum; do not compare `trial_stats.total_energy_joules` with `current_stats.total_energy_joules` in PG-BB.
- [ ] Save accepted endpoint fields before the trial snapshot; use the existing fresh snapshot for ordinary trial data.
- [ ] On `Refine`, rerun deterministic current/trial snapshots at internal stricter tolerance, recompute the direct increment, and accept only if both evaluations satisfy strict Armijo.
- [ ] Restore the accepted state and original solver policy after every rejected/refined path, including snapshot failure.
- [ ] Run `just verify-fem-time-domain-native-contract`; expect CPU contracts green and CUDA test still red.

### Task 4: Implement CUDA direct increments and bounded refinement

**Files:**
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb_kernels.hpp`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu`
- Modify: `backends/fem/gpu/cuda/relaxation/pgbb.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_demag_energy_reductions.*` only if the shared demag difference kernel is the existing owner.

**Interfaces:**
- CUDA kernel reduces direct `DeltaE`, absolute term sum, and demag polarized increment for device-resident current/trial fields.

- [ ] Reuse allocated device scratch only; do not add host readback or a per-trial allocation.
- [ ] Preserve device residency during normal and refined snapshot paths.
- [ ] Make the GPU Armijo decision consume the direct increment and same interval decision as CPU.
- [ ] Extend source ownership assertions for the direct-difference kernel and absence of endpoint-total comparison in PG-BB.
- [ ] Run `just verify-fem-time-domain-native-contract`; expect all named native contracts green.

### Task 5: Qualify, then decide capability status

**Files:**
- Modify only on pass: `crates/fullmag-plan/src/fem.rs`, planner tests, benchmark manifest/harness tests, `docs/specs/capability-matrix-v0.{md,json}`, validation matrix, and existing Control Room capability tests.
- Create: `.fullmag/reports/fem-pgbb-differential-armijo-qualification.*` (untracked runtime evidence).

- [ ] Run `just rebuild-fem-runtime` and `just ensure-managed-fem-runtime` from a stable source snapshot.
- [ ] Run the PG-BB-only production benchmark with demag, CPU and GPU, ordinary/refined telemetry, and `rtol<=1e-12`.
- [ ] Promote planner/UI only if every required case completes, every accepted step passes strict direct-increment Armijo, no hidden fallback occurs, and CPU/GPU parity gates pass.
- [ ] If any gate fails, retain quarantine and publish the first failing `DeltaE`, interval, refinement, residual, and provenance evidence.

## Plan self-review

- Physics contract, red tests, CPU, CUDA, managed runtime, and capability promotion each have an explicit task.
- No task permits an arbitrary tolerance or an uphill acceptance.
- Planner/UI change is explicitly conditional on authoritative managed qualification.
