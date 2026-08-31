---
title: Response Solver
status: partial
reviewed_revision: 88c7160080bc1e8519950df283d2dd02087cc3da
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: public response schema, native FEM response contract, runner implementation, and frequency-domain artifact contracts
---

(public-docs-numerical-methods-frequency-domain-response-solver)=
# Frequency-domain response solver

:::{admonition} Current production boundary
:class: important

The response solver computes first-order harmonic response around a declared equilibrium. The
native public route is FEM. FDM CPU and FDM GPU frequency-response requests are unsupported. The
frequency solver-tree headers describe a broader target architecture than the runtime currently
executes; requested and resolved solver methods must therefore be reported separately.
:::

(numerical-methods-frequency-response-problem-statement)=
## Physical and numerical problem

For an equilibrium $\mathbf m_0$, Fullmag linearizes the enabled LLG operator in the local tangent
space and solves at prescribed positive frequencies. The drive amplitude and phase are part of the
request; the output is a complex response field or a derived observable. This is not an eigensolve:
the frequency is prescribed and the right-hand side is nonzero. It is also not a nonlinear
harmonic-balance calculation: the result is valid only in the small-amplitude regime in which the
first-order linearization is adequate.

The equilibrium source, dynamic demagnetization policy, Gilbert damping policy, spin-wave boundary
condition, magnetostatic boundary condition, FEM mesh, solver lane, precision, Fourier convention,
and excitation normalization define one numerical problem. Changing any of them changes the
response operator or the meaning of the result.

(numerical-methods-frequency-response-governing-equations)=
## Governing equations

With the recorded phasor convention

```{math}
:label: eq-numerical-frequency-response-ansatz
\delta\mathbf m(t)=
\Re\!\left\{\widehat{\mathbf m}(\omega)e^{\mathrm i\omega t}\right\},
\qquad
\delta\mathbf h_{\mathrm{ext}}(t)=
\Re\!\left\{\widehat{\mathbf h}_{\mathrm{ext}}e^{\mathrm i\omega t}\right\},
```

the native tangent problem is represented as

```{math}
:label: eq-numerical-frequency-response-system
\mathsf A(\omega)\widehat{\mathbf q}(\omega)
=\widehat{\mathbf b}(\omega),
\qquad
\mathsf A(\omega)=\mathsf K+\mathrm i\omega\mathsf G,
\qquad
\widehat{\mathbf b}=\mathsf C\widehat{\mathbf h}_{\mathrm{ext}}.
```

$\mathsf K$ contains the linearized effective-field operator, $\mathsf G$ contains the gyrotropic,
mass, and damping structure of the selected formulation, and $\mathsf C$ maps the applied field to
tangent coordinates. The exact scaling and signs are owned by the native operator contract and the
recorded `phase_convention`; they must not be reconstructed from plot labels.

The physical perturbation is obtained by reconstructing tangent coordinates in the local basis,

```{math}
:label: eq-numerical-frequency-response-reconstruction
\widehat{\mathbf m}_i
=\mathbf e_{1,i}\widehat q_{1,i}
+\mathbf e_{2,i}\widehat q_{2,i},
\qquad
\mathbf m_{0,i}\cdot\widehat{\mathbf m}_i=0
```

up to the numerical tangent-leakage tolerance.

