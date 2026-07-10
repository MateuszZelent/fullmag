# Canonical Relaxation Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make every Fullmag relaxation algorithm physically correct, capability-honest, and identical in meaning across Python, ProblemIR, planner, FDM/FEM runtimes, OpenAPI, artifacts, and the Control Room inspector.

**Architecture:** Establish the canonical semantic spine first, then move exact torque and completion ownership into execution state, repair FDM and FEM algorithms independently, and finally regenerate API/UI surfaces from the typed contract. Compatibility aliases are normalized only at authoring boundaries; canonical IR and exports contain no legacy ambiguity.

**Tech Stack:** Python 3 dataclasses/unittest, Rust/serde/utoipa, C++17/MFEM, CUDA, repository container-backed just recipes, Next.js 16, TypeScript, React, Vitest, generated OpenAPI v2 transport.

## Global Constraints

- Canonical physics is docs/physics/0580-canonical-relaxation-equilibrium-contract.md.
- Architectural decision is docs/adr/0018-algorithm-specific-relaxation-contract.md.
- Preserve every pre-existing working-tree change and stage only files owned by the current task.
- Every production behavior change starts with a focused failing test and a verified expected failure.
- Relaxation rejects thermal noise, direct torques, time-dependent sources, and fields without matching energy.
- Canonical torque is exact max |m cross H_eff| in A/m; total RHS norm is a separate 1/s metric.
- Direct minimizers do not own dynamics, integrators, damping, dt, or seconds-valued budgets.
- TPI remains CPU/MFEM development-only and strict-production-disabled.
- Native FEM builds and runtime proof use repository container-backed just recipes first.
- OpenAPI sources are edited before generated TypeScript; generated files are never edited manually.
- Control Room keeps one capability-gated inspector and uses API facade/resource hooks only.
- Completion status, convergence, stop reason, metric, unit, threshold, and provenance must agree.

---

### Task 1: Freeze the accepted baseline and add the ADR

**Files:**
- Create: docs/adr/0018-algorithm-specific-relaxation-contract.md
- Read: docs/physics/0580-canonical-relaxation-equilibrium-contract.md
- Read: docs/superpowers/specs/2026-07-10-canonical-relaxation-contract-design.md
- Read: docs/validation/2026-07-09-backend-llg-scientific-audit.md

**Interfaces:**
- Consumes: approved variant 2 and the current dirty worktree.
- Produces: one versioned architectural decision and a recorded pre-change verification baseline.

- [ ] **Step 1: Verify the new documents are internally clean**

Run:

~~~bash
git diff --check -- docs/adr/0018-algorithm-specific-relaxation-contract.md
rg -n 'TBD|TODO|FIXME|PLACEHOLDER' docs/adr/0018-algorithm-specific-relaxation-contract.md docs/physics/0580-canonical-relaxation-equilibrium-contract.md docs/superpowers/specs/2026-07-10-canonical-relaxation-contract-design.md
~~~

Expected: diff check exits zero and the placeholder scan has no output.

- [ ] **Step 2: Record baseline failures without changing them**

Run:

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-plan
pnpm --dir apps/control-room test
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_*.py'
just verify-fem-time-domain-native-contract
~~~

Expected: retain the existing unrelated fullmag-plan frequency-domain failure as baseline evidence; record exact outcomes of the other commands.

- [ ] **Step 3: Commit only ADR and plan**

~~~bash
git add docs/adr/0018-algorithm-specific-relaxation-contract.md docs/superpowers/plans/2026-07-10-canonical-relaxation-contract.md
git diff --cached --check
git commit -m "docs: plan canonical relaxation repair"
~~~

Expected: the commit contains exactly the ADR and this plan.

---

### Task 2: Make Python authoring finite, canonical, and algorithm-specific

**Files:**
- Create: packages/fullmag-py/tests/test_relaxation_contract.py
- Modify: packages/fullmag-py/src/fullmag/model/study.py
- Modify: packages/fullmag-py/src/fullmag/world.py
- Modify: packages/fullmag-py/src/fullmag/runtime/script_builder.py
- Modify: packages/fullmag-py/src/fullmag/_validation.py
- Modify: packages/fullmag-py/tests/test_api.py

**Interfaces:**
- Consumes: canonical defaults and algorithm taxonomy from the physics note.
- Produces: RelaxStop.max_relaxation_time_s, algorithm-valid Relaxation construction, finite validation, explicit-None preservation, and canonical script payloads.

- [ ] **Step 1: Write focused failing Python tests**

Create tests equivalent to:

~~~python
import math
import unittest

import fullmag as fm


