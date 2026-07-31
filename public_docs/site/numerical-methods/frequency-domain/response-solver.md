---
title: Response Solver
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-frequency-domain-response-solver)=
# Frequency-domain response solver

(numerical-methods-frequency-response-problem-statement)=
## Physical and numerical problem

The response solver computes the steady-state linear response of a declared equilibrium to a
harmonic field excitation. It is distinct from eigenmode extraction: the frequency is prescribed,
the excitation phase is part of the request, and the output is an observable such as a susceptibility
tensor. The current native production contract is FEM; FDM is rejected by the planner for this path.

(numerical-methods-frequency-response-governing-equations)=
## Governing equations

With $\delta\mathbf m(t)=\Re\{\widehat{\mathbf m}(\omega)e^{\mathrm i\omega t}\}$ and harmonic drive
$\widehat{\mathbf h}_{\mathrm{ext}}$, the linearized frequency-domain system is

```{math}
:label: eq-numerical-frequency-response-system
\left(\mathsf K+\mathrm i\omega\mathsf G\right)
\widehat{\mathbf q}(\omega)=\widehat{\mathbf b}(\omega),
\qquad
\widehat{\mathbf b}(\omega)=\mathsf C\widehat{\mathbf h}_{\mathrm{ext}}.
```

For a susceptibility observable, the response is normalized by the declared excitation amplitude:

```{math}
:label: eq-numerical-frequency-response-susceptibility
\widehat{\boldsymbol\chi}(\omega)=
\frac{\widehat{\mathbf m}(\omega)}{\widehat{\mathbf h}_{\mathrm{ext}}(\omega)},
\qquad
\delta\mathbf m(t)=\Re\{\widehat{\mathbf m}e^{\mathrm i\omega t}\}.
```