(numerical-methods-frequency-response-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\delta\mathbf m$ | dynamic reduced-magnetization perturbation | $1$ |
| $\mathbf m_0$ | equilibrium reduced magnetization | $1$ |
| $\widehat{\mathbf m}$ | complex reduced-magnetization response amplitude | $1$ |
| $\widehat{\mathbf M}$ | complex physical magnetization response amplitude | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf h}_{\mathrm{ext}}$ | complex excitation-field amplitude | $\mathrm{A\,m^{-1}}$ |
| $\mathsf A(\omega)$ | shifted complex tangent response operator | operator-dependent |
| $\mathsf K$ | tangent stiffness/dynamic matrix | operator-dependent |
| $\mathsf G$ | gyrotropic, mass, and damping matrix | operator-dependent |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $t$ | time | $\mathrm{s}$ |
| $\widehat{\mathbf q}$ | complex tangent-coordinate response | $1$ |
| $\widehat{\mathbf b}$ | assembled harmonic right-hand side | operator-dependent |
| $\mathsf C$ | drive coupling operator | operator-dependent |
| $\mathbf e_1$ | first local tangent basis vector | $1$ |
| $\mathbf e_2$ | second local tangent basis vector | $1$ |
| $\widehat{\boldsymbol\chi}_M$ | physical magnetization susceptibility, M response divided by H drive | $1$ |
| $\widehat{\boldsymbol\chi}_m$ | reduced-magnetization response divided by H drive | $\mathrm{m\,A^{-1}}$ |
| $\chi_{\mathrm{v1}}$ | current dense v1 scalar projection h^H m / h^H h | $\mathrm{m\,A^{-1}}$ (implemented; writer currently labels it dimensionless) |
| $p_{\mathrm{abs}}$ | cycle-averaged absorbed magnetic power density | $\mathrm{W\,m^{-3}}$ after complete SI scaling and spatial reduction |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf r$ | original-operator algebraic residual | right-hand-side-dependent |
| $\varepsilon_{\mathrm{true}}$ | true relative residual | $1$ |
| $b_{\mathrm{scale}}$ | absolute residual normalization floor | same as right-hand side |

(numerical-methods-frequency-response-si-observable-reference)=
(numerical-methods-frequency-response-susceptibility)=
## Susceptibility and response-unit conventions

Two quantities that are often both called “susceptibility” are dimensionally different:

```{math}
:label: eq-numerical-frequency-response-physical-susceptibility
\widehat{\boldsymbol\chi}_{M}(\omega)
=\frac{\widehat{\mathbf M}(\omega)}
{\widehat{\mathbf h}_{\mathrm{ext}}(\omega)},
\qquad
\widehat{\mathbf M}=M_s\widehat{\mathbf m},
```

which is dimensionless in SI.

This is the conventional full-SI definition obtained from $\widehat{\mathbf M}=M_s
\widehat{\mathbf m}$; it is the scientific target described by references 1 and 4, not a claim
that every current artifact writer materializes a full tensor with this scaling.

The corresponding reduced-magnetization response is

```{math}
:label: eq-numerical-frequency-response-reduced-susceptibility
\widehat{\boldsymbol\chi}_{m}(\omega)
=\frac{\widehat{\mathbf m}(\omega)}
{\widehat{\mathbf h}_{\mathrm{ext}}(\omega)},
```

which has unit $\mathrm{m\,A^{-1}}$ because reduced magnetization is dimensionless while field has
unit $\mathrm{A\,m^{-1}}$.

At the reviewed revision, the dense block-real validation artifact stores `m_complex` as
`normalized_magnetization` and computes the scalar projection

```{math}
:label: eq-numerical-frequency-response-v1-susceptibility
\chi_{\mathrm{v1}}
=\frac{\widehat{\mathbf h}^{\ast}
\widehat{\mathbf m}}
{\widehat{\mathbf h}^{\ast}\widehat{\mathbf h}}.
```

This expression has unit $\mathrm{m\,A^{-1}}$ when the excitation is in
$\mathrm{A\,m^{-1}}$, although `response_block_real.rs` currently labels the serialized
`susceptibility_tensor` as `dimensionless`. This is a **known artifact-unit contract gap**. The
current value must not be interpreted as conventional dimensionless $\widehat M/\widehat H$ unless
the writer explicitly applies $M_s$ and records the averaging/volume convention. The artifact
schema should ultimately expose the numerator quantity, denominator quantity, spatial reduction,
and SI unit directly.

The same caution applies to `absorbed_power_density`. The physical cycle-averaged magnetic work
under the $e^{\mathrm i\omega t}$ convention has the form

```{math}
:label: eq-numerical-frequency-response-absorbed-power
p_{\mathrm{abs}}
=-\frac{\mu_0\omega}{2}
\operatorname{Im}
\left(\widehat{\mathbf h}_{\mathrm{ext}}^{\ast}
\cdot\widehat{\mathbf M}\right),
```