class RelaxationContractTests(unittest.TestCase):
    def test_canonical_defaults_are_shared(self):
        stop = fm.RelaxStop()
        self.assertEqual(stop.torque_tolerance_apm, 1e-4)
        self.assertEqual(stop.max_steps, 50_000)

    def test_direct_minimizer_rejects_llg_dynamics(self):
        with self.assertRaisesRegex(ValueError, "does not accept dynamics"):
            fm.Relaxation(
                algorithm="projected_gradient_bb",
                dynamics=fm.LLG(integrator="rk23"),
            )

    def test_direct_minimizer_rejects_seconds_budget(self):
        with self.assertRaisesRegex(ValueError, "max_relaxation_time_s"):
            fm.Relaxation(
                algorithm="nonlinear_cg",
                stop=fm.RelaxStop(max_relaxation_time_s=1e-9),
            )

    def test_explicit_none_is_not_refilled_by_flat_facade(self):
        stop = fm.RelaxStop(
            torque_tolerance_apm=None,
            energy_tolerance_j=1e-20,
            max_steps=None,
        )
        spec = fm.relax_stage(stop=stop)
        self.assertIsNone(spec.stop.torque_tolerance_apm)
        self.assertIsNone(spec.stop.max_steps)

    def test_nonfinite_stop_values_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    fm.RelaxStop(torque_tolerance_apm=value)
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~bash
PYTHONPATH=packages/fullmag-py/src:packages/fullmag-py/tests python3 -m unittest -v test_relaxation_contract
~~~

Expected: failure because max_relaxation_time_s is absent, direct dynamics are accepted, explicit None is refilled, or NaN passes.

- [ ] **Step 3: Implement finite validation and canonical stop fields**

Use a finite-positive validator:

~~~python
def require_positive(value: float, name: str) -> None:
    if not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be finite and positive")
~~~

Add max_relaxation_time_s to RelaxStop, keep legacy time fields only as constructor-boundary aliases, and serialize only max_relaxation_time_s.

- [ ] **Step 4: Enforce algorithm-specific dynamics**

In Relaxation.__post_init__:

~~~python
is_llg = self.algorithm == "llg_overdamped"
if is_llg and self.dynamics is None:
    object.__setattr__(self, "dynamics", LLG(integrator="auto"))
if not is_llg and self.dynamics is not None:
    raise ValueError(
        f"relaxation algorithm {self.algorithm!r} does not accept dynamics"
    )
if not is_llg and self.stop.max_relaxation_time_s is not None:
    raise ValueError(
        "max_relaxation_time_s is valid only for algorithm='llg_overdamped'"
    )
~~~

Normalize legacy aliases once, reject conflicts, and preserve explicit None in world.py.

- [ ] **Step 5: Make canonical script export/import symmetric**

Emit dynamics fields only for LLG and emit max_relaxation_time_s. Direct minimizer script payloads must omit integrator, fixed_timestep, adaptive fields, damping override, and legacy time fields.

- [ ] **Step 6: Verify GREEN and Python regression suite**

Run:

~~~bash
PYTHONPATH=packages/fullmag-py/src:packages/fullmag-py/tests python3 -m unittest -v test_relaxation_contract
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_*.py'
~~~

Expected: focused relaxation tests pass. In the full discovery run, no new
failure appears; the four recorded unrelated frequency/example baseline
failures either remain equivalent or have been separately fixed by their owner.

- [ ] **Step 7: Commit**

~~~bash
git add packages/fullmag-py/src/fullmag packages/fullmag-py/tests
git commit -m "fix(python): canonicalize relaxation authoring"
~~~

---

### Task 3: Encode algorithm-specific relaxation in ProblemIR and planner

**Files:**
- Modify: crates/fullmag-ir/src/study.rs
- Modify: crates/fullmag-ir/src/execution.rs
- Modify: crates/fullmag-ir/src/lib.rs
- Modify: crates/fullmag-ir/src/validation.rs
- Modify: crates/fullmag-plan/src/validate.rs
- Modify: crates/fullmag-plan/src/tests.rs
- Modify: crates/fullmag-plan/src/spin_torque.rs
- Modify: crates/fullmag-plan/src/fdm.rs
- Modify: crates/fullmag-plan/src/fem.rs
- Modify: crates/fullmag-ir/tests/ir_tests.rs
- Modify: crates/fullmag-runner/src/lib.rs
- Modify: crates/fullmag-cli/src/main.rs
- Modify: crates/fullmag-cli/src/step_utils.rs

**Interfaces:**
- Consumes: Python canonical IR with optional dynamics and max_relaxation_time_s.
- Produces: validated StudyIR::Relaxation, no direct-minimizer integrator, conservative legality, and truthful lane capability.

- [x] **Step 1: Add failing IR/planner tests**

Add tests named:

~~~rust
#[test]
fn direct_minimizer_rejects_dynamics_and_relaxation_time() { /* construct IR and assert both reasons */ }

