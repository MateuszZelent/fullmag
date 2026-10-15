---
title: Eigenmodes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md
---

(public-docs-python-api-studies-eigenmodes)=
# Eigenmodes

(python-api-studies-eigenmodes-problem-statement)=
<!-- (problem-statement)= -->
## 1. Contract and scope

`fm.Eigenmodes` and `study.stages.add_eigenmodes(...)` define the public Python authoring contract
for linearized spin-wave eigenmode studies around a verified micromagnetic equilibrium
$\mathbf m_0(\mathbf x)$. Together with the companion schemas `FemEigenSolverPolicy`, `KPoint`,
`KPath`, `BiasFieldSweep`, and `ModeTracking`, this study type configures single-$\mathbf k$
resonances, Brillouin-zone magnonic dispersion relations $f_n(\mathbf k)$, and static bias-field
ferromagnetic resonance sweeps $f_n(\mathbf B_0)$.

Full mathematical derivations of the tangent-plane projection, coupled $(q,\phi)$ Poisson-airbox
Schur complement, real-split SLEPc shift-and-invert, and consistent-$P_1$ mass-weighted Hungarian
branch tracking are given in {doc}`/numerical-methods/eigensolvers/linearized-llg` and
{doc}`/numerical-methods/eigensolvers/modal-validation`.

(python-api-studies-eigenmodes-governing-equations)=
<!-- (governing-equations)= -->
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
<!-- (symbols-and-si-units)= -->
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
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and validity

* `count` must be a positive integer ($K \ge 1$).
* `target="nearest"` requires a positive `target_frequency` (in $\mathrm{Hz}$).
* `target="frequency_window"` requires both `frequency_min` and `frequency_max` with
  $0 < f_{\min} < f_{\max}$.
* `outputs` must include at least one modal output (`SaveMode`, `SaveSpectrum`, `SaveDispersion`,
  or `SaveEigenDiagnostics`); driven `SaveResponse` outputs are rejected on `Eigenmodes`.

(python-api-studies-eigenmodes-python-api)=
<!-- (python-api)= -->
## 5. Python API and complete parameter reference

### Complete stage-first example

```python
# %% Stage-first FEM modal study with Schur-complement policy and branch tracking
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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.zeeman(field=(5.0e4, 0.0, 0.0))
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=2000, tolT=1e-7)

# %% Add eigenmodes stage with k-path dispersion and mode tracking
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
    spatial_representation="full_3d",
    k_sampling=fm.KPath(
        nodes=[
            ("Gamma", (0.0, 0.0, 0.0)),
            ("X", (3.14159265e7, 0.0, 0.0)),
        ],
        samples_per_segment=12,
    ),
    mode_tracking=fm.ModeTracking(
        method="overlap_hungarian",
        min_overlap=0.6,
        degeneracy_tolerance=1.0e6,
    ),
    fem_solver_policy=fm.FemEigenSolverPolicy(
        backend="slepc_shift_invert_schur",
        subspace_dimension=24,
        max_iterations=250,
        tolerance=1.0e-8,
        shift_Hz=8.0e9,
        target_spectrum="target_magnitude",
    ),
)
```