with an explicitly declared local or volume-averaged reduction. The dense validation writer
currently evaluates `-0.5 * omega * Im(h^H m)` and labels it $\mathrm{W\,m^{-3}}$; therefore the
native scaling, $M_s$, $\mu_0$, and volume normalization must be certified before using that field
as a physical power density. The full-SI magnetic-work expression follows the phasor convention
and energy coupling discussed in references 1 and 4. Neither the Rust validation proxy nor the
native drive-projected, non-volume-weighted proxy is implementation evidence for this full
physical power density.

(numerical-methods-frequency-response-true-residual)=
## Algebraic residual and per-frequency status

For every returned frequency sample,

```{math}
:label: eq-numerical-frequency-response-residual
\mathbf r(\omega)
=\widehat{\mathbf b}-\mathsf A(\omega)\widehat{\mathbf q},
```

and a scale-independent relative diagnostic can be written as

```{math}
:label: eq-numerical-frequency-response-relative-residual
\varepsilon_{\mathrm{true}}(\omega)
=\frac{\lVert\mathbf r(\omega)\rVert_2}
{\max(\lVert\widehat{\mathbf b}\rVert_2,b_{\mathrm{scale}})}.
```

The denominator convention actually used by the backend must be recorded. A Krylov recurrence
residual, preconditioned residual, reduced-system residual, or backend status code does not replace
reapplication of the original full operator. The frequency-plan contract therefore requires true
residual verification. For Schur or modal reduction, the final residual must be reconstructed in
the unreduced coupled space.

A sweep is a set of individually qualified solves. Each point records at least frequency, resolved
lane, converged/failed/interrupted state, iteration count, final residual, true residual, and output
availability. One aggregate “success” flag cannot hide a failed point in the middle of a sweep.

(numerical-methods-frequency-response-assumptions-and-validity)=
## Assumptions and validity

- The equilibrium passes the declared static torque gate. Linearizing a transient state defines a
  different problem and must be identified explicitly.
- The excitation is nonzero when a normalized response or susceptibility is requested.
- Frequencies are finite positive values in hertz at the Python boundary and are converted to
  $\omega=2\pi f$ in the native operator.
- `include_demag`, `damping_policy`, `bc`, and `magnetostatic_bc` change the operator and must be
  included in its content identity.
- The response remains sufficiently small for first-order linearization. Increasing drive amplitude
  in this solver changes only the linear scaling; it cannot produce nonlinear resonance shifts,
  mode coupling, or saturation.
- Algebraic tolerance controls the linear solve only. Mesh error, equilibrium error, airbox error,
  dynamic-demagnetization error, and frequency-sampling error are independent.