#[test]
fn llg_relaxation_requires_dynamics() { /* dynamics=None must fail */ }

#[test]
fn direct_minimizer_resolves_no_integrator() { /* planned.integrator == None */ }

#[test]
fn relaxation_rejects_zhang_li_slonczewski_sot_and_thermal() { /* one subcase each */ }

#[test]
fn strict_planner_rejects_tpi_and_extended_cpu_marks_development() { /* requested/resolved */ }
~~~

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-plan direct_minimizer_rejects_dynamics_and_relaxation_time
~~~

Expected: output says running 1 test, then compile failure for the missing
canonical fields or assertion failure because current planner resolves an
integrator. Zero executed tests is not RED evidence.

- [x] **Step 3: Change the IR shape**

Use:

~~~rust
Relaxation {
    algorithm: RelaxationAlgorithmIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dynamics: Option<DynamicsIR>,
    stop: RelaxStopIR,
    sampling: SamplingIR,
}
~~~

RelaxStopIR owns max_relaxation_time_s. Legacy aliases deserialize through an explicit compatibility helper, not duplicate canonical fields.

Update every Rust consumer of StudyIR::Relaxation in the same change so the
workspace never contains a committed IR shape that downstream crates cannot
compile. Mechanical consumers must handle None explicitly; they must not
manufacture direct-minimizer dynamics during the compatibility edit.

- [x] **Step 4: Remove direct-minimizer default integrators**

Replace RelaxationAlgorithmIR::default_integrator with an LLG-only resolver returning Option<IntegratorChoice>, and make planned_study_controls set integrator/fixed/adaptive controls only for LLG.

- [x] **Step 5: Add conservative-legality validation**

Return stable planner diagnostics for each direct torque, thermal noise, time-dependent source, and unpaired Oersted field-energy lane. Apply the rule to all relaxation algorithms.

- [x] **Step 6: Make capability resolution truthful**

Strict TPI rejects. Extended automatic TPI resolves only to CPU/MFEM with an explicit development fallback reason. Forced GPU rejects. Multilayer integrator support matches actual runtime support.

- [x] **Step 7: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-ir
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-plan
CARGO_TARGET_DIR=.fullmag/codex-target cargo check --workspace
~~~

Expected: relaxation tests pass and every workspace consumer compiles; the pre-existing unrelated frequency-domain baseline failure is either still isolated or separately repaired by its owner.

- [x] **Step 8: Commit**

~~~bash
git add crates/fullmag-ir/src/study.rs crates/fullmag-ir/src/execution.rs \
  crates/fullmag-ir/src/lib.rs crates/fullmag-ir/src/validation.rs \
  crates/fullmag-ir/tests/ir_tests.rs crates/fullmag-plan/src/validate.rs \
  crates/fullmag-plan/src/tests.rs crates/fullmag-plan/src/spin_torque.rs \
  crates/fullmag-plan/src/fdm.rs crates/fullmag-plan/src/fem.rs \
  crates/fullmag-runner/src/lib.rs crates/fullmag-cli/src/main.rs \
  crates/fullmag-cli/src/step_utils.rs
git commit -m "fix(ir): separate LLG relaxation from minimizers"
~~~

---

### Task 4: Type stage metrics, convergence, and completion ownership

**Files:**
- Modify: crates/fullmag-ir/src/study.rs
- Modify: crates/fullmag-runner/src/types.rs
- Modify: crates/fullmag-runner/src/relaxation/convergence.rs
- Modify: crates/fullmag-runner/src/relaxation.rs
- Modify: crates/fullmag-runner/src/artifacts.rs
- Modify: crates/fullmag-cli/src/orchestrator.rs
- Modify: crates/fullmag-cli/src/step_utils.rs
- Modify: crates/fullmag-api/src/schemas/runtime.rs
- Modify: crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs

**Interfaces:**
- Consumes: canonical stop controls and exact backend metrics.
- Produces: typed StageMetricKind/unit, authoritative StageCompletionIR, independent converged/terminal state, and artifact persistence.

- [x] **Step 1: Add failing runtime tests**

Cover:

~~~rust
#[test]
fn exact_zero_torque_is_available_and_converged() { /* zero must not fall back */ }

#[test]
fn sparse_output_rows_do_not_change_completion_reason() { /* same execution state */ }

#[test]
fn max_steps_is_terminal_but_not_converged() { /* reason MaxSteps */ }

#[test]
fn backend_error_is_failed_not_completed() { /* status failed */ }

#[test]
fn max_steps_does_not_synthesize_a_time_budget() { /* infinity/no separate cap */ }
~~~

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner exact_zero_torque_is_available_and_converged
~~~

