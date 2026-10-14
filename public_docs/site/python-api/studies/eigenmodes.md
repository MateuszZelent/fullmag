---
title: Eigenmodes
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: eigenmodes.source-map.json and reviewed source revision 5e99782acbb7fb3f65d0cad872e102bf67733103
---

(public-docs-python-api-studies-eigenmodes)=
# Eigenmodes

(python-api-studies-eigenmodes-problem-statement)=
<!-- (problem-statement)= -->
## 1. Physical problem and authoring contract

This page documents the public Python authoring contract and canonical `ProblemIR` lowering for the
spin-wave eigenmode study type (`Eigenmodes`, `EigenmodesStageSpec`, `FemEigenSolverPolicy`,
`KPoint`, `KPath`, `BiasFieldSweep`, and `ModeTracking`). The complete operator mathematics,
tangent-frame projection, coupled magnetostatic Schur-complement formulation, and modal
qualification gates are owned by {doc}`../../numerical-methods/eigensolvers/index` and
{doc}`../../numerical-methods/eigensolvers/linearized-llg`.

(python-api-studies-eigenmodes-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

An `eigenmodes` stage linearizes the enabled effective-field operator about a static equilibrium
$\mathbf m_0(\mathbf r)$ ($|\mathbf m_0| = 1$, $\mathbf m_0\times\mathbf H_{\mathrm{eff}}[\mathbf m_0] = \mathbf 0$),
projects small perturbations $\delta\mathbf m = T\mathbf q$ onto the local two-component tangent
frame $(\mathbf e_1, \mathbf e_2)$, and solves the generalized eigenvalue problem:

```{math}
:label: eq-python-api-eigenmodes-pencil
\mathsf K\mathbf q = \lambda\mathsf G\mathbf q,
\qquad
\lambda = \sigma + \mathrm i\omega,
\qquad
f = \frac{|\omega|}{2\pi}.
```

The implemented operator identifiers are `"linearized_llg"` (canonical projected tangent operator)
and `"full_2x2"` (explicit $2\times 2$ Herring–Kittel nodal block structure).

(python-api-studies-eigenmodes-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathsf K$ | tangent stiffness/dynamic matrix | problem-dependent |
| $\mathsf G$ | gyrotropic mass/operator matrix | problem-dependent |
| $\mathbf q$ | discrete tangent eigenvector | $1$ |
| $\lambda$ | complex eigenvalue | $\mathrm{s^{-1}}$ |
| $\sigma$ | modal growth/decay real part | $\mathrm{s^{-1}}$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | eigenfrequency | $\mathrm{Hz}$ |

(python-api-studies-eigenmodes-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions, boundary meaning, and validity limits

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `equilibrium_source="relax"` | Consumes the converged equilibrium state from the preceding `relax` stage after checking the R4 torque gate. | It does not accept a relaxation stage that stopped only because `max_steps` was reached. |
| `target="lowest"` vs `"nearest"` vs `"frequency_window"` | Selects lowest positive frequencies, modes nearest `target_frequency`, or modes inside `[frequency_min, frequency_max]`. | Target selection is not a convergence criterion; returned modes must still satisfy the coupled residual tolerance. |
| `damping_policy="ignore"` vs `"include"` | Controls whether Gilbert damping $\alpha$ enters the linearized operator $B_\alpha = I + \alpha J$. | The two policies define different eigenproblems and cannot be compared as CPU/GPU parity runs. |
| `spatial_representation="full_3d"` vs `"waveguide_2p5d"` | Selects full 3D unit-cell Bloch operators or 2.5D cross-sectional waveguide operators with shifted gradient $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf e}_\parallel$. | `waveguide_2p5d` requires translational invariance along the propagation axis. |

(python-api-studies-eigenmodes-python-api)=
<!-- (python-api)= -->
## 5. Python API and complete parameter reference

### Executable stage workflow

```python
# %% Spin-wave eigenmodes and k-path dispersion about a relaxed equilibrium
import fullmag as fm

nm = 1.0e-9

# %% Study and FEM execution lane
study = fm.study("eigenmodes_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

# %% Geometry, material, initial state, and interactions
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.demag(model="airbox", variant="robin")

# %% Relax to equilibrium, then solve for the lowest modes along a k-path
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=2000, tolT=1e-6)
study.stages.add_eigenmodes(
    stage_id="eigen",
    count=8,
    target="lowest",
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (1.0e7, 0.0, 0.0)),
        ],
        samples_per_segment=[4],
    ),
    solver_rtol=1.0e-8,
    solver_max_outer_iterations=400,
    solver_max_linear_iterations=200,
)
```

### `Eigenmodes` and `EigenmodesStageSpec` parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Eigenmodes.outputs` | `Sequence[EigenOutputSpec]` | `required` | $1$ | At least one; `SaveResponse` is rejected | Mode/spectrum/dispersion/diagnostic outputs | FDM/FEM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `Eigenmodes.count` | `int` | `20` | $1$ | Positive | Number of eigenvectors requested | FEM/FDM CPU/GPU | `count` |
| `Eigenmodes.target` | `str` | `"lowest"` | $1$ | `lowest`, `nearest`, or `frequency_window` | Eigenvalue selection policy | FEM/FDM CPU/GPU | `target` |
| `Eigenmodes.target_frequency` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive; required for `nearest` | Frequency target for nearest modes | FEM/FDM CPU/GPU | `target.frequency_hz` |
| `Eigenmodes.frequency_min` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive lower bound; required with `frequency_window` | Lower frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_min_hz` |
| `Eigenmodes.frequency_max` | `float \| None` | `None` | $\mathrm{Hz}$ | Positive upper bound; `min < max`; required with `frequency_window` | Upper frequency-window bound | FEM/FDM CPU/GPU | `target.frequency_max_hz` |
| `Eigenmodes.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM/FDM CPU/GPU | `operator.kind` |
| `Eigenmodes.include_demag` | `bool` | `True` | $1$ | Boolean | Include the dynamic demagnetization term | FEM/FDM CPU/GPU | `operator.include_demag` |
| `Eigenmodes.equilibrium_source` | `str` | `"relax"` (stage entry default) | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM/FDM CPU/GPU | `equilibrium` |
| `Eigenmodes.k_sampling` | `object \| None` | `None` | $\mathrm{m^{-1}}$ | Valid k sampling or k vector | Wave-vector sampling | FEM/FDM CPU/GPU | `k_sampling` |
| `Eigenmodes.bias_field_sweep` | `BiasFieldSweep \| None` | `None` | $\mathrm{A\,m^{-1}}$ | Non-empty finite field list | Static bias-field sweep | FEM modal lane | `bias_field_sweep` |
| `Eigenmodes.mode_tracking` | `ModeTracking \| None` | `None` | $1$ | Validated tracking policy | Mass-weighted Hungarian mode tracking | FEM modal runner | `mode_tracking` |
| `Eigenmodes.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | Mode normalization | FEM/FDM CPU/GPU | `normalization` |
| `Eigenmodes.damping_policy` | `str` | `"ignore"` | $1$ | `ignore` or `include` | Damping treatment | FEM/FDM CPU/GPU | `damping_policy` |
| `Eigenmodes.spin_wave_bc` | `str \| mapping \| PeriodicBC \| FloquetBC` | `"free"` | $1$ | One of `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy` | Spin-wave boundary condition | FEM/FDM CPU/GPU | `spin_wave_bc` |
| `Eigenmodes.spatial_representation` | `str` | `"full_3d"` | $1$ | `full_3d` or `waveguide_2p5d` | Spatial operator geometry | FEM modal lane | `spatial_representation` |
| `Eigenmodes.fem_solver_policy` | `FemEigenSolverPolicy \| None` | `None` | $1$ | Validated FEM eigensolver policy | Native eigensolver configuration | FEM modal lane | `fem_solver_policy` |

### `FemEigenSolverPolicy`, `KPath`, `BiasFieldSweep`, and `ModeTracking` parameters

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FemEigenSolverPolicy.backend` | `str` | `"auto"` | $1$ | `auto`, `slepc_shift_invert_schur`, `slepc`, `lobpcg_reference`, or `dense_reference` | Native eigensolver backend | FEM modal lane | `fem_solver_policy.backend` |
| `FemEigenSolverPolicy.subspace_dimension` | `int \| None` | `None` | $1$ | Integer $\ge 2$ and $\ge \mathrm{count}$ | Krylov subspace dimension | FEM modal lane | `fem_solver_policy.subspace_dimension` |
| `FemEigenSolverPolicy.max_iterations` | `int` | `200` | $1$ | Positive integer | Maximum outer eigensolver iterations | FEM modal lane | `fem_solver_policy.max_iterations` |
| `FemEigenSolverPolicy.tolerance` | `float` | `1e-8` | $1$ | Finite positive float | Relative eigenpair residual tolerance | FEM modal lane | `fem_solver_policy.tolerance` |
| `FemEigenSolverPolicy.shift_Hz` | `float \| None` | `None` | $\mathrm{Hz}$ | Finite nonnegative float | Spectral shift frequency | FEM shift-invert lane | `fem_solver_policy.shift_hz` |
| `FemEigenSolverPolicy.target_spectrum` | `str` | `"smallest_magnitude"` | $1$ | `smallest_magnitude` or `target_magnitude` | SLEPc eigenvalue ordering target | FEM modal lane | `fem_solver_policy.target_spectrum` |
| `KPath.nodes` | `Sequence[tuple[float,float,float]]` | `required` | $\mathrm{rad\,m^{-1}}$ | At least two finite 3-vectors | Brillouin-zone path vertices | FEM Floquet/2.5D lane | `k_sampling.nodes` |
| `KPath.samples_per_segment` | `int` | `16` | $1$ | Positive integer | Interpolated samples per segment | FEM Floquet/2.5D lane | `k_sampling.samples_per_segment` |
| `BiasFieldSweep.values` | `Sequence[tuple[float,float,float]]` | `required` | $\mathrm{A\,m^{-1}}$ | Non-empty finite 3-vectors | Static external field samples | FEM modal lane | `bias_field_sweep.values` |
| `ModeTracking.min_overlap` | `float` | `0.5` | $1$ | Finite float in $(0, 1]$ | Minimum mass-weighted overlap threshold | FEM modal runner | `mode_tracking.min_overlap` |
| `ModeTracking.degeneracy_tolerance` | `float` | `1e6` | $\mathrm{Hz}$ | Finite positive float | Frequency window for subspace transport | FEM modal runner | `mode_tracking.degeneracy_tolerance` |

(python-api-studies-eigenmodes-problem-ir)=
<!-- (problem-ir)= -->
## 6. ProblemIR, normalization, and provenance

`Eigenmodes.to_ir()` emits `{"kind": "eigenmodes", ...}` inside `ProblemIR`:

```json
{
  "kind": "eigenmodes",
  "count": 8,
  "target": "lowest",
  "operator": "linearized_llg",
  "include_demag": true,
  "equilibrium_source": "relax",
  "normalization": "unit_l2",
  "damping_policy": "ignore",
  "spin_wave_bc": {"kind": "free"},
  "spatial_representation": "full_3d",
  "k_sampling": {
    "kind": "path",
    "nodes": [[0.0, 0.0, 0.0], [10000000.0, 0.0, 0.0]],
    "samples_per_segment": 4,
    "labels": ["Gamma", "X"]
  },
  "mode_tracking": {
    "enabled": true,
    "method": "overlap_hungarian",
    "min_overlap": 0.6,
    "degeneracy_tolerance": 1000000.0
  },
  "fem_solver_policy": {
    "backend": "auto",
    "subspace_dimension": 24,
    "max_iterations": 300,
    "tolerance": 1e-8,
    "shift_hz": null,
    "target_spectrum": "smallest_magnitude"
  }
}
```

(python-api-studies-eigenmodes-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip and failure semantics

**Requested intent** is preserved in Python and `ProblemIR`; **resolved execution** is selected by
`plan_fem_eigen` (`FemEigenPlanIR`). **Validation errors** reject empty outputs, non-positive
counts, invalid operator/target/normalization/damping values, and mismatched target bounds.
**Unsupported combinations** (such as FDM modal execution or unqualified GPU Floquet paths) fail
capability checks without silent fallback.

(python-api-studies-eigenmodes-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization

This page owns Python authoring and `ProblemIR` lowering. Native FEM operator discretization,
shared-domain Schur-complement SLEPc solving, multi-process `EigenKProcessPool` orchestration, and
modal qualification are documented under {doc}`../../numerical-methods/eigensolvers/index` and
{doc}`../../numerical-methods/eigensolvers/linearized-llg`.

(python-api-studies-eigenmodes-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Stage-first spec | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | `class EigenmodesStageSpec` | Stage-first modal parameter validation |
| Stage builder | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4633) | `add_eigenmodes` | Appends an `eigenmodes` stage to `study.stages` |
| Study model | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | `class Eigenmodes` | Canonical `Eigenmodes` study class and `.to_ir()` |
| Solver policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | `class FemEigenSolverPolicy` | FEM eigensolver policy class |
| Sampling & tracking | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | `coerce_k_sampling`, `class KPath`, `class BiasFieldSweep`, `class ModeTracking` | Wave-vector, field-sweep, and mode-tracking schemas |

(python-api-studies-eigenmodes-validation)=
<!-- (validation)= -->
## 10. Validation and qualification

Ownership and round-trip tests compare this parameter inventory against live Python signatures and
validate the adjacent `.source-map.json` manifest. Numerical and physical qualification gates are
documented in {doc}`../../numerical-methods/eigensolvers/modal-validation`.

(python-api-studies-eigenmodes-limitations)=
<!-- (limitations)= -->
## 11. Limitations

Python/IR representability does not imply universal backend support; `plan_fem_eigen` is the
authoritative gate for native FEM CPU and FEM GPU execution.

(python-api-studies-eigenmodes-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

1. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**,
   155–161 (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
2. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State
   Physics* **19**, 7013–7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
3. Canonical solver reference: {doc}`../../numerical-methods/eigensolvers/linearized-llg`.

(python-api-studies-eigenmodes-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Stage authoring and inspection are partial; the stage editor exposes only its advertised fields.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add stage -> Eigenmodes` | `partial` | Submit stage draft; stage and downstream result resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add stage -> Eigenmodes` | `not implemented` | Python-only until implemented |

not implemented: frontend support for study parameters not rendered by the stage editor.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: [`apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx#L17) (`StudyStageDraftEditor`) and [`apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx#L27) (`StudyStageInspectorRouter`).

## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1093) | `class Eigenmodes` | Canonical Python API behavior | Ownership test and source-map validator |
| FEM eigensolver policy | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L181) | `class FemEigenSolverPolicy` | Native solver backend and Krylov policy | Source-map validator |
| k-vector normalization | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | `coerce_k_sampling` | k sampling alias resolution | Source-map validator |
| Stage spec | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2795) | `class EigenmodesStageSpec` | Stage-first modal specification | Source-map validator |
| Stage builder | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4633) | `add_eigenmodes` | Stage-first authoring entrypoint | Source-map validator |