- Warm starts and operator-template reuse may improve a sweep but must not carry an unconverged or
  physically incompatible state into the next point without provenance.

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

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_frequency_response(
    frequencies_hz=(1.0e9, 2.0e9, 3.0e9),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    observable="m_complex",
    include_demag=True,
    equilibrium_source="provided",
    damping_policy="include",
    bc="free",
    magnetostatic_bc="open",
    solver_method="auto",
    solver_preconditioner="block_jacobi",
    solver_rtol=1.0e-8,
    solver_max_iterations=500,
    solver_restart_iterations=50,
)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---:|---:|---|---|---|---|
| `frequencies_hz` | `Sequence[float]` | required | $\mathrm{Hz}$ | nonempty; every value finite and positive | prescribed response samples | FEM | `frequencies_hz.values_hz` |
| `excitation_field_au_per_m` | `tuple[float, float, float]` | `(0.0, 0.0, 1.0)` | $\mathrm{A\,m^{-1}}$ | exactly three finite values; zero physical drive is allowed but normalized output may be unavailable | harmonic field amplitude before phase rotation | FEM | `excitation.field_au_per_m` |
| `excitation_phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite after float conversion | global harmonic-drive phase | FEM | `excitation.phase_rad` |
| `observable` | `str` | `susceptibility_tensor` | quantity-dependent | one of m_complex, u_complex, strain_complex, stress_complex, susceptibility_tensor, absorbed_power_density, response_amplitude, response_phase, mode_hybridization_index | requested response output | FEM; materialization is writer-dependent | `sampling.outputs[0] = {"kind":"frequency_response_output","observable": observable}` |
| `include_demag` | `bool` | `True` | $1$ | type annotation only; no authoring-time isinstance validation or normalization; value lowers unchanged | include dynamic demagnetization | FEM capability-gated; IR/backend must reject invalid values | `operator.include_demag` |
| `equilibrium_source` | `str` | `provided` | $1$ | one of provided, relax, artifact | source of the linearization state | FEM planner | `equilibrium = {"kind":"provided"} / {"kind":"relaxed_initial_state"} / {"kind":"artifact","path": equilibrium_artifact}` |
| `equilibrium_artifact` | `str \| None` | `None` | $1$ | required and nonempty for artifact source; nonempty if otherwise supplied | equilibrium artifact path | FEM planner | `equilibrium.path when equilibrium.kind is artifact` |
| `normalization` | `str` | `unit_l2` | $1$ | one of unit_l2, unit_max_amplitude | internal basis normalization, not drive amplitude | FEM | `normalization` |
| `damping_policy` | `str` | `ignore` | $1$ | one of ignore, include | damping treatment in the linearized operator | FEM | `damping_policy` |
| `k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m^{-1}}$ | legacy finite three-vector; mutually exclusive with k_sampling | one Bloch-wave sample | FEM Floquet capability-gated | `k_sampling = {"kind":"single","k_vector":[kx,ky,kz]}` |
| `k_sampling` | `object \| None` | `None` | $1$ | None, finite three-vector, KPoint, or KPath; KPoint label is null or nonempty; KPath has at least two points and positive per-segment counts; mutually exclusive with k_vector | explicit Bloch sampling definition | FEM Floquet capability-gated | `None -> null; vector or KPoint -> {"kind":"single","k_vector":[...]}; KPath -> {"kind":"path","points":[{"label": string-or-null,"k_vector":[kx,ky,kz]},...],"samples_per_segment":[n0,...],"closed": bool}` |
| `bc` | `str \| dict[str, object]` | `free` | $1$ | raw string allow-list; PeriodicBC/FloquetBC require nonempty pair_ids; raw dict checks only accepted kind and does not validate required fields | dynamic-magnetization boundary | FEM; malformed raw dict may survive authoring and fail later | `raw free/pinned/periodic/floquet/surface_anisotropy string unchanged; PeriodicBC -> {"kind":"periodic","pair_ids":[...]}; FloquetBC -> {"kind":"floquet","pair_ids":[...],"phase_convention": value}; raw dict -> unchanged after kind-only check` |
| `magnetostatic_bc` | `str` | `open` | $1$ | one of open, periodic_airbox_k0, floquet_airbox | dynamic magnetostatic closure | FEM | `magnetostatic_bc` |
| `solver_method` | `str \| None` | `None` | $1$ | known solver-tree name; explicit runtime subset is gated below | requested algebraic route; omission means automatic resolution | FEM bounded | `solver_policy.method` |
| `solver_preconditioner` | `str \| None` | `None` | $1$ | one of auto, graph_demag_coarse, demag_coarse, block_jacobi, none | requested preconditioner | FEM bounded | `solver_policy.preconditioner` |
| `solver_rtol` | `float \| None` | `None` | $1$ | finite and positive | relative algebraic tolerance | FEM | `solver_policy.rtol` |
| `solver_max_iterations` | `int \| None` | `None` | $1$ | positive integer; Boolean rejected | iteration ceiling | FEM iterative lanes | `solver_policy.max_iterations` |
| `solver_restart_iterations` | `int \| None` | `None` | $1$ | positive integer; at most solver_max_iterations when both are supplied | restarted-GMRES subspace length | FEM iterative lanes | `solver_policy.restart_iterations` |
| `MAX_ITERATIONS` | `int \| None` | `None` | $1$ | compatibility alias; conflicts with a different solver_max_iterations value | legacy spelling of the iteration ceiling | FEM iterative lanes | `solver_policy.max_iterations` |

`observable="m_complex"` is used in the example because its stored quantity is unambiguous: complex
reduced magnetization. When requesting `susceptibility_tensor`, consumers must inspect the artifact
schema and SI-unit metadata rather than assume conventional dimensionless susceptibility.

(numerical-methods-frequency-response-problem-ir)=
## ProblemIR and provenance