### `Eigenmodes` parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Eigenmodes.outputs` | `Sequence[EigenOutputSpec]` | `required` | $1$ | At least one; `SaveResponse` is rejected | Mode/spectrum/dispersion/diagnostic outputs | FDM/FEM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Eigenmodes.count` | `int` | `20` | $1$ | Positive | Number of eigenvectors requested | FEM/FDM CPU/GPU | `count` |
| `Eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | Eigenvalue selection policy | FEM/FDM CPU/GPU | `target` |
| `Eigenmodes.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive; required for `nearest` | Frequency target for nearest modes | FEM/FDM CPU/GPU | `target.frequency_hz` |
| `Eigenmodes.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive lower bound; required with `frequency_window` | Lower frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_min_hz` |
| `Eigenmodes.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive upper bound; `min < max`; required with `frequency_window` | Upper frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_max_hz` |
| `Eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM/FDM CPU/GPU | `operator.kind` |
| `Eigenmodes.include_demag` | `bool` | `True` | $1$ | Boolean | Include the dynamic demagnetization term | FEM/FDM CPU/GPU | `operator.include_demag` |
| `Eigenmodes.equilibrium_source` | `str` | `"relax"` (stage entry default) | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM/FDM CPU/GPU | `equilibrium` |
| `Eigenmodes.k_sampling` | `object \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Valid k sampling or k vector | Wave-vector sampling | FEM/FDM CPU/GPU | `k_sampling` |
| `Eigenmodes.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $\mathrm{A\,m^{-1}}$ | Non-empty finite field list | Static bias-field sweep | FEM modal lane | `bias_field_sweep` |
| `Eigenmodes.mode_tracking` | `ModeTracking \| None` | `None` | $1$ | Validated tracking policy | Mass-weighted Hungarian mode tracking | FEM modal runner | `mode_tracking` |
| `Eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | Mode normalization | FEM/FDM CPU/GPU | `normalization` |
| `Eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | `ignore` or `include` | Damping treatment | FEM/FDM CPU/GPU | `damping_policy` |
| `Eigenmodes.spin_wave_bc` | `str \| mapping \| PeriodicBC \| FloquetBC` | `"free"` | $1$ | One of `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy` | Spin-wave boundary condition | FEM/FDM CPU/GPU | `spin_wave_bc` |
| `Eigenmodes.spatial_representation` | `str` | `"full_3d"` | $1$ | `full_3d` or `waveguide_2p5d` | Spatial operator geometry | FEM modal lane | `spatial_representation` |
| `Eigenmodes.fem_solver_policy` | `FemEigenSolverPolicy \| None` | `None` | $1$ | Validated FEM eigensolver policy | Native eigensolver configuration | FEM modal lane | `fem_solver_policy` |

### Companion policy and sampling schemas

| Class | Field | Type | Default | SI unit | Meaning |
| --- | --- | --- | --- | --- | --- |
| `FemEigenSolverPolicy` | `backend` | `str` | `"auto"` | $1$ | `"auto"`, `"slepc_shift_invert_schur"`, `"slepc"`, `"lobpcg_reference"`, or `"dense_reference"` |
| `FemEigenSolverPolicy` | `subspace_dimension` | `int \| None` | `None` | $1$ | Krylov-Schur subspace dimension ($\ge 2$ and $\ge \mathrm{count}$) |
| `FemEigenSolverPolicy` | `max_iterations` | `int` | `200` | $1$ | Maximum outer eigensolver restart cycles |
| `FemEigenSolverPolicy` | `tolerance` | `float` | `1e-8` | $1$ | Relative coupled residual convergence tolerance |
| `FemEigenSolverPolicy` | `shift_Hz` | `float \| None` | `None` | $\mathrm{Hz}$ | Spectral shift frequency $\tau/(2\pi)$ for shift-and-invert |
| `FemEigenSolverPolicy` | `target_spectrum` | `str` | `"smallest_magnitude"` | $1$ | `"smallest_magnitude"` or `"target_magnitude"` |
| `KPoint` | `k` | `tuple[float,float,float]` | `required` | $\mathrm{rad\,m^{-1}}$ | Single Brillouin-zone wave vector $(k_x, k_y, k_z)$ |
| `KPath` | `nodes` | `Sequence[tuple[str, tuple[float,float,float]]]` | `required` | $\mathrm{rad\,m^{-1}}$ | Ordered high-symmetry vertices along the dispersion path |
| `KPath` | `samples_per_segment` | `int \| Sequence[int]` | `16` | $1$ | Number of wave-vector samples per path segment |
| `BiasFieldSweep` | `fields` | `Sequence[tuple[float,float,float]]` | `required` | $\mathrm{A\,m^{-1}}$ | Static external magnetic bias-field samples |
| `ModeTracking` | `method` | `str` | `"overlap_hungarian"` | $1$ | Combinatorial branch assignment algorithm |
| `ModeTracking` | `min_overlap` | `float` | `0.5` | $1$ | Minimum consistent-$P_1$ mass-weighted overlap threshold in $(0, 1]$ |
| `ModeTracking` | `degeneracy_tolerance` | `float` | `1e6` | $\mathrm{Hz}$ | Frequency window for SVD Procrustes degenerate-subspace transport |

(python-api-studies-eigenmodes-problem-ir)=
<!-- (problem-ir)= -->
## 6. ProblemIR

`Eigenmodes.to_ir()` emits `{"kind": "eigenmodes", ...}` with `operator`, `equilibrium`, `target`,
`count`, `k_sampling`, `bias_field_sweep`, `mode_tracking`, `normalization`, `damping_policy`,
`spin_wave_bc`, `spatial_representation`, `fem_solver_policy`, and `sampling`.

(python-api-studies-eigenmodes-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result (`FemEigenPlanIR`). Validation errors identify the violated domain
rule, and unsupported combinations are rejected explicitly rather than silently substituted.

(python-api-studies-eigenmodes-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization

Solver execution follows {doc}`/numerical-methods/eigensolvers/linearized-llg`: `plan_fem_eigen`
resolves `FemEigenPlanIR`, `EigenKProcessPool` isolates PETSc/SLEPc worker processes across
$\mathbf k$-points, `solve_poisson_airbox_modal_eigen_cpu_schur` solves the matrix-free Schur
complement, `evaluate_poisson_airbox_modal_residuals` certifies coupled $(q,\phi)$ residuals, and
`track_branches` / `mass_weighted_subspace_transport` track branches across $\mathbf k$ or bias-field
sweeps.

(python-api-studies-eigenmodes-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Implementation mapping

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Python authoring | `Eigenmodes`, `EigenmodesStageSpec`, `FemEigenSolverPolicy`, `ModeTracking` | Schema validation and `ProblemIR` lowering |
| Rust planner | `plan_fem_eigen` | Capability check and `FemEigenPlanIR` resolution |
| Rust runner | `EigenKProcessPool`, `track_branches`, `mass_weighted_subspace_transport`, `ConsistentP1TrackingMetric` | Multi-process $\mathbf k$-pool and consistent-$P_1$ branch tracking |
| Native C++ solver | `solve_modal_eigen_contract`, `assemble_poisson_airbox_shared_domain`, `solve_poisson_airbox_modal_eigen_cpu_schur`, `evaluate_poisson_airbox_modal_residuals` | Shared-domain $(q,\phi)$ assembly, Schur shift-and-invert, and residual certification |

(python-api-studies-eigenmodes-validation)=
<!-- (validation)= -->
## 10. Validation

Constructor and round-trip tests verify `Eigenmodes`, `FemEigenSolverPolicy`, `KPath`,
`BiasFieldSweep`, and `ModeTracking` serialization, while scientific qualification follows
{doc}`/numerical-methods/eigensolvers/modal-validation`.

(python-api-studies-eigenmodes-limitations)=
<!-- (limitations)= -->
## 11. Limitations

Authoring support is broader than any single backend's resolved modal capability; the planner rejects
unsupported combinations (`plan_fem_eigen`) without silent fallback.

(python-api-studies-eigenmodes-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. C. Herring and C. Kittel, “On the theory of spin waves in ferromagnetic media,” *Physical Review*, 81, 869–880 (1951).
2. M. d'Aquino, C. Serpico, G. Miano, and C. Forestiere, “A novel formulation for the numerical computation of magnetization modes in complex micromagnetic systems,” *Journal of Computational Physics*, 228, 6130–6149 (2009).

(python-api-studies-eigenmodes-source-code-index)=
## 13. Source-code index

### Control Room crosswalk

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add stage -> Eigenmodes` | `partial` | Submit stage draft; stage and downstream result resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add stage -> Eigenmodes` | `not implemented` | Python-only until implemented |

See {doc}`/frontend/capability-register` for the support matrix and not implemented policy.

### Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | [`class Eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | Eigenmode study parameters and IR lowering. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | [`class FemEigenSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | Native FEM eigensolver policy schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | [`coerce_k_sampling`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | Wave-vector sampling normalization. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | [`class EigenmodesStageSpec`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | Stage-first modal request specification. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4633) | [`add_eigenmodes`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4633) | Stage-first authoring entrypoint. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | [`plan_fem_eigen`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | Resolves FemEigenPlanIR and capability gates. |
| [`crates/fullmag-runner/src/eigen/k_process_pool.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | [`EigenKProcessPool`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/k_process_pool.rs#L798) | Multi-process worker pool for k-path dispersion sweeps. |
| [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | [`track_branches`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | Mass-weighted Hungarian branch tracking. |
| [`crates/fullmag-runner/src/eigen/tracking_subspace.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | [`mass_weighted_subspace_transport`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_subspace.rs#L328) | SVD Procrustes degenerate-subspace transport. |
| [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | [`ConsistentP1TrackingMetric`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | Consistent P1 finite-element mass inner product. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | [`solve_modal_eigen_contract`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | Native modal eigensolver contract and diagnostics. |
| [`backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | [`assemble_poisson_airbox_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp#L310) | Shared-domain (q, phi) magnetostatic block assembly. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | [`solve_poisson_airbox_modal_eigen_cpu_schur`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp#L147) | Matrix-free MATSHELL Schur shift-and-invert eigensolver. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | [`evaluate_poisson_airbox_modal_residuals`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | Reconstructs scalar potential and certifies coupled residuals. |
