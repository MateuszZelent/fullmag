---
title: Eigenmodes
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: packages/fullmag-py/src/fullmag/model/study.py, crates/fullmag-plan/src/fem.rs, backends/fem/src/frequency_domain/modal_eigen_solver.cpp
---

(public-docs-python-api-studies-eigenmodes)=
# Eigenmodes

(python-api-studies-eigenmodes-problem-statement)=
## 1. Contract and scope

`fm.Eigenmodes` and `study.stages.add_eigenmodes(...)` define the public Python authoring contract
for linearized spin-wave eigenmode studies around a verified micromagnetic equilibrium
$\mathbf m_0(\mathbf x)$. Together with the companion schemas `fm.FemEigenSolverPolicy`,
`fm.KPoint`, `fm.KPath`, `fm.KVector`, `fm.BiasFieldSweep`, `fm.ModeTracking`, and analytic
validation descriptors (`fm.K0KittelFieldSweepValidation`, `fm.K0KittelFieldSample`,
`fm.ThinFilmDEBVDispersionValidation`, `fm.DispersionValidationScenario`), this study type
configures single-$\mathbf k$ resonances, Brillouin-zone magnonic dispersion relations
$f_n(\mathbf k)$, and static bias-field ferromagnetic resonance sweeps $f_n(\mathbf B_0)$.