The structured lowering is deterministic. `provided`, `relax`, and `artifact` equilibrium requests
become `{"kind":"provided"}`, `{"kind":"relaxed_initial_state"}`, and
`{"kind":"artifact","path":...}` respectively. A legacy `k_vector`, a three-vector
`k_sampling`, or a `KPoint` becomes `{"kind":"single","k_vector":[...]}`; a `KPath`
becomes
`{"kind":"path","points":[{"label":<string-or-null>,"k_vector":[kx,ky,kz]},...],`
`"samples_per_segment":[n0,...],"closed":<bool>}`. Each nested point comes from
`KPoint.to_ir()` exactly; `KPath.to_ir()` preserves point order, the full positive
`samples_per_segment` list, and `closed`. Supplying both `k_vector` and `k_sampling` fails.

The boundary serializer has a deliberately weak raw-input boundary. Each raw string
`"free"`, `"pinned"`, `"periodic"`, `"floquet"`, or `"surface_anisotropy"` is returned
unchanged. `PeriodicBC` becomes `{"kind":"periodic","pair_ids":[...]}` and validates a
nonempty list of nonempty pair IDs. `FloquetBC` becomes
`{"kind":"floquet","pair_ids":[...],"phase_convention":...}` and validates nonempty pair
IDs plus a nonempty phase convention. For a raw dictionary, authoring checks only that `kind` is
one of those five accepted names, then returns the entire dictionary unchanged: required fields,
field types, pair IDs, phase convention, and unexpected keys are not validated at this boundary.
Such malformed raw dictionaries can fail only in later IR/backend validation. The output is the
complete object `{"kind":"frequency_response_output","observable":...}` inside
`sampling.outputs`, not a bare observable name.

The IR stores sampling, excitation, linearized operator, equilibrium, boundary conditions, output
intent, and solver policy separately. Required resolved provenance includes:

- source equilibrium artifact and accepted torque metric;
- FEM mesh, periodic-pair, material, and operator digests;
- phase convention and tangent-basis identity;
- requested and resolved backend, device, precision, solver method, preconditioner, and dependency;
- operator, vector, Krylov, and preconditioner residency;
- fallback status and reason;
- dynamic-demagnetization and magnetostatic-boundary realization;
- one status, iteration history, residual, and true-residual certification per frequency;
- drive field, phase, spatial normalization, and output units;
- warm-start/factor/operator-template reuse;
- interruption and partial-artifact status.

The hardened artifact contract distinguishes `implementation_state` from `validation_state` and
requires an exact bounded `validated_scope`. Executable code is not automatically
production-qualified.

(numerical-methods-frequency-response-runtime-boundary)=
## Solver-tree contract versus current runtime

The planner headers represent the intended lanes
`dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`,
`modal_reduced`, `gpu_operator_host_krylov`, and `gpu_device_krylov`. The runner's
`frequency_response_solver_method_rejection_reason` currently exposes a narrower explicit-method
surface:

| Requested explicit method | Current runtime result |
|---|---|
| `dense_reference` | allowed only for nonperiodic CPU validation requests |
| `schur_reduced` | allowed only for `periodic_airbox_k0` or `floquet_airbox` requests |
| `gpu_operator_host_krylov` | allowed only when device `gpu` was requested |
| `cpu_sparse_direct` | rejected as solver-tree contract not yet implemented in the current runtime |
| `full_coupled_field_split` | rejected as solver-tree contract not yet implemented in the current runtime |
| `modal_reduced` | rejected as solver-tree contract not yet implemented in the current runtime |
| `gpu_device_krylov` | rejected as solver-tree contract not yet implemented in the current runtime |
| `auto` | resolved by the production/validation runtime path and recorded separately |

For the source-visible resolver, the broad resolved names are
`gpu_operator_host_krylov` for a requested GPU route, `schur_reduced` for the periodic-airbox Schur
route, and `production_cpu_host_gmres` for the ordinary CPU production route. This table is a
revision-specific implementation boundary, not a permanent API promise.

