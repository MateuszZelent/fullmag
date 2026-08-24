---
title: Linearized LLG
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-eigensolvers-linearized-llg)=
# Linearized LLG eigensolver

(numerical-methods-eigensolver-linearized-llg-problem-statement)=
## Physical and numerical problem

The canonical dynamical model is owned by {doc}`../../physics/foundations/llg-equation`. This page
documents the numerical modal realization: first obtain or provide a static equilibrium
$\mathbf m_0$, then restrict perturbations to the tangent plane and solve the linearized dynamics.
The mode problem is not a time-integration shortcut. Its equilibrium, damping policy, demagnetizing
operator, boundary condition, normalization and target-selection policy are all part of the request.

(numerical-methods-eigensolver-linearized-llg-governing-equations)=
## Governing equations

Let $\mathbf m=\mathbf m_0+\delta\mathbf m$ with $|\mathbf m_0|=1$. The first-order constraint is

```{math}
:label: eq-numerical-linearized-llg-tangent
\mathbf m_0\cdot\delta\mathbf m=0,
\qquad
\delta\mathbf m=\mathbf e_1 q_1+\mathbf e_2 q_2.
```

After linearizing the effective field and assembling the tangent-space dynamic and damping/mass
operators, the production modal contract is represented as a generalized complex eigenproblem:

```{math}
:label: eq-numerical-linearized-llg-pencil
\mathsf L\mathbf q=\lambda\mathsf B_{\alpha}\mathbf q,
\qquad
\lambda=\mathrm i\omega,
\qquad
\omega=-\mathrm i\lambda,
\qquad
f=\frac{\operatorname{Re}\omega}{2\pi}.
```

For the recorded $\exp(\mathrm i\omega t)$ convention, damping can make the mapped frequency
complex. Cyclic frequency uses only $\operatorname{Re}\omega$; $|\omega|$ would mix oscillation
with damping and lose the branch sign. The reported mode must retain the phase convention,
eigenvalue-to-frequency mapping, and normalization used by the solver; a complex phase rotation
does not change the physical mode.

