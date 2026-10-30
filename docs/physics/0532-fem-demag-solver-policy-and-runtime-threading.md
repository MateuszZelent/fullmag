# FEM demag solver policy and runtime CPU threading

- Status: source contract documented; runtime qualification not verified by this note
- Owners: Fullmag FEM/runtime
- Last updated: 2026-10-30
- Source-map review base: `e17b78ae0e841344a160a02ec7517b0d3b4d4515`
- Related notes: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`, `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`, `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

The earlier contract text and historical investigation updates remain available in the [pinned pre-reorganization revision](https://github.com/MateuszZelent/fullmag/blob/3967f03ba78323827712df99f7de020a2a16ff5b/docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md). Current implementation contracts are organized below; numerical qualification continues under `docs/superpowers/plans/2026-10-26-eigensolve-integration-mode-ui.md`.

(problem-statement)=
## Scope and problem statement

This page specifies two separate authoring contracts: the optional FEM Poisson-demagnetization linear-solver policy, and requested CPU-thread selection for a study. The policy selects numerical solver settings for FEM Poisson demag; it does not change magnetostatic equations or configure the LLG stopping budget.

The policy is represented in FEM hints and executable plans. It is not an FDM policy, a modal eigen `solver_policy`, or the shifted KSP policy used by dynamic Floquet solves. Thread selection records requested runtime intent; the effective Rayon/control-plane and native OpenMP counts are resolved separately and may differ.

The source and tests cited here establish implementation contracts. They do not establish that a particular runtime, device, mesh, or scientific benchmark has passed qualification.

(governing-equations)=
## Governing equations

For magnetostatics without free current, the demagnetizing field is curl-free and satisfies `div(H_d + M) = 0`. In a scalar-potential formulation, `H_d = -grad(u)` gives the Poisson equation below. The equation is stated on the computational FEM domain `D`; its outer boundary treatment is a separate approximation or coupling and is not fixed by the solver policy.

```{math}
:label: eq-fem-demag-poisson
\nabla \times \mathbf{H}_{\mathrm{d}} = \mathbf{0}, \qquad
\nabla \cdot (\mathbf{H}_{\mathrm{d}} + \mathbf{M}) = 0, \qquad
\mathbf{H}_{\mathrm{d}} = -\nabla u, \qquad
\Delta u = \nabla \cdot \mathbf{M} \quad \text{in } D.
```

Here `M` is zero in nonmagnetic air elements of a shared domain. For the unscaled scalar-potential weak system, the absolute algebraic residual has units of `A m`; it is not a field-error tolerance in `A/m`. The FEM realization supplies its chosen outer boundary operator and constraints. A finite airbox boundary is not equivalent to the exact condition at infinity.

(symbols-and-si-units)=
## Symbols and SI units

| LaTeX symbol | Meaning | SI unit | Scope |
|---|---|---|---|
| $\mathbf{M}$ | Magnetization in the magnetic region; zero in nonmagnetic air | $\mathrm{A\,m^{-1}}$ | Physical field in the Poisson source |
| $\mathbf{H}_{\mathrm{d}}$ | Demagnetizing field | $\mathrm{A\,m^{-1}}$ | Physical field recovered from the potential |
| $u$ | Magnetic scalar potential | $\mathrm{A}$ | Potential used by the scalar Poisson formulation |
| $D$ | Computational FEM domain | $\mathrm{m}$ | Spatial domain; its boundary treatment is realization-specific |
| $\varepsilon_{\mathrm{rel}}$ | `rtol`, a relative linear-solver tolerance | $1$ | Dimensionless solver control |
| $\varepsilon_{\mathrm{abs}}$ | `atol`, an optional absolute algebraic residual threshold | $\mathrm{A\,m}$ | Residual units for the unscaled weak form; not a physical-field tolerance |
| $N_{\mathrm{iter}}$ | `max_iterations`, the linear-solver iteration cap | $1$ | Count, not a convergence result |
| $N_{\mathrm{LLG}}$ | Generated bias-sample relaxation step cap | $1$ | Internal eigen sample control, separate from Poisson iterations |
| $n_{\mathrm{CPU}}$ | Requested CPU thread count | $1$ | Runtime selection intent, not an observed effective count |

(assumptions-and-validity)=
## Assumptions and validity

- The policy described here is a numerical backend hint for native FEM Poisson demag. FDM has separate controls.
- `rtol` and a present `atol` must be positive finite values in the Python model. `max_iterations` must be at least one; `print_level` must be non-negative. The solver and preconditioner names must be from the declared choices.
- Backend, boundary realization, and solver/preconditioner compatibility still matter. An authored policy is not proof that a requested combination is executable on a given lane.
- For an unscaled scalar-potential weak form, the residual norm uses the same units as its right-hand side, `A m`. If a realization changes algebraic scaling, the numerical meaning of `atol` follows that realized algebraic residual; it never becomes an `H_d` error bound by itself.
- CPU thread count is requested runtime intent. It does not claim that every numerical kernel uses that exact many threads.
- A value reaching `max_iterations` or `max_steps` is a cap outcome. It does not imply convergence.

(python-api)=
## Python API

The class-based FEM hints and the stage-first study builder expose equivalent FEM Poisson-policy values. The flat `fm.fem_demag_solver(...)` helper and `study.fem_demag_solver(...)` set the policy on the next built study. `fm.threads(...)` and `study.threads(...)` set requested runtime CPU threads.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `fm.FEM(order)` | `int` | required | `1` | Integer at least 1; booleans rejected | FEM finite-element order | FEM only | `discretization.fem.order` |
| `fm.FEM(maximum_element_size) / fm.FEM(hmax)` | `float` | one required | `m` | Positive; if both are passed they must agree | Maximum FEM element size; `hmax` is an alias | FEM only | `discretization.fem.hmax` |
| `fm.FEM(mesh)` | `str or None` | `None` | `1 (identifier)` | Non-blank when provided | Optional named mesh source | FEM only | `discretization.fem.mesh` |
| `fm.FEM(demag_solver_policy)` | `FemLinearSolverPolicy or None` | `None` | `1 (configuration)` | Optional by annotation; the constructor has no explicit type check | Typed policy attached to FEM hints | FEM only | `discretization.fem.demag_solver_policy` |
| `fm.FemLinearSolverPolicy.solver`; `fm.fem_demag_solver(solver=...)`; `study.fem_demag_solver(solver=...)` | `Literal[CG, GMRES]` | `CG` | `1` | `CG` or `GMRES` | Poisson linear-solver method | FEM Poisson only; resolved per backend | `discretization.fem.demag_solver_policy.solver` |
| `fm.FemLinearSolverPolicy.preconditioner`; `fm.fem_demag_solver(preconditioner=...)`; `study.fem_demag_solver(preconditioner=...)` | `Literal[AMG, JACOBI, NONE]` | `AMG` | `1` | `AMG`, `JACOBI`, or `NONE` | Poisson preconditioner choice | FEM Poisson only; resolved per backend | `discretization.fem.demag_solver_policy.preconditioner` |
| `fm.FemLinearSolverPolicy.rtol`; `fm.fem_demag_solver(rtol=...)`; `study.fem_demag_solver(rtol=...)` | `float` | `1e-8` | `1` | Positive finite; no general upper bound in the Python model | Relative linear-solver tolerance | FEM Poisson only; planner may add method-specific constraints | `discretization.fem.demag_solver_policy.rtol` |
| `fm.FemLinearSolverPolicy.atol`; `fm.fem_demag_solver(atol=...)`; `study.fem_demag_solver(atol=...)` | `float or None` | `None` | $\mathrm{A\,m}$ for unscaled weak residual | Positive finite when present | Optional absolute algebraic residual threshold; `None` is omitted from the policy IR | FEM Poisson only; residual scaling is realization-specific | `discretization.fem.demag_solver_policy.atol` |
| `fm.FemLinearSolverPolicy.max_iterations`; `fm.fem_demag_solver(max_iterations=...)`; `study.fem_demag_solver(max_iterations=...)` | `int` | `500` | `1` (iterations) | Annotated int; the Python model checks only value >= 1 | Upper bound on Poisson linear-solver iterations | FEM Poisson only | `discretization.fem.demag_solver_policy.max_iterations` |
| `fm.FemLinearSolverPolicy.print_level`; `fm.fem_demag_solver(print_level=...)`; `study.fem_demag_solver(print_level=...)` | `int` | `0` | `1` (verbosity level) | Annotated int; the Python model checks only value >= 0 | Backend solver diagnostic verbosity | FEM Poisson only | `discretization.fem.demag_solver_policy.print_level` |
| `fm.threads(cpu_threads)`; `study.threads(cpu_threads)` | `int` | required | `1` (threads) | Converted to integer by the flat API and must be at least 1 | Requested runtime CPU threads for the next study/run | Runtime selection; effective counts remain backend-specific | `problem_meta.runtime_metadata.runtime_selection.cpu_threads` |

The strings in this table are API choices, not a promise that every combination is accepted by every device backend. The direct minimizers `projected_gradient_bb` and `nonlinear_cg` have an additional planner rule when FEM demag is enabled: an explicit `rtol` above `1e-12` is rejected; when the policy is omitted, the planner resolves a default policy with `rtol = 1e-12` for that path.

```python
# %% Stage-first FEM example: authored Poisson policy and primary Relax stage
import fullmag as fm

study = fm.study("fem-demag-policy-example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(40e-9, 40e-9, 40e-9), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=10e-9)
body = study.geometry(fm.Box(size=(20e-9, 20e-9, 10e-9), name="film"), name="film")
body.Ms = 800000.0
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.b_ext(0.1, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-8, max_iterations=500)
study.build_domain_mesh()

# %% The top-level stage owns its own LLG stopping controls
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", dt=5e-15, relax_alpha=0.5, max_steps=50000, tolA=1.0)
study.save("magnetization")
```

This is an authoring example, not a run receipt or qualification. The existing `examples/fem_eigen_mode_ui_de_signed15.py` likewise authors a primary `Relax` stage with `max_steps=50000` and `tolA=1.0`; those values are distinct from the generated bias-sample relaxation described below.

(problem-ir)=
## ProblemIR and planner mapping

`FemLinearSolverPolicy` defaults are `CG`, `AMG`, `rtol = 1e-8`, `atol = None`, `max_iterations = 500`, and `print_level = 0`. The Python class omits `atol` from its policy object when it is `None`. The optional policy travels through `FemHintsIR` into executable FEM plans.

For an eigen plan with bias-field samples, `FemEigenPlanIR.demag_solver_policy` carries the authored FEM Poisson policy into the generated static `FemPlanIR` used for each sample relaxation. It configures the Poisson linear solve only. It does not configure the generated LLG controls: that helper retains `max_steps = 8` and `torque_tolerance_apm = 1e-3 A/m`. The planner/runner regression checks policy-field preservation and checks that those LLG values stay unchanged.

This sample-owned demag policy is separate from `FemEigenPlanIR.solver_policy` and from the dynamic Floquet shifted KSP. Modal and Floquet operator choices do not inherit the FEM Poisson hint.

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The requested intent is the authored FEM hint or runtime thread request. Resolved execution is the concrete plan/backend selection and the runtime-reported thread counts, where available. Keep these as distinct values in serialized plans and diagnostics.

Python and IR validation reject invalid solver names, preconditioner names, non-positive tolerances, and invalid iteration/verbosity bounds. Planner-specific restrictions add validation errors for combinations such as an explicit direct-minimizer Poisson `rtol > 1e-12`. Unsupported combinations must remain visible as planning/runtime diagnostics; this page does not assume an automatic fallback.

An eigen equilibrium handoff rejects a stage completion marked `MaxSteps` with `converged = false`. Reaching the primary Relax cap of 50,000 steps in the signed15 authoring example is therefore not itself evidence of an accepted equilibrium. The completion must satisfy the convergence contract before it can be consumed.

When an optional `FemEigenPlanIR.demag_solver_policy` is absent, serde omits it and the existing resolver defaults remain in effect. A present policy is copied into the actual generated bias-relaxation `FemPlanIR`, not only into metadata. These are source and regression-test contracts; this note does not claim the hosted CI or a live solve has passed.

## Runtime thread selection

The Python runtime model serializes `cpu_threads` under `problem_meta.runtime_metadata.runtime_selection.cpu_threads`. The IR validator requires a positive integer when the value is present and rejects conflicts with typed `compute_resources.cpu.threads`. The API request is not a promise that Rayon/control-plane or native OpenMP execution uses the same count. Live mid-run thread-pool retuning is outside this API contract.

(discrete-realization)=
## Discrete FEM and modal realization

The Poisson RHS is assembled from the magnetization field, the selected FEM Poisson operator and boundary conditions are solved by the resolved linear solver, and the potential is differentiated to recover `H_demag`. The policy controls the numerical linear solve, not the FE order, mesh, magnetic region, source, boundary realization, magnetization, or acceptance of an eigen equilibrium.

For linear Poisson solve publication, an iteration cap alone is not convergence. Check the concrete solver result and residual before treating a field as current; the higher-level eigen handoff independently rejects non-converged stage completions. Consult backend diagnostics for actual solver and residual evidence.

The dynamic Floquet shifted KSP is a separate contract. For sparse shared-domain Floquet whose split dimension exceeds the existing exact-Schur limit of 512, the current source default is FGMRES. The small exact-Schur path retains GMRES. Explicit compatible shifted-KSP overrides remain effective. This change preserves the existing tolerances, restart setting, iteration limits, and physical acceptance gates; it does not alter `FemLinearSolverPolicy`.

| Solver/device lane | Policy disposition | Evidence and boundary |
|---|---|---|
| FEM / CPU | Source-documented | FEM Poisson policy is represented in the plan and passed to the CPU Poisson solver path. A source map is not a runtime qualification. |
| FEM / GPU | Source-documented, runtime qualification not asserted | Policy resolution is backend-specific; this page does not claim a GPU execution passed or that all method/preconditioner pairs are supported. |
| FDM / CPU | Not applicable | The hint is FEM-specific; FDM demag configuration has its own policy surface. |
| FDM / GPU | Not applicable | The hint is FEM-specific; FDM demag configuration has its own policy surface. |

(implementation-mapping)=
## Implementation mapping

### FEM policy flow

`FemLinearSolverPolicy` and `FEM` define the Python authoring values. The builder emits those hints into the canonical discretization. `FemHintsIR` carries the optional policy; `plan_fem` and `plan_fem_eigen` resolve it into executable plans. For eigen bias samples, `bias_field_relax_plan` places the same policy into the generated relaxation plan while constructing its independent LLG step and torque limits.

### Shifted modal KSP flow

`solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` selects FGMRES only when the sparse shared-domain split dimension exceeds `kFloquetExactSchurPreconditionerMaxDimension`; this is the existing exact-Schur materialization boundary, not a new threshold. At or below that bound, the small exact-Schur route defaults to GMRES. `resolve_modal_krylov_tuning` preserves explicit values. The focused native regression covers the large sparse default, the small exact-Schur default, an explicit large-case GMRES override, and fail-closed failure behavior.

(validation)=
## Validation and regression evidence

The source-linked regression contracts are:

- Python runtime serialization: `test_problem_runtime_selection_serializes_to_ir`.
- Planner preserves authored policy fields for the eigen bias sample: `fem_eigen_bias_sample_demag_solver_policy_preserves_all_authored_fields`.
- Planner preserves the legacy serialized shape when the optional eigen bias policy is absent: `fem_eigen_bias_sample_none_policy_keeps_legacy_serialized_shape`.
- Runner preserves the Poisson policy without changing the internal LLG sample budget: `bias_field_sample_relax_plan_carries_demag_policy_without_changing_llg_budget`.
- Runner rejects `MaxSteps` completion without convergence: `accepted_relax_stage_handoff_rejects_nonconvergent_and_incoherent_completions`.
- Native modal regression checks sparse FGMRES, the explicit GMRES override, unchanged fail-closed behavior, and the small exact-Schur GMRES route.

No unit test, build, runtime solve, or browser verification was run for this documentation update.

(limitations)=
## Limitations and non-claims

- This document records source contracts and existing test intent; hosted test results and runtime scientific qualification remain separate evidence.
- A configured linear-solver tolerance does not replace independently checked residuals or equilibrium acceptance.
- The bias-sample `max_steps = 8` and `1e-3 A/m` torque threshold are implementation-owned and are not configurable through `FemLinearSolverPolicy`.
- The signed15 example authors a separate top-level `Relax(max_steps=50000, tolA=1.0)`; its source does not establish that a submitted run converged or passed.
- Large sparse Floquet FGMRES selection does not establish a general Krylov improvement or explain any historical residual failure. It is the current source default for the sparse route; acceptance gates remain unchanged.
- FDM and hybrid demag are not configured by this FEM-only policy. No GPU, MPI, performance, or scientific qualification is claimed here.

(scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Interscience, 1963. Foundational continuum micromagnetics reference.
- D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* 26(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
- A. Aharoni, “Micromagnetics and the phenomenological theory of ferromagnets,” *Physical Review B* 40, 4607–4608 (1989), [doi:10.1103/PhysRevB.40.4607](https://doi.org/10.1103/PhysRevB.40.4607).
- Project implementation context: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md` and `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`.

(source-code-index)=
## Source code index

| Source ID | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| py-policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Python policy values, defaults, validation, and `atol=None` omission. |
| py-fem-hints | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FEM` | FEM order, size, mesh, and optional policy authoring. |
| py-study-builder | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Stage-first builder methods for policy and thread intent. |
| py-exports | `packages/fullmag-py/src/fullmag/__init__.py` | `__all__` | Public API export list for `fem_demag_solver`, `threads`, `FEM`, and policy. |
| py-runtime-test | `packages/fullmag-py/tests/test_api.py` | `test_problem_runtime_selection_serializes_to_ir` | Thread selection serializes into runtime-selection IR. |
| py-signed15-example | `examples/fem_eigen_mode_ui_de_signed15.py` | `study` | Authored primary Relax stage values and example provenance. |
| ir-linear-policy | `crates/fullmag-ir/src/study.rs` | `FemLinearSolverPolicy` | Canonical Rust policy defaults and optional absolute tolerance. |
| ir-fem-hints | `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | FEM hint carries the optional Poisson policy. |
| ir-fem-plan | `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | Executable FEM plan stores the resolved Poisson policy. |
| ir-eigen-plan | `crates/fullmag-ir/src/plan.rs` | `FemEigenPlanIR` | Eigen plan carries bias-sample policy separately from modal solver policy. |
| planner-fem | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | Resolves ordinary FEM policy into the executable plan. |
| planner-eigen | `crates/fullmag-plan/src/fem.rs` | `plan_fem_eigen` | Resolves eigen plan policy and method-specific constraints. |
| planner-policy-test | `crates/fullmag-plan/src/tests.rs` | `fem_eigen_bias_sample_demag_solver_policy_preserves_all_authored_fields` | Planner policy-field propagation regression. |
| planner-none-test | `crates/fullmag-plan/src/tests.rs` | `fem_eigen_bias_sample_none_policy_keeps_legacy_serialized_shape` | Optional policy omission compatibility regression. |
| runner-relax-plan | `crates/fullmag-runner/src/fem/eigen_execution.rs` | `bias_field_relax_plan` | Generated sample Relax and Poisson-policy wiring. |
| runner-policy-test | `crates/fullmag-runner/src/fem/eigen_execution.rs` | `bias_field_sample_relax_plan_carries_demag_policy_without_changing_llg_budget` | Verifies policy pass-through and unchanged LLG controls. |
| runner-maxsteps-test | `crates/fullmag-runner/src/fem/eigen_tests.rs` | `accepted_relax_stage_handoff_rejects_nonconvergent_and_incoherent_completions` | Rejects a non-converged `MaxSteps` handoff. |
| poisson-rhs | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | Magnetization-dependent Poisson right-hand side. |
| poisson-solve | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | CPU Hypre solver setup and solve path. |
| poisson-recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | Potential-to-field recovery. |
| floquet-sparse-solve | `backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp` | `solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context` | Large sparse FGMRES versus small exact-Schur GMRES default selection. |
| floquet-ksp-policy | `backends/fem/cpu/frequency_domain/modal_krylov_tuning.hpp` | `resolve_modal_krylov_tuning` | Explicit modal/Floquet KSP tuning resolution. |
| floquet-modal-tests | `backends/fem/tests/frequency_domain/floquet_modal_solver_test.cpp` | `main` | Harness entry point for the large sparse, explicit override, fail-closed, and small exact-Schur cases listed above. |

See the adjacent `0532-fem-demag-solver-policy-and-runtime-threading.source-map.json` for machine-checked path, symbol, equation, and public-parameter mappings.