(numerical-methods-frequency-response-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent.** Script capture and export preserve the full frequency sequence, excitation,
phase, equilibrium source, operator choices, boundary conditions, requested output, and every
explicit solver-policy field. An omitted solver policy remains omitted; it is not rewritten as an
explicit runtime method. `MAX_ITERATIONS` is normalized to `solver_max_iterations`, and supplying
both with different values is a validation error.

**Resolved execution.** Runtime provenance separately records the resolved engine, device,
precision, solver method, preconditioner, dependency, lane, residency, fallback status, and one
completion record per frequency. Resolved execution may select an automatic method, but it does
not alter the preserved requested intent.

**Validation errors.** Authoring validation rejects malformed frequencies, phase, equilibrium,
normalization, damping, boundary, observable, and solver-policy values before lowering. Native and
runtime validation then reject unavailable operator data, incompatible boundaries, failed
equilibria, non-finite systems, and failed residual certification. Representative failures include:

- empty, non-finite, or nonpositive frequency lists;
- unavailable normalization for a zero-drive derived response;
- missing or rejected equilibrium;
- unsupported explicit solver method;
- invalid boundary/Floquet metadata;
- unavailable dynamic demagnetization;
- incompatible device, precision, dependency, or preconditioner;
- singular direct operator or failed Krylov convergence;
- non-finite response, residual, or output;
- failed true-residual/full-block certification.

**Unsupported combinations.** An unsupported combination fails before execution. It cannot
silently become FDM, free-boundary, no-demag, CPU, dense validation, or a different solver method.
Interrupted sweeps publish only an explicitly partial artifact with completed-point count and
requested-point count.

(numerical-methods-frequency-response-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | source-backed, bounded | dense validation and production host-GMRES/native routes; periodic Schur route is separately gated |
| FEM | GPU | partial, qualification-dependent | GPU operator with host Krylov is represented; actual device residency and transfer audit are required |
| FDM | CPU | unsupported | planner/runtime reject native frequency-response execution |
| FDM | GPU | unsupported | no public FDM CUDA frequency-response lane |

A CUDA-enabled build, GPU request, or GPU lane label does not prove device-resident Krylov. The
operator, vectors, Krylov basis, and preconditioner have separate residency fields.

(numerical-methods-frequency-response-implementation-mapping)=
## Implementation mapping

(numerical-methods-frequency-response-planner-struct-source)=
(numerical-methods-frequency-response-planner-input-overload-source)=
(numerical-methods-frequency-response-planner-capability-overload-source)=

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | public response request | Python |
| Python stage builder | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | stage and solver-policy lowering | Python/IR |
| Public stage callable | `packages/fullmag-py/src/fullmag/world.py` | `add_frequency_response` | public `StudyStagesBuilder` entry point | Python/IR |
| Solver policy validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | public solver names, defaults, and numeric validation | Python/IR |
| ProblemIR lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | response request validation and exact IR shape | Python/IR |
| Observable validation | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveResponse` | supported response-output vocabulary | Python/IR |
| Wave-vector lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `coerce_k_sampling` | exact single-point/path representation and exclusivity | Python/IR |
| K-point lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class KPoint` | nested label and three-vector representation | Python/IR |
| K-path lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class KPath` | ordered nested points, segment counts, and closed flag | Python/IR |
| Native request validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | operator and boundary legality | FEM |
| Native response ABI | `backends/fem/include/frequency_domain/driven_response_solver.hpp` | `solve_driven_frequency_response` | production entry-point declaration | FEM |
| Native response implementation | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_driven_frequency_response` | validation, lane dispatch, solve, residuals, and artifacts | FEM |
| Solver plan data contract | `backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp` | `struct FrequencySolvePlan` | selected lane, representation, solver, preconditioner, and gates | FEM planner |
| Planner request overload | `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` | `plan_frequency_response(const FrequencySolvePlannerInput&)` | direct planner-input selection | FEM planner |
| Planner capability overload | `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` | `plan_frequency_response(const FrequencyBackendCapabilities&, const FrequencySolverPolicy&)` | capability/policy lowering into planner input | FEM planner |
| Runtime availability gate | `crates/fullmag-runner/src/frequency_response.rs` | `frequency_response_solver_method_rejection_reason` | rejects target lanes not yet executable | runner |
| Runtime resolved-name mapping | `crates/fullmag-runner/src/frequency_response.rs` | `resolved_frequency_response_solver_method_name` | broad runtime lane identity | runner |
| Dense block-real solve | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_block_real_harmonic_response` | complex system represented as a real $2n\times2n$ solve | validation/reference |
| Dense sweep and reuse | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_field_driven_block_real_sweep_with_interrupt` | per-frequency solve, template reuse, warm-start provenance | validation/reference |
| v1 response artifact | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `build_field_driven_response_sweep_artifact` | complex response, residuals, derived outputs, SI map | validation/reference |
| v1 unit map | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `response_sweep_si_units` | serialized output-unit labels | validation/reference |
| v1 derived point | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `field_driven_response_point` | susceptibility projection and absorbed-power scalar | validation/reference |

(numerical-methods-frequency-response-validation)=
## Verification and scientific validation

### Algebraic tests

1. Compare the block-real solve with a direct complex solve on the same tiny matrix.
2. Recompute the original operator residual independently of the solver recurrence.
3. Verify that real/imaginary block layout reproduces
   $(A_R+\mathrm iA_I)(q_R+\mathrm iq_I)=b_R+\mathrm ib_I$.
4. Exercise singular, zero-drive, non-finite, interrupted, and unsupported-method failures.
5. For Schur reduction, reconstruct magnetic, potential, and gauge residual blocks.

### Physical tests

1. **Macrospin:** compare complex transverse response, resonance frequency, phase, and
   damping-dependent linewidth with an independently evaluated linear macrospin model.
2. **Time/frequency parity:** drive the same equilibrium at sufficiently small amplitude in the time
   domain, remove transients, and compare the complex Fourier amplitude.
3. **Mesh and equilibrium convergence:** refine the FEM mesh and tighten equilibrium torque before
   comparing resonance positions or amplitudes.
4. **Airbox/demag convergence:** vary airbox extent, closure, and Poisson tolerance when dynamic
   demagnetization is enabled.
5. **Frequency refinement:** refine sampling around every peak; a coarse smooth curve can miss the
   true maximum and linewidth.
6. **Unit audit:** verify `m_complex`, $M_s$ scaling, drive units, susceptibility convention, volume
   reduction, and absorbed-power formula against an independent SI calculation.
7. **CPU/GPU parity:** compare the same operator digest, true residual, complex response, and units,
   while proving the actual residency/transfer path.

### Reduced-order tests

A modal or Schur result is accepted only after comparing selected points with the full-order solve
and verifying the full-operator residual. A reduced residual alone is insufficient, particularly
outside the basis-certification frequency interval.

(numerical-methods-frequency-response-limitations)=
## Limitations and current contract gaps

- The solver is linear response only; nonlinear frequency shifts, harmonic generation, and
  large-angle saturation are outside this contract.
- Native FDM response is unsupported.
- Several solver-tree lanes exist in architecture headers but are rejected by the current explicit
  runtime method gate.
- Nonzero-$k$ dynamic demagnetization is not production-qualified; see {doc}`floquet-response`.
- GPU-operator/host-Krylov and device-resident Krylov are distinct claims; the latter is not implied.
- The v1 dense artifact labels a reduced-magnetization/field projection as dimensionless
  susceptibility; its SI contract must be corrected before physical interpretation.
- The v1 dense artifact's absorbed-power label requires independent verification of $\mu_0M_s$,
  volume, and operator scaling.
- The native writer labels its drive-projected susceptibility provenance explicitly, but its
  absorbed quantity remains a non-volume-weighted proxy with `physical_power_density=false`; it is
  not the full SI power-density equation above.
- Solver `rtol` does not establish equilibrium, mesh, airbox, frequency, or model convergence.
- The public observable request does not guarantee that every writer materializes every output.

(numerical-methods-frequency-response-scientific-bibliography)=
## Scientific bibliography

1. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**, 155
   (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
2. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C* **19**,
   7013--7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
3. Y. Saad and M. H. Schultz, “GMRES: A generalized minimal residual algorithm for solving
   nonsymmetric linear systems,” *SIAM Journal on Scientific and Statistical Computing* **7**,
   856--869 (1986), [doi:10.1137/0907058](https://doi.org/10.1137/0907058).
4. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(numerical-methods-frequency-response-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Public response schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | request fields | Python source/tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | stage and solver-policy construction | Python source/tests |
| Public callable | `packages/fullmag-py/src/fullmag/world.py` | `add_frequency_response` | public builder entry point | Python source/tests |
| Solver policy | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | names and numeric validation | Python source/tests |
| ProblemIR response | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | validation and exact IR shape | Python source/tests |
| Response observable | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveResponse` | accepted output names | Python source/tests |
| Wave-vector lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `coerce_k_sampling` | exact sampling object and exclusivity | Python source/tests |
| K-point lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class KPoint` | exact nested point object | Python source/tests |
| K-path lowering | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class KPath` | exact path object | Python source/tests |
| Native legality | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | native request validation | native source |
| Native response ABI | `backends/fem/include/frequency_domain/driven_response_solver.hpp` | `solve_driven_frequency_response` | production entry-point declaration | native source |
| Native response implementation | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_driven_frequency_response` | production solve and artifacts | native source/tests |
| Solver plan | `backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp` | `struct FrequencySolvePlan` | selected lane, representation, solver, preconditioner, and gates | header contract |
| Planner request overload | `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` | `plan_frequency_response(const FrequencySolvePlannerInput&)` | direct planner-input selection | header contract/tests |
| Planner capability overload | `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` | `plan_frequency_response(const FrequencyBackendCapabilities&, const FrequencySolverPolicy&)` | capability/policy selection | header contract/tests |
| Runtime lane gate | `crates/fullmag-runner/src/frequency_response.rs` | `frequency_response_solver_method_rejection_reason` | current executable subset | runner tests |
| Runtime resolved lane | `crates/fullmag-runner/src/frequency_response.rs` | `resolved_frequency_response_solver_method_name` | resolved method identity | runner source/tests |
| Block-real reference | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_block_real_harmonic_response` | dense validation system | unit tests |
| Block-real sweep | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_field_driven_block_real_sweep_with_interrupt` | pointwise solve and interruption | unit tests |
| v1 artifact writer | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `build_field_driven_response_sweep_artifact` | response artifact assembly | source audit |
| v1 unit map | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `response_sweep_si_units` | serialized SI labels | source audit |
| v1 derived point | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `field_driven_response_point` | derived response scalars | source audit |

## Scope and purpose

This page defines the public frequency-domain response contract: the stage authoring call, the linearized operator, solver-policy lowering, response observables, and the boundary between planned solver-tree capability and the currently executable lane. The Python API, ProblemIR, implementation mapping, and adjacent source map are the source-backed contract.

## Scientific and numerical model

For a harmonic perturbation, the response is evaluated at prescribed frequency samples using the linearized Landau-Lifshitz-Gilbert operator and the declared magnetostatic and dynamic boundary conditions. The reported quantity must preserve the numerator, drive normalization, phase convention, and SI unit. The page's governing-equation section gives the model-specific equations; this contract does not silently change normalization or boundary conditions.

## Parameters

Use exactly the callable names, defaults, and validation rules in the `## Python API` section: frequency samples, excitation amplitude and phase, observable, equilibrium source, damping and magnetostatic policies, boundary data, wave-vector sampling, and solver policy. Frequencies are in hertz (`Hz`), excitation field in amperes per metre (`A m^-1`), phase in radians (`rad`), and wave vectors in inverse metres (`m^-1`). Unsupported combinations must remain explicitly gated.

## Control Room workflow

Select the frequency-response study in Control Room, configure the same fields as the Python stage, inspect the resolved solver policy and response-output metadata, and submit only when the capability register marks the lane executable. A visible editor field is not proof of backend support; planned, validation-only, and runtime-gated states remain distinct.

## Diagnostics and failure semantics

Reject empty or non-finite frequency samples, invalid excitation and boundary data, mutually exclusive wave-vector specifications, and solver policies outside the declared runtime subset. Preserve requested and resolved method names, per-frequency status, residual and artifact unit metadata. Never present a planned solver-tree route as an executed production solve.

## Where this is implemented

The implementation mapping and source-code index above identify the public stage, ProblemIR, native validation, runtime resolver, response solve, artifact writer, and planned planner owners. The adjacent `response-solver.source-map.json` records the exact paths, declarations, backend matrix, and reviewed revision. The four `DOC-ANCHOR` declarations in this page are documentation-only contract anchors and are marked `planned_contract` in the map.