(numerical-methods-eigensolver-linearized-llg-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | unit magnetization | $1$ |
| $\mathbf m_0$ | equilibrium magnetization | $1$ |
| $\delta\mathbf m$ | first-order magnetization perturbation | $1$ |
| $\mathbf e_1,\mathbf e_2$ | local tangent basis | $1$ |
| $q_1,q_2$ | tangent perturbation amplitudes | $1$ |
| $\mathsf L$ | tangent dynamic operator | $\mathrm{s^{-1}}$ |
| $\mathsf B_{\alpha}$ | damping/mass operator | $1$ |
| $\mathbf q$ | discrete tangent eigenvector | $1$ |
| $\lambda$ | complex eigenvalue | $\mathrm{s^{-1}}$ |
| $\omega$ | complex angular frequency, $-\mathrm i\lambda$ | $\mathrm{rad\,s^{-1}}$ |
| $f$ | signed cyclic frequency, $\operatorname{Re}(\omega)/(2\pi)$ | $\mathrm{Hz}$ |

(numerical-methods-eigensolver-linearized-llg-assumptions-and-validity)=
## Assumptions and validity

- The equilibrium must satisfy the requested static tolerance; a mode solve around a transient state
  is a different problem and must be labelled as such.
- The tangent basis and perturbation normalization must be consistent across the operator, mode
  output and validation. A raw eigenvector norm is not a physical amplitude.
- `damping_policy="ignore"` and `damping_policy="include"` define different operators. They must
  not be compared as CPU/GPU parity results.
- Demagnetization is included only when `include_demag=True`; omitting it changes the spectrum.
- The current modal routes are bounded FEM slices. FDM is unsupported; FEM CPU/GPU support must be
  reported by the resolved planner, not inferred from the Python constructor.

(numerical-methods-eigensolver-linearized-llg-python-api)=
## Python API

```python
# %% Build a stage-first linearized-LLG modal request
import fullmag as fm

nm = 1.0e-9
study = fm.study("linearized_llg_modes")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.demag()
study.stages.add_relax(stage_id="equilibrium", algorithm="nonlinear_cg", tolT=1.0e-6, max_steps=2000)
study.stages.add_eigenmodes(
    count=12,
    target="lowest",
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `EigenmodesStageSpec.count` | `int` | `10` | $1$ | positive integer | number of modes | FEM planner | `study.count` |
| `EigenmodesStageSpec.target` | `str` | `lowest` | $1$ | `lowest`, `nearest`, or `frequency_window` | spectral target policy | FEM planner | `study.target` |
| `EigenmodesStageSpec.target_frequency` | `float | None` | `None` | $\mathrm{Hz}$ | required for `nearest` | shift target | FEM modal lane | `study.target_frequency` |
| `EigenmodesStageSpec.frequency_min` | `float | None` | `None` | $\mathrm{Hz}$ | required with window | lower window bound | FEM modal lane | `study.frequency_min` |
| `EigenmodesStageSpec.frequency_max` | `float | None` | `None` | $\mathrm{Hz}$ | greater than `frequency_min` | upper window bound | FEM modal lane | `study.frequency_max` |
| `EigenmodesStageSpec.operator` | `str` | `linearized_llg` | $1$ | supported operator name | dynamic operator family | FEM | `study.operator` |
| `EigenmodesStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include demagnetization | FEM | `study.include_demag` |
| `EigenmodesStageSpec.equilibrium_source` | `str` | `relax` | $1$ | `relax`, `provided`, or `artifact` | equilibrium source | planner | `study.equilibrium_source` |
| `EigenmodesStageSpec.equilibrium_artifact` | `str | None` | `None` | $1$ | required for `artifact` | equilibrium artifact path | planner | `study.equilibrium_artifact` |
| `EigenmodesStageSpec.normalization` | `str` | `unit_l2` | $1$ | `unit_l2` or `unit_max_amplitude` | mode normalization | FEM | `study.normalization` |
| `EigenmodesStageSpec.damping_policy` | `str` | `ignore` | $1$ | `ignore` or `include` | damping in the linearized operator | FEM modal lane | `study.damping_policy` |
| `EigenmodesStageSpec.k_vector` | `tuple[float,float,float] | None` | `None` | $\mathrm{m^{-1}}$ | finite three-vector | Bloch wave vector | FEM periodic/Floquet lane | `study.k_vector` |
| `EigenmodesStageSpec.k_sampling` | `object | None` | `None` | $1$ | sampling schema validated by planner | dispersion sampling | FEM modal lane | `study.k_sampling` |
| `EigenmodesStageSpec.bc` | `str | dict[str,object]` | `free` | $1$ | supported boundary-condition schema | spin-wave boundary policy | FEM | `study.spin_wave_bc` |

(numerical-methods-eigensolver-linearized-llg-problem-ir)=
## ProblemIR and provenance

The stage lowers to `StudyIR::Eigenmodes` and carries operator, equilibrium, target, normalization,
damping and boundary policies as separate fields. Provenance must preserve the requested policy and
the resolved FEM device/precision, equilibrium artifact digest, tangent DOF count, operator metadata,
eigensolver diagnostics, mode normalization, phase convention and validation results.

(numerical-methods-eigensolver-linearized-llg-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves stage order and all modal parameters. Requested intent is preserved before validation. Validation errors include invalid target
windows, missing artifact paths, unsupported operators, inconsistent equilibrium sources, invalid
normalization or boundary schemas, and unavailable solver dependencies. Unsupported combinations are
reported before execution; no FDM or GPU fallback is implied by a Python modal request. Requested
intent and resolved execution are recorded separately, including validation errors and dependency
availability.

(numerical-methods-eigensolver-linearized-llg-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial-production-executable | reference/MVP artifacts and a bounded selected-spectrum, no-demag, Full2x2 Floquet slice; general Poisson-airbox/SLEPc production remains gated |
| FEM | GPU | partial-production-executable | narrow $k=0$, no-demag macrospin/Kittel cuSolverDN slice; Poisson-airbox dense paths remain algebraic or gated |
| FDM | CPU | unsupported for this native modal page | planner does not claim a production FDM eigen lane |
| FDM | GPU | unsupported for this native modal page | no public CUDA modal claim |

(numerical-methods-eigensolver-linearized-llg-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class EigenmodesStageSpec` | modal request fields | Python |
| Python stage builder | `packages/fullmag-py/src/fullmag/world.py` | `eigenmodes_stage` | constructs modal stage | Python/IR |
| Native modal contract | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | validates and executes modal request | FEM CPU |
| Eigenvalue/frequency mapping | `backends/fem/src/frequency_domain/mode_kinematics.cpp` | `frequency_hz_from_omega_rad_s` | converts the signed real angular-frequency component selected by `map_eigenvalue` to $f$ | FEM |

(numerical-methods-eigensolver-linearized-llg-validation)=
## Validation

Validate tangent constraint residuals, equilibrium torque, generalized eigen residuals, finite and
ordered frequencies, normalization, phase convention, mode orthogonality where applicable, and
convergence under mesh refinement. Compare CPU/GPU only with identical operator metadata and report
dependency and qualification status separately from numerical output.

(numerical-methods-eigensolver-linearized-llg-limitations)=
## Limitations

This page does not claim universal FDM modal support, arbitrary fully periodic boundary conditions,
or production GPU support for every FEM operator. Dense or SLEPc-backed dependency availability is a
runtime qualification condition, not a mathematical assumption.

(numerical-methods-eigensolver-linearized-llg-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, *Micromagnetics*, Wiley, 1963.
- A. A. Guslienko et al., “Eigenfrequencies of vortex state magnetic dots,” *Journal of Applied Physics* 91 (2002).
- Canonical LLG owner: {doc}`../../physics/foundations/llg-equation`.

(numerical-methods-eigensolver-linearized-llg-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class EigenmodesStageSpec` | modal parameters | Python API source |
| Python stage construction | `packages/fullmag-py/src/fullmag/world.py` | `eigenmodes_stage` | stage lowering input | Python API source |
| Native modal solve | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | contract and diagnostics | native source contract |
| Eigenvalue/frequency mapping | `backends/fem/src/frequency_domain/mode_kinematics.cpp` | `frequency_hz_from_omega_rad_s` | signed angular-to-cyclic frequency conversion used by modal kinematics | native source/tests |