Expected: output says running 1 test and the current >0 sentinel or inferred
completion violates the assertion. Zero executed tests is not RED evidence.

- [x] **Step 3: Add typed metric vocabulary**

Introduce a serde enum and unit mapping:

~~~rust
pub enum StageMetricKind {
    MaxTorqueApm,
    TotalEnergyPlateauRangeJ,
    RelaxationTimeS,
    Steps,
    NumericalStagnation,
}

impl StageMetricKind {
    pub const fn unit(self) -> &'static str {
        match self {
            Self::MaxTorqueApm => "A/m",
            Self::TotalEnergyPlateauRangeJ => "J",
            Self::RelaxationTimeS => "s",
            Self::Steps | Self::NumericalStagnation => "1",
        }
    }
}
~~~

StageCompletionIR carries typed metric, value, threshold, converged, and status.

- [x] **Step 4: Remove sampled-row inference**

Execution loops/native completion pass their accepted-step energy window, exact torque, step count, and relaxation time directly. Delete or restrict infer_stage_completion so it cannot reconstruct a relax stop from artifacts.

- [x] **Step 5: Remove synthetic time and false completion**

resolve_script_until_seconds must not derive max_steps * dt. Direct minimizers have no time cap. Map line-search failure, nonfinite state, and backend error to failed completion.

- [x] **Step 6: Persist generic completion**

Write completion and metric unit to metadata for FDM and FEM, and require frequency-response continuation to see an explicitly converged equilibrium reason.

- [x] **Step 7: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner relaxation
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-cli relaxation
CARGO_TARGET_DIR=.fullmag/codex-target cargo check --workspace
~~~

Expected: focused completion tests pass.

- [x] **Step 8: Commit**

~~~bash
git add crates/fullmag-ir crates/fullmag-runner crates/fullmag-cli crates/fullmag-api
git commit -m "fix(runtime): make relaxation completion authoritative"
~~~

---

### Task 5: Preserve exact FDM torque and separate RHS norm

**Files:**
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/native.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/native/tests.rs
- Modify: crates/fullmag-runner/src/fdm/cpu/reference.rs
- Modify: crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs
- Modify: crates/fullmag-runner/src/fdm/multilayer.rs
- Modify: crates/fullmag-runner/src/types.rs
- Modify: crates/fullmag-engine/src/fdm/shared/observables.rs

**Interfaces:**
- Consumes: native/engine exact field residual and typed runtime metric.
- Produces: exact zero-safe max_torque_Apm and separate max_rhs_norm_per_s on every FDM path.

- [x] **Step 1: Add failing exact-torque tests**

Use a native stats fixture where max_torque_Apm=7 and max_rhs_amplitude maps to a different number; assert the Rust StepStats preserves 7. Add a parallel-state fixture with exact zero and nonzero synthetic RHS to prove zero is not replaced.

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner fdm_native_preserves_exact_torque
~~~

Expected: output says running 1 test and the current wrapper returns the
reconstructed value. Zero executed tests is not RED evidence.

- [x] **Step 3: Map exact native telemetry directly**

Set:

~~~rust
max_torque_Apm: stats.max_torque_Apm,
max_torque_T: stats.max_torque_Apm * crate::MU0,
max_rhs_norm_per_s: stats.max_rhs_amplitude,
~~~

Reject nonfinite or negative native metrics. Remove approximate torque from stop paths.

- [x] **Step 4: Align CPU and multilayer observables**

Publish exact field torque from accepted H_eff and total RHS norm independently. Do not include direct torques in max_torque_Apm.

- [x] **Step 5: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner fdm_native
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-engine torque
~~~

- [x] **Step 6: Commit**

~~~bash
git add crates/fullmag-runner/src/fdm crates/fullmag-runner/src/types.rs crates/fullmag-engine/src/fdm
git commit -m "fix(fdm): preserve exact relaxation torque"
~~~

---

### Task 6: Repair FDM CUDA PG-BB and NCG energy mathematics

**Files:**
- Modify: crates/fullmag-runner/src/relaxation/direct_minimizer.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs
- Modify: crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/native/observables.rs
- Test: crates/fullmag-runner/src/relaxation/direct_minimizer.rs

**Interfaces:**
- Consumes: cell volumes, Ms values, tangent gradient, trial energy.
- Produces: joule-valued directional derivative, weighted BB/PR+ products, truthful step diagnostics, and CPU/CUDA parity.

- [x] **Step 1: Add a failing SI Armijo oracle**

Create a heterogeneous two-cell test with different Ms and volumes. Compute:

~~~rust
let slope_j_per_step = MU0 * cells.iter().map(|c|
    c.ms_apm * c.volume_m3 * dot(c.direction_apm, c.gradient_apm)
).sum::<f64>();
~~~