(numerical-methods-frequency-response-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\delta\mathbf m$ | dynamic magnetization perturbation | $1$ |
| $\widehat{\mathbf m}$ | complex perturbation amplitude | $1$ |
| $\widehat{\mathbf h}_{\mathrm{ext}}$ | complex excitation field amplitude | $\mathrm{A\,m^{-1}}$ |
| $\mathsf K$ | tangent stiffness/dynamic matrix | problem-dependent |
| $\mathsf G$ | gyrotropic/damping matrix | problem-dependent |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $\widehat{\mathbf q}$ | complex tangent response | $1$ |
| $\widehat{\mathbf b}$ | assembled harmonic right-hand side | problem-dependent |
| $\mathsf C$ | drive coupling operator | problem-dependent |
| $\widehat{\boldsymbol\chi}$ | complex susceptibility | $1$ |

(numerical-methods-frequency-response-assumptions-and-validity)=
## Assumptions and validity

- The response is a first-order perturbation around the declared equilibrium. Large-angle or
  nonlinear response requires time-domain dynamics and is not this solver.
- Frequencies are positive finite values in Hz at the Python boundary and are converted to angular
  frequency in the operator contract.
- `include_demag`, damping, spin-wave boundary condition and magnetostatic boundary condition change
  the operator and must be recorded with every response curve.
- Solver `rtol` and iteration limits control algebraic convergence only; they do not prove mesh or
  equilibrium convergence.

(numerical-methods-frequency-response-python-api)=
## Python API

```python
# %% Stage-first FEM frequency response
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_frequency_response")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()
study.stages.add_frequency_response(
    frequencies_hz=(1.0e9, 2.0e9, 3.0e9),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
    magnetostatic_bc="open",
    solver_method="schur_reduced",
    solver_preconditioner="block_jacobi",
    solver_rtol=1.0e-8,
    solver_max_iterations=500,
    solver_restart_iterations=50,
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FrequencyResponseStageSpec.frequencies_hz` | `Sequence[float]` | required | $\mathrm{Hz}$ | finite positive values | response sampling frequencies | FEM | `study.frequencies_hz` |
| `FrequencyResponseStageSpec.excitation_field_au_per_m` | `tuple[float,float,float]` | `(0,0,1)` | $\mathrm{A\,m^{-1}}$ | finite three-vector | harmonic drive amplitude | FEM | `study.excitation.field_au_per_m` |
| `FrequencyResponseStageSpec.excitation_phase_rad` | `float` | `0` | $\mathrm{rad}$ | finite | drive phase | FEM | `study.excitation.phase_rad` |
| `FrequencyResponseStageSpec.observable` | `str` | `susceptibility_tensor` | $1$ | supported response output | requested observable | FEM | `study.outputs` |
| `FrequencyResponseStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include dynamic demag | FEM gated | `study.operator.include_demag` |
| `FrequencyResponseStageSpec.equilibrium_source` | `str` | `provided` | $1$ | `provided`, `relax`, or `artifact` | equilibrium source | planner | `study.equilibrium` |
| `FrequencyResponseStageSpec.equilibrium_artifact` | `str | None` | `None` | $1$ | required for artifact | equilibrium artifact | planner | `study.equilibrium_artifact` |
| `FrequencyResponseStageSpec.normalization` | `str` | `unit_l2` | $1$ | supported mode normalization | response normalization | FEM | `study.normalization` |
| `FrequencyResponseStageSpec.damping_policy` | `str` | `ignore` | $1$ | `ignore` or `include` | damping policy | FEM | `study.damping_policy` |
| `FrequencyResponseStageSpec.k_vector` | `tuple[float,float,float] | None` | `None` | $\mathrm{m^{-1}}$ | finite three-vector | legacy Bloch vector | FEM Floquet | `study.k_vector` |
| `FrequencyResponseStageSpec.k_sampling` | `object | None` | `None` | $1$ | valid sampling schema | k sampling | FEM Floquet | `study.k_sampling` |
| `FrequencyResponseStageSpec.bc` | `str | dict[str,object]` | `free` | $1$ | supported spin-wave BC | dynamic magnetization boundary | FEM | `study.spin_wave_bc` |
| `FrequencyResponseStageSpec.magnetostatic_bc` | `str` | `open` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` | magnetostatic closure | FEM | `study.magnetostatic_bc` |
| `FrequencyResponseSolverPolicy.rtol` | `float | None` | `None` | $1$ | finite positive | algebraic relative tolerance | FEM | `study.solver_policy.rtol` |
| `FrequencyResponseSolverPolicy.max_iterations` | `int | None` | `None` | $1$ | positive integer | iteration ceiling | FEM | `study.solver_policy.max_iterations` |

(numerical-methods-frequency-response-problem-ir)=
## ProblemIR and provenance

The IR stores sampling, excitation, linearized operator, equilibrium, boundary conditions and solver
policy separately. Resolved provenance records FEM mesh identity, device/precision, operator digest,
equilibrium source digest, solver residuals and every response sample. Python request and resolved
execution must not be collapsed into one status field.

(numerical-methods-frequency-response-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves all frequencies and solver parameters. Validation errors include empty or
non-positive frequency lists, invalid boundary combinations, missing periodic mesh metadata, invalid
solver policy and unsupported dynamic demagnetization. Unsupported combinations are rejected before
execution; no FDM fallback is allowed. Requested intent and resolved execution remain separate.

(numerical-methods-frequency-response-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial/source-backed | native driven-response contract |
| FEM | GPU | partial/qualification-dependent | separate production slice and dependency gates |
| FDM | CPU | unsupported | planner rejects the frequency-domain study |
| FDM | GPU | unsupported | no public FDM frequency-domain lane |

(numerical-methods-frequency-response-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | public request fields | Python |
| Python stage builder | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | solver policy lowering | Python/IR |
| Request validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | native legality checks | FEM |
| Response solve | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_driven_response_contract` | response status/diagnostics | FEM |

(numerical-methods-frequency-response-validation)=
## Validation

Check excitation normalization, residuals at every frequency, phase convention, equilibrium torque,
mesh convergence, frequency refinement, observable units and CPU/GPU parity under the same operator
digest. A smooth response curve without residual and provenance data is not sufficient.

(numerical-methods-frequency-response-limitations)=
## Limitations

This is a linear-response solver. Dynamic Floquet demagnetization and arbitrary FDM response are
separate or unsupported paths and must not be inferred from this page.

(numerical-methods-frequency-response-scientific-bibliography)=
## Scientific bibliography

- A. A. Thiele, “Steady-state motion of magnetic domains,” *Physical Review Letters* 30 (1973).
- Canonical dynamic owner: {doc}`../../physics/foundations/llg-equation`.

(numerical-methods-frequency-response-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | response parameters | Python source |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | policy creation | Python source |
| Native validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | legality | native source |
| Native response | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_driven_response_contract` | response contract | native source |