Full mathematical derivations of the tangent-plane projection, coupled $(q,\phi)$ Poisson-airbox
Schur complement, exact augmented shift-and-invert (`MUMPS`/`FGMRES` on CPU and guarded `cuDSS` on
GPU), and consistent-$P_1$ mass-weighted Hungarian branch tracking are given in
{doc}`/numerical-methods/eigensolvers/linearized-llg`,
{doc}`/numerical-methods/eigensolvers/modal-validation`, and
{ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(python-api-studies-eigenmodes-governing-equations)=
## 2. Governing equations

The modal study solves the tangent-projected generalized eigenvalue problem around $\mathbf m_0$:

```{math}
:label: eq-python-api-eigenmodes-pencil
\mathsf K\mathbf q = \lambda\mathsf G\mathbf q,
\qquad
\lambda = \sigma + \mathrm i\omega,
\qquad
f = \frac{\omega}{2\pi},
```

where `operator="linearized_llg"` selects the scalar projected $N_m\times N_m$ operator along the
primary tangent axis $\mathbf e_1$, and `operator="full_2x2"` selects the coupled $2N_m\times 2N_m$
Herring–Kittel tangent-plane block pencil in $(\mathbf e_1, \mathbf e_2)$ required for elliptical
precession, coupled Poisson-airbox magnetostatics (`include_demag=True`), and nonzero Bloch wave
vectors ($\mathbf k \neq \mathbf 0$).

(python-api-studies-eigenmodes-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathsf K$ | tangent rate-stiffness dynamic matrix (or $\mathrm{J}$ in energy-Hessian form) | $\mathrm{s^{-1}}$ |
| $\mathsf G$ | damping-modified tangent metric $I - \alpha_{\mathrm{eff}}J$ (or $\mathrm{J\,s}$ in energy-Hessian form) | $1$ |
| $\mathbf q$ | discrete tangent eigenvector | $1$ |
| $\lambda$ | complex eigenvalue | $\mathrm{s^{-1}}$ |
| $\sigma$ | modal growth/decay real part | $\mathrm{s^{-1}}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | eigenfrequency | $\mathrm{Hz}$ |

(python-api-studies-eigenmodes-assumptions-and-validity)=
## 4. Assumptions and validity

* `count` must be a positive integer ($K \ge 1$).
* `target="nearest"` requires a positive `target_frequency` (in $\mathrm{Hz}$).
* `target="frequency_window"` requires both `frequency_min` and `frequency_max` with
  $0 < f_{\min} < f_{\max}$.
* `outputs` must include at least one modal output (`SaveMode`, `SaveSpectrum`, `SaveDispersion`,
  or `SaveEigenDiagnostics`); driven `SaveResponse` outputs are rejected on `Eigenmodes`.
* `magnetostatic_bc="open_airbox_k0"` (used by the guarded FEM GPU `cuDSS` open-airbox eigensolver)
  enforces `include_demag=True`, `spin_wave_bc="free"`, `k_vector=(0.0, 0.0, 0.0)`, and
  `damping_policy="ignore"`.

(python-api-studies-eigenmodes-python-api)=
## 5. Python API and complete parameter reference

### Complete stage-first example

```python
# %% Stage-first FEM modal study with k-path dispersion and solver policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("eigenmodes_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(400 * nm, 150 * nm, 100 * nm))

film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.b_ext(5.0e4 * 4.0e-7 * 3.141592653589793, 0.0, 0.0)
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=2000, tolT=1e-7)

# %% Add eigenmodes stage with k-path sampling and residual/iteration policy
k_path = fm.KPath(
    points=[
        fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
        fm.KPoint("X", (3.14159265e7, 0.0, 0.0)),
    ],
    samples_per_segment=[12],
)
study.stages.add_eigenmodes(
    stage_id="eigen_dispersion",
    count=8,
    target="nearest",
    target_frequency=8.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    magnetostatic_bc="open",
    k_sampling=k_path,
    solver_rtol=1.0e-8,
    solver_max_outer_iterations=250,
    solver_max_linear_iterations=1000,
)

# %% Direct schema verification for ModeTracking and FemEigenSolverPolicy
eigen_spec = fm.Eigenmodes(
    outputs=[fm.SaveSpectrum(), fm.SaveMode(indices=[0, 1]), fm.SaveDispersion()],
    count=8,
    target="nearest",
    target_frequency=8.0e9,
    operator="full_2x2",
    equilibrium_source="relax",
    include_demag=True,
    k_sampling=k_path,
    mode_tracking=fm.ModeTracking(
        method="overlap_hungarian",
        frequency_window_hz=1.0e6,
        overlap_floor=0.6,
        max_branch_gap=1,
    ),
    solver_policy=fm.FemEigenSolverPolicy(
        residual_tolerance=1.0e-8,
        max_outer_iterations=250,
        max_linear_iterations=1000,
    ),
)
assert eigen_spec.to_ir()["kind"] == "eigenmodes"
assert eigen_spec.to_ir()["solver_policy"]["residual_tolerance"] == 1.0e-8
```

### `Eigenmodes` parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Eigenmodes.outputs` | `Sequence[EigenOutputSpec]` | `required` | $1$ | At least one; `SaveResponse` is rejected | Mode/spectrum/dispersion/diagnostic outputs | FEM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Eigenmodes.count` | `int` | `20` | $1$ | Positive integer | Number of eigenvectors requested | FEM CPU/GPU | `count` |
| `Eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | Eigenvalue selection policy | FEM CPU/GPU | `target` |
| `Eigenmodes.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive; required for `nearest` | Frequency target for nearest modes | FEM CPU/GPU | `target.frequency_hz` |
| `Eigenmodes.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive lower bound; required with `frequency_window` | Lower frequency-window bound | FEM CPU/GPU | `target.frequency_min_hz` |
| `Eigenmodes.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive upper bound; `min < max`; required with `frequency_window` | Upper frequency-window bound | FEM CPU/GPU | `target.frequency_max_hz` |
| `Eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM CPU/GPU | `operator.kind` |
| `Eigenmodes.equilibrium_source` | `str` | `"provided"` (`"relax"` in `add_eigenmodes`) | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM CPU/GPU | `equilibrium` |
| `Eigenmodes.equilibrium_artifact` | `str \| None` | `None` | $1$ | Non-empty path/reference required when `equilibrium_source="artifact"` | Equilibrium checkpoint/artifact path | FEM CPU/GPU | `equilibrium.artifact` |
| `Eigenmodes.include_demag` | `bool` | `True` | $1$ | Boolean | Include the dynamic demagnetization term | FEM CPU/GPU | `operator.include_demag` |
| `Eigenmodes.k_sampling` | `object \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | `KPoint`, `KPath`, sequence of `KPoint`, or mapping | Wave-vector sampling schedule | FEM CPU/GPU | `k_sampling` |
| `Eigenmodes.k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Length-3 finite wave vector; mutually exclusive with conflicting `k_sampling` | Single Bloch wave vector | FEM CPU/GPU | `k_sampling` |
| `Eigenmodes.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $\mathrm{A\,m^{-1}}$ | Non-empty finite field list | Static bias-field sweep | FEM modal lane | `bias_field_sweep` |
| `Eigenmodes.mode_tracking` | `ModeTracking \| None` | `None` | $1$ | Validated tracking policy | Mass-weighted Hungarian mode tracking | FEM modal runner | `mode_tracking` |
| `Eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | Mode normalization | FEM CPU/GPU | `normalization` |
| `Eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | `ignore` or `include` | Damping treatment | FEM CPU/GPU | `damping_policy` |
| `Eigenmodes.spin_wave_bc` | `str \| mapping \| PeriodicBC \| FloquetBC` | `"free"` | $1$ | One of `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy` | Spin-wave boundary condition | FEM CPU/GPU | `spin_wave_bc` |
| `Eigenmodes.magnetostatic_bc` | `str` | `"open"` | $1$ | `open`, `periodic_airbox_k0`, `floquet_airbox`, or `open_airbox_k0` | Magnetostatic closure for modal demag (`open_airbox_k0` enables guarded GPU `cuDSS` $k=0$ airbox) | FEM CPU/GPU | `magnetostatic_bc` |
| `Eigenmodes.solver_policy` | `FemEigenSolverPolicy \| None` | `None` | $1$ | Validated `FemEigenSolverPolicy` | Residual and iteration limits for native eigensolver | FEM modal lane | `solver_policy` |
| `Eigenmodes.equilibrium_acceptance` | `str` | `"certified"` | $1$ | Supported equilibrium acceptance policy | Equilibrium certification policy before linearization | FEM modal lane | `equilibrium_acceptance` |
| `Eigenmodes.dynamics` | `LLG` | `LLG()` | mixed | Typed `LLG` dynamics contract (supplies $\gamma_0$) | Gyromagnetic ratio and reference dynamics contract | FEM CPU/GPU | `dynamics` |

### Companion policy and sampling schemas

| Class | Field | Type | Default | SI unit | Meaning |
| --- | --- | --- | --- | --- | --- |
| `FemEigenSolverPolicy` | `residual_tolerance` | `float \| None` | `None` | $1$ | Relative coupled residual convergence tolerance |
| `FemEigenSolverPolicy` | `max_outer_iterations` | `int \| None` | `None` | $1$ | Maximum outer eigensolver restart cycles |
| `FemEigenSolverPolicy` | `max_linear_iterations` | `int \| None` | `None` | $1$ | Maximum inner linear-solver iterations per shift solve |
| `KPoint` | `label` | `str \| None` | `required` | $1$ | Optional high-symmetry label (e.g. `"Gamma"`, `"X"`) |
| `KPoint` | `k` | `KVector` | `required` | $\mathrm{rad\,m^{-1}}$ | Single Brillouin-zone wave vector $(k_x, k_y, k_z)$ |
| `KPath` | `points` | `Sequence[KPoint]` | `required` | $\mathrm{rad\,m^{-1}}$ | Ordered high-symmetry vertices along the dispersion path |
| `KPath` | `samples_per_segment` | `Sequence[int]` | `required` | $1$ | Number of wave-vector samples per path segment |
| `KPath` | `closed` | `bool` | `False` | $1$ | Whether to close the loop from last vertex back to first |
| `BiasFieldSweep` | `fields` | `Sequence[tuple[float, float, float]]` | `required` | $\mathrm{A\,m^{-1}}$ | Static external magnetic bias-field samples |
| `ModeTracking` | `method` | `str` | `"overlap_hungarian"` | $1$ | Combinatorial branch assignment algorithm |
| `ModeTracking` | `frequency_window_hz` | `float \| None` | `None` | $\mathrm{Hz}$ | Frequency window for candidate branch matching and degenerate transport |
| `ModeTracking` | `overlap_floor` | `float` | `0.5` | $1$ | Minimum consistent-$P_1$ mass-weighted overlap threshold in $(0, 1]$ |
| `ModeTracking` | `max_branch_gap` | `int` | `1` | $1$ | Maximum consecutive sample steps a branch may be unmatched before terminating |

(python-api-studies-eigenmodes-problem-ir)=
## 6. ProblemIR

`Eigenmodes.to_ir()` emits `{"kind": "eigenmodes", ...}` with `dynamics`, `operator`, `count`,
`target`, `equilibrium`, `k_sampling`, `normalization`, `damping_policy`, `spin_wave_bc`,
`magnetostatic_bc`, `sampling`, and optional `bias_field_sweep`, `mode_tracking`, `solver_policy`,
and `equilibrium_acceptance`.

(python-api-studies-eigenmodes-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result (`FemEigenPlanIR`). Validation errors identify the violated domain
rule (including `open_airbox_k0` preconditions), and unsupported combinations are rejected explicitly
rather than silently substituted.

(python-api-studies-eigenmodes-discrete-realization)=
## 8. Discrete realization

Solver execution follows {doc}`/numerical-methods/eigensolvers/linearized-llg` and
{ref}`numerical-methods-performance-fem-spectral-multiphysics`: `plan_fem_eigen` resolves
`FemEigenPlanIR`, `EigenKProcessPool` isolates PETSc/SLEPc worker processes across $\mathbf k$-points,
CPU shift-and-invert uses exact augmented `(q, phi)` MUMPS/FGMRES or Schur-MatShell solves, GPU
supports guarded `cuDSS` augmented shift-and-invert with VRAM preflight for `open_airbox_k0` and
single-$k$ `floquet_airbox`, `evaluate_poisson_airbox_modal_residuals` certifies coupled
$(q,\phi)$ residuals, and `track_branches` / `mass_weighted_subspace_transport` track branches across
$\mathbf k$ or bias-field sweeps.

(python-api-studies-eigenmodes-implementation-mapping)=
## 9. Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Shared-domain $(q,\phi)$ PETSc/SLEPc augmented MUMPS/FGMRES & Schur shift-invert, $k$-pool, and consistent-$P_1$ tracking. |
| FEM | GPU | `partial` | Guarded `cuDSS` augmented shift-invert for `open_airbox_k0` and single-$k$ `floquet_airbox` with VRAM preflight and inertia cache. |
| FDM | CPU | `unsupported` | Native linearized modal eigensolve is FEM-only; planner rejects FDM modal requests. |
| FDM | GPU | `unsupported` | Native linearized modal eigensolve is FEM-only; planner rejects FDM GPU modal requests. |

(python-api-studies-eigenmodes-validation)=
## 10. Validation

Constructor and round-trip tests verify `Eigenmodes`, `FemEigenSolverPolicy`, `KPath`,
`BiasFieldSweep`, and `ModeTracking` serialization, while scientific qualification follows
{doc}`/numerical-methods/eigensolvers/modal-validation`.

(python-api-studies-eigenmodes-limitations)=
## 11. Limitations

Authoring support is broader than any single backend's resolved modal capability; the planner rejects
unsupported combinations (`plan_fem_eigen`) without silent fallback.

(python-api-studies-eigenmodes-scientific-bibliography)=
## 12. Scientific bibliography

1. C. Herring and C. Kittel, “On the theory of spin waves in ferromagnetic media,” *Physical Review*, 81, 869–880 (1951).
2. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational Physics*, 228, 6130–6149 (2009).

## Control Room support

Status: Eigenmode stage creation, dispersion inspection, and 3D spatial mode playback are `partial`; low-level `FemEigenSolverPolicy` iteration/residual tuning and arbitrary $k$-path builders without matching fields remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Stage mode count, shift/target, & basic $k$-sampling | `Model Explorer -> Stages -> Add stage -> Eigenmodes` (`EigenmodesStageSpec`, `StudyStagesSpec`) | `partial` | Submit stage draft and trigger stage compute; downstream result resources are invalidated |
| Tracked $\omega(k)$ dispersion plot & branch table | `Analysis Plots` (`EigenDispersionInspectorPanel`, `FrequencyDomainDispersionChart`, `FrequencyDomainBranchTable`) | `inspection-only` | Selecting a dispersion point or branch synchronizes explorer, inspector, and 3D target |
| Spatial eigenmode profile, phase slider ($0\text{–}2\pi$), & complex projection | `3D Viewport` + `ModeVisualizationInspectorPanel` (`real`, `imag`, `magnitude`, `phase_rotated_real`) | `inspection-only` | UI visualization commands (`analysis.eigen.set-mode-3d-phase`); visual playback rate does not alter physical eigenfrequencies |
| Advanced `FemEigenSolverPolicy` / Bloch parameters without UI fields | `Model Explorer -> Stages -> Add stage -> Eigenmodes` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Control Room eigenmode dispersion plot and branch table alongside inspection readouts
:align: center
:width: 100%
```

```{image} /_static/images/ui/viewport-3d-eigenmode-spatial-profile.png
:alt: 3D spatial eigenmode profile rendered via ModeVisualizationInspectorPanel with phase projection controls
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register`, {doc}`/frontend/inspectors/studies-and-stages`, and {doc}`/frontend/inspectors/analysis-and-frequency-domain`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/stages/EigenmodesStageSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx`, `EigenDispersionInspectorPanel`, and `ModeVisualizationInspectorPanel`.

(python-api-studies-eigenmodes-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
| --- | --- | --- |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1159) | [`class Eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1159) | Eigenmode study parameters and IR lowering. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L184) | [`class FemEigenSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L184) | Native FEM eigensolver policy schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | [`coerce_k_sampling`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | Wave-vector sampling normalization. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3081) | [`class EigenmodesStageSpec`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3081) | Stage-first modal request specification. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5070) | [`add_eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5070) | Stage-first authoring entrypoint. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L6107) | [`plan_fem_eigen`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L6107) | Resolves `FemEigenPlanIR` and capability gates. |
| [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | [`EigenKProcessPool`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | Multi-process worker pool for k-path dispersion sweeps. |
| [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) | [`track_branches`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) | Mass-weighted Hungarian branch tracking. |
| [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | [`mass_weighted_subspace_transport`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | SVD Procrustes degenerate-subspace transport. |
| [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | [`ConsistentP1TrackingMetric`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | Consistent P1 finite-element mass inner product. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2352) | [`solve_modal_eigen_contract`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2352) | Native modal eigensolver contract and diagnostics. |
| [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | [`assemble_poisson_airbox_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | Shared-domain (q, phi) magnetostatic block assembly. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | [`solve_poisson_airbox_modal_eigen_cpu_schur`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | Matrix-free MATSHELL Schur shift-and-invert eigensolver. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L676) | [`evaluate_poisson_airbox_modal_residuals`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L676) | Reconstructs scalar potential and certifies coupled residuals. |