Assert the accepted/rejected decision changes when the physical weighting is applied and is invariant under equivalent mesh-volume redistribution.

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner cuda_direct_minimizer_armijo_uses_joule_slope
~~~

Expected: output says running 1 test and the unweighted shared helper accepts or
rejects the wrong trial. Zero executed tests is not RED evidence.

- [x] **Step 3: Replace unweighted helper inputs**

Line-search helpers accept direction_dot_gradient_j_per_step rather than raw norm squared. BB1/BB2 and PR+ use the same physical weight vector. Keep lambda in m/A and publish accepted_step_m_per_A.

- [x] **Step 4: Remove pseudo-time accumulation**

Delete lambda-to-seconds accumulation and max_pseudotime checks. Preserve accepted step, backtracks, RHS evaluations, and accepted step count as diagnostics.

- [x] **Step 5: Add CPU/CUDA macrospin and heterogeneous parity**

Compare monotone accepted energy, final exact torque, final magnetization, and stop reason. Do not require identical lambda history.

- [x] **Step 6: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner direct_minimizer
~~~

- [x] **Step 7: Commit**

~~~bash
git add crates/fullmag-runner/src/relaxation crates/fullmag-runner/src/fdm/gpu/cuda
git commit -m "fix(fdm): use physical CUDA minimizer metric"
~~~

---

### Task 7: Make multilayer FDM integrator claims truthful

**Files:**
- Modify: crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs
- Modify: crates/fullmag-runner/src/fdm/gpu/cuda/multilayer/tests.rs
- Modify: crates/fullmag-plan/src/fdm.rs
- Modify: docs/specs/capability-matrix-v0.md
- Modify: docs/specs/capability-matrix-v0.json

**Interfaces:**
- Consumes: requested IntegratorChoice and multilayer RHS.
- Produces: real requested tableau execution or explicit rejection.

- [x] **Step 1: Add one-step tableau tests**

For a deterministic manufactured RHS, assert distinct expected one-step results for Heun, RK4, and RK23. Add planner tests that every advertised method reaches its implementation.

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner multilayer_rk4_executes_rk4_tableau
~~~

Expected: output says running 1 test and the current result equals Heun and
fails the RK4 expectation. Zero executed tests is not RED evidence.

- [x] **Step 3: Implement supported tableaus or narrow capability**

Prefer the shared FDM integrator tableau/stage machinery. If an implementation cannot be completed and qualified in this change, reject that method in planner/capability rather than route it through Heun.

- [x] **Step 4: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner multilayer
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-plan multilayer
~~~

- [x] **Step 5: Commit**

~~~bash
git add crates/fullmag-runner/src/fdm crates/fullmag-plan/src/fdm.rs docs/specs/capability-matrix-v0.md docs/specs/capability-matrix-v0.json
git commit -m "fix(fdm): execute advertised multilayer integrators"
~~~

---

### Task 8: Make native FEM telemetry, legality, and provenance truthful

**Files:**
- Modify: crates/fullmag-runner/src/native_fem.rs
- Modify: crates/fullmag-runner/src/native_fem/tests.rs
- Modify: crates/fullmag-runner/src/relaxation/provenance.rs
- Modify: crates/fullmag-runner/src/artifacts.rs
- Modify: crates/fullmag-runner/src/dispatch.rs
- Modify: backends/fem/cpu/mfem/runtime/stage_completion.cpp
- Modify: backends/fem/cpu/mfem/runtime/step_metrics.cpp
- Modify: backends/fem/gpu/cuda/integrators/rk/rk_step_stats_publication.cpp
- Modify: scripts/validate_fem_relaxation_runtime_log.py

**Interfaces:**
- Consumes: exact native stats/completion and resolved native lane.
- Produces: nonfinite failure, canonical metric IDs, accurate CPU/GPU realization, and aligned artifact validation.

- [x] **Step 1: Add failing wrapper tests**

Assert NaN/Inf/negative native torque returns RunError rather than zero. Assert CPU PG-BB realization differs from CUDA PG-BB realization and native metric ID maps to max_torque_apm.

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner native_fem_nonfinite_torque_is_error
~~~

Expected: output says running 1 test and the current zero substitution fails the
error expectation. Zero executed tests is not RED evidence.

- [x] **Step 3: Reject nonfinite native stats**

Use one checked conversion helper for explicit and direct steps. Preserve exact zero. Apply the same policy to energy, adaptive error, gradient, and solver residual where exported.

- [x] **Step 4: Publish lane-specific realization**

Use stable identifiers such as native_mfem_pgbb and native_cuda_pgbb rather than native_mfem_backend_relax_step for every lane. Update artifact validator expectations.

- [x] **Step 5: Canonicalize completion metrics**

Native C++ emits one metric enum/ID mapping consumed by Rust. Remove casing comparisons distributed across callers.

- [x] **Step 6: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner native_fem
just verify-fem-relaxation-source-contract
~~~

- [x] **Step 7: Commit**

~~~bash
git add crates/fullmag-runner backends/fem/cpu/mfem/runtime backends/fem/gpu/cuda/integrators/rk scripts/validate_fem_relaxation_runtime_log.py
git commit -m "fix(fem): validate relaxation telemetry and provenance"
~~~

---

### Task 9: Repair FEM PG-BB/NCG preconditioner units and gate TPI

**Files:**
- Modify: backends/fem/cpu/mfem/relaxation/relaxation_math.cpp
- Modify: backends/fem/cpu/mfem/relaxation/relaxation_math.hpp
- Modify: backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp
- Modify: backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp
- Modify: backends/fem/cpu/mfem/relaxation/tangent_plane_implicit.cpp
- Modify: backends/fem/src/relaxation_numerics.hpp
- Modify: backends/fem/tests/relaxation_energy_derivative_contract.cpp
- Create: backends/fem/tests/relaxation_operator_contract.cpp
- Modify: backends/fem/tests/relaxation_source_contract.cpp
- Modify: backends/fem/CMakeLists.txt
- Modify: justfile

**Interfaces:**
- Consumes: MFEM Ms mass form, raw A stiffness, nodal materials/weights, tangent frames.
- Produces: dimensionally valid preconditioner operator and manufactured TPI rejection/qualification gate.

- [x] **Step 1: Add an explicit-matrix failing oracle**

Assemble a one-tetrahedron mass matrix M_Ms and exchange stiffness K_A, choose lambda, and assert:

~~~cpp
expected = M_Ms;
expected.Add(lambda * (2.0 / kMu0), K_A);
~~~

Apply both expected and production operators to the same tangent vector. Add a heterogeneous Ms case and local-anisotropy curvature case.

- [x] **Step 2: Verify RED in the managed container**

Add the target to the existing container-backed source-contract recipe, then run:

~~~bash
just verify-fem-time-domain-native-contract
~~~

Expected: relaxation_operator_contract fails because production uses lambda*K_A or volume-only local curvature.

- [x] **Step 3: Repair PG-BB/NCG preconditioner scale**

Build M_Ms + lambda*(2/mu0)*K_A and keep RHS/solution units consistent. Derive clamp units from lambda; remove dimensionless naming and absolute floors that mix units.

- [x] **Step 4: Disable TPI in strict production**

Keep source available for development, but planner/native dispatch rejects strict production before executing it. Extended CPU execution remains explicitly development-only.

- [x] **Step 5: Repair or quarantine incomplete TPI blocks**

Use Ms-weighted local curvature and the same energy Hessian convention for implemented blocks. Any block without a passing manufactured action test stays disabled and is named in the diagnostic.

- [ ] **Step 6: Verify GREEN and managed FEM gates**

~~~bash
just verify-fem-time-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
~~~

Expected: operator oracle passes; strict TPI is rejected/omitted as documented; production algorithms pass.

- [x] **Step 7: Commit**

~~~bash
git add backends/fem/cpu/mfem/relaxation backends/fem/src/relaxation_numerics.hpp backends/fem/tests backends/fem/CMakeLists.txt justfile
git commit -m "fix(fem): correct minimizer operator units"
~~~

---

### Task 10: Expose the canonical contract through OpenAPI v2

**Files:**
- Modify: crates/fullmag-api/src/schemas/commands.rs
- Modify: crates/fullmag-api/src/schemas/runtime.rs
- Modify: crates/fullmag-api/src/schemas/domain.rs
- Modify: crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs
- Modify: crates/fullmag-api/src/router_v2/handlers/data/tables.rs
- Modify: crates/fullmag-api/src/openapi_v2.rs
- Modify: crates/fullmag-api/src/router_v2/tests.rs
- Generate: apps/control-room/src/kernel/api/generated/**

**Interfaces:**
- Consumes: typed IR algorithm, capability, completion, and metric.
- Produces: typed relax command/resource schema and generated TypeScript.

- [x] **Step 1: Add failing API schema tests**

Assert OpenAPI contains enums for relaxation algorithm, stage stop reason, and stage metric kind; Relax command contains max_relaxation_time_s and algorithm-appropriate controls; stage metric contains unit and converged.

- [x] **Step 2: Verify RED**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-api openapi_relaxation_contract_is_typed
~~~

Expected: output says running 1 test and the missing typed schema fails the
assertion. Zero executed tests is not RED evidence.

- [x] **Step 3: Replace ambiguous strings and max_torque**

Use typed schema wrappers. Keep max_torque_Apm and max_torque_T explicit. Deprecate ambiguous max_torque and ensure tables/status never assign it conflicting units.

- [x] **Step 4: Align converged semantics**

Set converged from completion.converged, not latest.finished. Preserve terminal status independently.

- [x] **Step 5: Regenerate frontend API**

~~~bash
pnpm --dir apps/control-room generate:api
git diff --check
~~~

Expected: generated TS includes typed relaxation and metric contracts.

- [x] **Step 6: Verify GREEN**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-api
pnpm --dir apps/control-room check:api-hygiene
~~~

- [x] **Step 7: Commit**

~~~bash
git add crates/fullmag-api apps/control-room/src/kernel/api/generated
git commit -m "feat(api): type relaxation runtime contract"
~~~

---

### Task 11: Repair Control Room authoring and inspector behavior

**Files:**
- Modify: apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts
- Modify: apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts
- Modify: apps/control-room/src/modules/inspector/panels/StudyPipelineSection.tsx
- Modify: apps/control-room/src/modules/inspector/panels/stages/RelaxStageInspector.tsx
- Modify: apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.ts
- Modify: apps/control-room/src/modules/inspector/panels/StudyInspectorPanelModel.test.ts
- Modify: apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts
- Modify: apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.test.ts
- Modify: apps/control-room/src/shared/domain/physics/torqueUnits.ts
- Modify: apps/control-room/src/shared/domain/physics/torqueUnits.test.ts
- Modify: apps/control-room/src/kernel/resources/studyRuntimeResources.ts

**Interfaces:**
- Consumes: generated typed API/capability/defaults and canonical scene/script shape.
- Produces: algorithm-conditional drafts, capability-gated choices, exact units, and truthful completion UI.

- [ ] **Step 1: Replace contract-drift tests with failing canonical assertions**

Add assertions:

~~~typescript
it("uses canonical relaxation defaults", () => {
  expect(createDefaultStudyStageDraft()).toMatchObject({
    torqueTolerance: "0.0001",
    maxSteps: "50000",
  });
});

it("removes LLG-only fields when changing to a direct minimizer", () => {
  const stage = studyStageDraftToSceneStage({
    ...createDefaultStudyStageDraft(),
    algorithm: "projected_gradient_bb",
  });
  expect(stage).not.toHaveProperty("integrator");
  expect(stage).not.toHaveProperty("fixed_timestep");
  expect(stage).not.toHaveProperty("relax_alpha");
  expect(stage).not.toHaveProperty("max_relaxation_time_s");
});
~~~

Also test no Euler option, capability-hidden TPI, canonical demag_interval_s round-trip, explicit failure rendering, and max_torque_apm unit formatting.

- [ ] **Step 2: Verify RED**

~~~bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/StudyStageAuthoringModel.test.ts src/modules/inspector/panels/StudyInspectorPanelModel.test.ts src/kernel/runtime/studyRuntimeCommandContributions.test.ts
~~~

Expected: current 1e-6/7.96 A/m defaults, unconditional fields, or metric casing fails.

- [ ] **Step 3: Use one canonical draft shape**

Represent maxRelaxationTime only for LLG. On algorithm change, clear inapplicable fields transactionally. Serialize canonical torque_tolerance_apm, energy_tolerance_j, max_steps, max_relaxation_time_s, integrator/fixed/adaptive fields, and demag_interval_s.

- [ ] **Step 4: Gate algorithm and integrator controls**

Read runtime capability through the existing resource hook/domain adapter. Do not branch into separate FDM/FEM panels. Remove Euler. Unsupported options show the backend reason and cannot be submitted.

- [ ] **Step 5: Render exact runtime truth**

Display A/m and T torque pair, energy plateau J, accepted step m/A, steps, terminal status, converged, stop reason, fallback/development warning, and failed backend diagnostics distinctly.

- [ ] **Step 6: Verify focused and full frontend gates**

~~~bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
~~~

Expected: zero TypeScript errors, zero lint warnings, and all tests pass.

- [ ] **Step 7: Browser smoke**

Run the repository Control Room launcher and Playwright/browser smoke. Verify:

1. LLG shows integrator/time fields.
2. PG-BB/NCG hide them.
3. TPI is unavailable in strict mode.
4. submitted JSON is canonical.
5. completed and failed stages show correct torque units and reasons.

- [ ] **Step 8: Commit**

~~~bash
git add apps/control-room
git commit -m "fix(control-room): align relaxation inspector contract"
~~~

---

### Task 12: Reconcile capabilities, architecture, and legacy documentation

**Files:**
- Modify: docs/physics/0500-fdm-relaxation-algorithms.md
- Modify: docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md
- Modify: docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md
- Modify: docs/architecture/backend-golden-masterplan.md
- Modify: docs/specs/problem-ir-v0.md
- Modify: docs/specs/problem-ir-compatibility-v1.md
- Modify: docs/specs/capability-matrix-v0.md
- Modify: docs/specs/capability-matrix-v0.json
- Modify: docs/specs/resource-first-control-room-api-v2.md
- Create: scripts/check_relaxation_contract_docs.py
- Create: scripts/test_check_relaxation_contract_docs.py

**Interfaces:**
- Consumes: verified current implementation and generated API.
- Produces: no contradictory defaults, units, capability, or maturity claims.

- [ ] **Step 1: Add a documentation contract scan**

Create scripts/check_relaxation_contract_docs.py with a pure
check_relaxation_contract_docs(repo_root: Path) -> list[str] function and a CLI
that exits nonzero while printing every stale claim. Create unittest coverage
in scripts/test_check_relaxation_contract_docs.py. The checker rejects:

- direct-minimizer lambda described as dimensionless or seconds;
- default torque other than 1e-4 A/m;
- TPI described as strict-production or GPU-executable;
- max_torque described without A/m/T distinction;
- direct minimizers described as using RK.

- [ ] **Step 2: Verify RED**

Run:

~~~bash
python3 -m unittest -v scripts.test_check_relaxation_contract_docs
python3 scripts/check_relaxation_contract_docs.py
~~~

Expected: the unit test passes and the CLI fails while identifying current
conflicting lines in 0500/0510/0530/capability matrix.

- [ ] **Step 3: Update docs from verified implementation**

Preserve historical context only when labeled. Link all three older notes to 0580 as canonical where they retain backend-specific detail.

- [ ] **Step 4: Verify GREEN**

~~~bash
git diff --check -- docs
python3 -m unittest -v scripts.test_check_relaxation_contract_docs
python3 scripts/check_relaxation_contract_docs.py
rg -n 'lambda.*dimensionless|line-search.*pseudo.?time.*s|1e-6 A/m|7\.9.*A/m' docs/physics/0500-fdm-relaxation-algorithms.md docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md
~~~

Expected: unit test and CLI pass and no stale canonical claims remain.

- [ ] **Step 5: Commit**

~~~bash
git add docs/physics docs/architecture/backend-golden-masterplan.md docs/specs scripts/check_relaxation_contract_docs.py scripts/test_check_relaxation_contract_docs.py
git commit -m "docs: reconcile relaxation capability and units"
~~~

---

### Task 13: Run full qualification and completion audit

**Files:**
- Modify only if a gate exposes a defect directly in scope.
- Produce: command logs/artifacts under repository-owned validation locations.

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: fresh requirement-by-requirement evidence for completion.

- [ ] **Step 1: Python and semantic spine**

~~~bash
PYTHONPATH=packages/fullmag-py/src python3 -m unittest discover -s packages/fullmag-py/tests -p 'test_*.py'
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-ir
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-plan
~~~

- [ ] **Step 2: Rust runtime/API**

~~~bash
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-engine
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-runner
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-cli
CARGO_TARGET_DIR=.fullmag/codex-target cargo test -p fullmag-api
~~~

- [ ] **Step 3: Managed FEM proof**

Inspect current recipe bodies, then run:

~~~bash
just rebuild-fem-runtime
just verify-fem-time-domain-native-contract
just verify-fem-relaxation-runtime
just verify-fem-relaxation-convergence
just verify-fem-relaxation-cpu-gpu-consistency-smoke
just verify-fem-relaxation-production-benchmark
~~~

Expected: every production LLG/PG-BB/NCG lane passes; TPI has the documented explicit development rejection or passes only its separate development gate.

- [ ] **Step 4: Frontend**

~~~bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
~~~

- [ ] **Step 5: Physics acceptance matrix**

For each algorithm and lane record:

~~~text
algorithm | discretization | device | precision | legal interactions |
exact torque | energy derivative | accepted-state normalization |
stop reason | convergence | failure behavior | provenance | runtime gate
~~~

No row may rely only on compilation or a source-string test.

- [ ] **Step 6: Working-tree and diff audit**

~~~bash
git status --short
git diff --check
git diff --stat
git log --oneline --decorate -15
~~~

Confirm every changed line traces to the approved contract and no pre-existing user change was overwritten.

- [ ] **Step 7: Request code review**

Use google-eng-review-practices and requesting-code-review. Resolve every P0/P1 finding, rerun affected gates, and retain exact evidence.

- [ ] **Step 8: Complete the goal only after the checklist is proven**

Re-read the user objective, physics note completeness checklist, this plan, and all named validation gates. Mark the goal complete only when every required row is proven and no deferred item is falsely included in the requested scope.
