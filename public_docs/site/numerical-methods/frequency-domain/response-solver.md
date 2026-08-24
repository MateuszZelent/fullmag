---
title: Response Solver
status: partial
reviewed_revision: 0388c3e7c4804923ee02a00b7ac4a789a44092d9
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
\mathsf A(\omega)=\mathrm i\omega\mathsf B-\mathsf L.
```

$\mathsf L$ is the linearized magnetic evolution operator and $\mathsf B$ is the gyrotropic/Gilbert
mass operator in the canonical magnetic response form. Both sides have unit $\mathrm{s^{-1}}$ for
dimensionless tangent coordinates. The assembled right-hand side contains the projected harmonic
drive. The exact scaling and signs are owned by the native operator contract and the recorded
`phase_convention`; they must not be reconstructed from plot labels.

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

| LaTeX token | Meaning | SI unit |
|---|---|---|
| $\delta\mathbf m$ | dynamic reduced-magnetization perturbation | $1$ |
| $\mathbf m_0$ | equilibrium reduced magnetization | $1$ |
| $\widehat{\mathbf m}$ | complex reduced-magnetization response amplitude | $1$ |
| $\widehat{\mathbf M}$ | complex physical magnetization response amplitude | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\delta\mathbf h_{\mathrm{ext}}$ | time-dependent excitation-field perturbation | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf h}_{\mathrm{ext}}$ | complex excitation-field amplitude | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf h}$ | complex drive vector used by the dense v1 projection | $\mathrm{A\,m^{-1}}$ |
| $\mathsf A(\omega)$ | shifted complex tangent response operator | $\mathrm{s^{-1}}$ |
| $\mathsf L$ | linearized magnetic evolution operator | $\mathrm{s^{-1}}$ |
| $\mathsf B$ | gyrotropic and Gilbert mass operator | $1$ |
| $\omega$ | angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $f$ | ordinary frequency | $\mathrm{Hz}$ |
| $t$ | time | $\mathrm{s}$ |
| $\widehat{\mathbf q}$ | complex tangent-coordinate response | $1$ |
| $\widehat{\mathbf b}$ | assembled harmonic right-hand side | $\mathrm{s^{-1}}$ |
| $A_R$ | real part of the dense complex response operator | $\mathrm{s^{-1}}$ |
| $A_I$ | imaginary part of the dense complex response operator | $\mathrm{s^{-1}}$ |
| $q_R$ | real part of the dense tangent response | $1$ |
| $q_I$ | imaginary part of the dense tangent response | $1$ |
| $b_R$ | real part of the dense right-hand side | $\mathrm{s^{-1}}$ |
| $b_I$ | imaginary part of the dense right-hand side | $\mathrm{s^{-1}}$ |
| $\mathbf e_1$ | first local tangent basis vector | $1$ |
| $\mathbf e_2$ | second local tangent basis vector | $1$ |
| $i$ | discrete magnetic degree-of-freedom index | $1$ |
| $\widehat{\boldsymbol\chi}_M$ | physical magnetization susceptibility, M response divided by H drive | $1$ |
| $\widehat{\boldsymbol\chi}_m$ | reduced-magnetization response divided by H drive | $\mathrm{m\,A^{-1}}$ |
| $\chi_{\mathrm{v1}}$ | current dense v1 scalar projection h^H m / h^H h; the writer label is a documented contract gap | $\mathrm{m\,A^{-1}}$ |
| $p_{\mathrm{abs}}$ | cycle-averaged absorbed magnetic power density after complete SI scaling and spatial reduction | $\mathrm{W\,m^{-3}}$ |
| $p_{\mathrm{v1}}$ | dense v1 drive-projected absorption proxy | proxy, not an SI power density |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf r$ | original-operator algebraic residual | $\mathrm{s^{-1}}$ |
| $\varepsilon_{\mathrm{true}}$ | true relative residual | $1$ |
| $b_{\mathrm{scale}}$ | absolute residual normalization floor | $\mathrm{s^{-1}}$ |
| $\operatorname{Re}$ | real-part operator | $1$ |
| $\operatorname{Im}$ | imaginary-part operator | $1$ |
| $\mathrm i$ | imaginary unit | $1$ |
| $(\cdot)^{\ast}$ | complex-conjugation operator | $1$ |
| $\lVert\cdot\rVert_2$ | Euclidean-norm operator | $1$ |
| $\max$ | maximum operator | $1$ |

(numerical-methods-frequency-response-susceptibility)=
## Susceptibility and response-unit conventions

The physical formulas in this section are transcribed from the canonical contracts
`docs/physics/0700-frequency-domain-linearized-llg.md` (response observables) and
`docs/specs/frequency-domain-artifacts-v2.md` (Response observable units). They are target physical
contracts, not proof that every current writer realizes the full scaling and spatial reduction.

Two quantities that are often both called “susceptibility” are dimensionally different:

```{math}
:label: eq-numerical-frequency-response-physical-susceptibility
\widehat{\boldsymbol\chi}_{M}(\omega)
=\frac{\widehat{\mathbf M}(\omega)}
{\widehat{\mathbf h}_{\mathrm{ext}}(\omega)},
\qquad
\widehat{\mathbf M}=M_s\widehat{\mathbf m},
```

which is dimensionless in SI, and

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

with an explicitly declared local or volume-averaged reduction. The dense validation writer instead
evaluates the proxy

```{math}
:label: eq-numerical-frequency-response-v1-absorbed-proxy
p_{\mathrm{v1}}
=-\frac{\omega}{2}\operatorname{Im}
\left(\widehat{\mathbf h}^{\ast}\widehat{\mathbf m}\right),
```

and labels it $\mathrm{W\,m^{-3}}$; therefore the native scaling, $M_s$, $\mu_0$, and volume
normalization must be certified before using that field as a physical power density. This explicit
contract gap prevents the proxy implementation from serving as source evidence for the physical
$p_{\mathrm{abs}}$ equation above.

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
- A zero excitation is accepted by the native solver and returns a zero response with an explicit
  warning; susceptibility or another drive-normalized observable is not physically interpretable
  for that request.
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

| Public parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination and normalization |
|---|---|---|---|---|---|---|---|
| `study.stages.add_frequency_response.frequencies_hz` | `Sequence[float]` | required | $\mathrm{Hz}$ | nonempty; every value finite and greater than zero | requested response samples | FEM CPU/GPU; FDM unsupported | `study.frequencies_hz.values_hz`; sequence becomes a JSON array |
| `study.stages.add_frequency_response.excitation_field_au_per_m` | `tuple[float, float, float]` | `(0.0, 0.0, 1.0)` | $\mathrm{A\,m^{-1}}$ | exactly three finite float-coercible values; zero drive is allowed and reported as a zero-response warning | real drive vector before phase rotation | FEM CPU/GPU; FDM unsupported | `study.excitation.field_au_per_m`; tuple becomes a three-value JSON array |
| `study.stages.add_frequency_response.excitation_phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite float | global harmonic-drive phase | FEM CPU/GPU; FDM unsupported | `study.excitation.phase_rad`; converted to float |
| `study.stages.add_frequency_response.observable` | `str` | `susceptibility_tensor` | `m_complex`: $1$; `u_complex`: $\mathrm{m}$; `strain_complex`: $1$; `stress_complex`: $\mathrm{Pa}$; `susceptibility_tensor`: $1$ with applied $M_s$, otherwise $\mathrm{m\,A^{-1}}$; `absorbed_power_density`: $\mathrm{W\,m^{-3}}$ only when `physical_power_density=true`, otherwise non-SI proxy; `response_amplitude`: $1$ for the current magnetic response; `response_phase`: $\mathrm{rad}$; `mode_hybridization_index`: $1$ | one of `m_complex`, `u_complex`, `strain_complex`, `stress_complex`, `susceptibility_tensor`, `absorbed_power_density`, `response_amplitude`, `response_phase`, `mode_hybridization_index` | requested response artifact | FEM CPU/GPU; writer materialization is capability-gated; FDM unsupported | `study.sampling.outputs[].observable`; wrapped as `frequency_response_output` |
| `study.stages.add_frequency_response.include_demag` | `bool` | `True` | $1$ | Boolean; planner enforces boundary and lane compatibility | include dynamic demagnetization | FEM CPU/GPU capability-gated; FDM unsupported | `study.operator.include_demag`; preserved Boolean |
| `study.stages.add_frequency_response.equilibrium_source` | `str` | `provided` | $1$ | one of `provided`, `relax`, `artifact` | equilibrium origin | FEM CPU/GPU; FDM unsupported | `study.equilibrium.kind`; `relax` normalizes to `relaxed_initial_state` |
| `study.stages.add_frequency_response.equilibrium_artifact` | `str or None` | `None` | $1$ | required and nonempty for `artifact`; any supplied value must be nonempty | equilibrium artifact path | FEM CPU/GPU; FDM unsupported | `study.equilibrium.path` only for artifact equilibrium |
| `study.stages.add_frequency_response.normalization` | `str` | `unit_l2` | $1$ | one of `unit_l2`, `unit_max_amplitude` | internal tangent/modal basis normalization, not drive amplitude | FEM CPU/GPU; FDM unsupported | `study.normalization`; preserved enum string |
| `study.stages.add_frequency_response.damping_policy` | `str` | `ignore` | $1$ | one of `ignore`, `include` | Gilbert damping inclusion in the harmonic operator | FEM CPU/GPU; FDM unsupported | `study.damping_policy`; preserved enum string |
| `study.stages.add_frequency_response.k_vector` | `tuple[float, float, float] or None` | `None` | $\mathrm{rad\,m^{-1}}$ | exactly three float-coercible values; mutually exclusive with `k_sampling` | legacy single Bloch wave vector | FEM CPU/GPU Floquet gate; FDM unsupported | `study.k_sampling`; normalizes to a `single` sample |
| `study.stages.add_frequency_response.k_sampling` | `KPoint, KPath, three-vector, or None` | `None` | $\mathrm{rad\,m^{-1}}$ | recognized object or three-vector; mutually exclusive with `k_vector`; path shape validated by constructors | single or path Bloch sampling | FEM CPU/GPU Floquet gate; FDM unsupported | `study.k_sampling`; object is serialized by `to_ir()` |
| `study.stages.add_frequency_response.bc` | `str, dict, PeriodicBC, or FloquetBC` | `free` | $1$ | string or raw dict `kind` must be one of `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy`; Python validates no other raw-dict structure; `PeriodicBC` and `FloquetBC` constructors require nonempty pair IDs; planner enforces structural prerequisites | dynamic-magnetization boundary condition | FEM CPU/GPU capability-gated; FDM unsupported | `study.spin_wave_bc`; objects normalize through `to_ir()` while raw dicts are preserved |
| `study.stages.add_frequency_response.magnetostatic_bc` | `str` | `open` | $1$ | one of `open`, `periodic_airbox_k0`, `floquet_airbox`; planner enforces coupled prerequisites | dynamic magnetostatic closure | FEM CPU/GPU capability-gated; FDM unsupported | `study.magnetostatic_bc`; preserved enum string |
| `study.stages.add_frequency_response.solver_method` | `str or None` | `None` | $1$ | one of `auto`, `dense_reference`, `cpu_sparse_direct`, `full_coupled_field_split`, `schur_reduced`, `modal_reduced`, `gpu_operator_host_krylov`, `gpu_device_krylov`; runtime gates executable subset | requested algebraic route | FEM CPU/GPU bounded subset; FDM unsupported | `study.solver_policy.method`; omitted with the whole policy when all solver fields are `None` |
| `study.stages.add_frequency_response.solver_preconditioner` | `str or None` | `None` | $1$ | one of `auto`, `graph_demag_coarse`, `demag_coarse`, `block_jacobi`, `none`; runtime checks lane compatibility | requested preconditioner | FEM CPU/GPU bounded subset; FDM unsupported | `study.solver_policy.preconditioner`; omitted when `None` |
| `study.stages.add_frequency_response.solver_rtol` | `float or None` | `None` | $1$ | finite and greater than zero when supplied | relative algebraic tolerance | FEM CPU/GPU iterative lanes; FDM unsupported | `study.solver_policy.rtol`; converted to float |
| `study.stages.add_frequency_response.solver_max_iterations` | `int or None` | `None` | $1$ | positive non-Boolean integer when supplied | Krylov iteration ceiling | FEM CPU/GPU iterative lanes; FDM unsupported | `study.solver_policy.max_iterations`; preserved integer |
| `study.stages.add_frequency_response.solver_restart_iterations` | `int or None` | `None` | $1$ | positive non-Boolean integer and no greater than `solver_max_iterations` when both are supplied | restarted-GMRES subspace length | FEM CPU/GPU iterative lanes; FDM unsupported | `study.solver_policy.restart_iterations`; preserved integer |
| `study.stages.add_frequency_response.MAX_ITERATIONS` | `int or None` | `None` | $1$ | compatibility alias; positive non-Boolean integer; conflicts with a different `solver_max_iterations` | legacy iteration ceiling spelling | FEM CPU/GPU iterative lanes; FDM unsupported | `study.solver_policy.max_iterations`; normalized to `solver_max_iterations` |

`observable="m_complex"` is used in the example because its stored quantity is unambiguous: complex
reduced magnetization. When requesting `susceptibility_tensor`, consumers must inspect the artifact
schema and SI-unit metadata rather than assume conventional dimensionless susceptibility.

(numerical-methods-frequency-response-problem-ir)=
## ProblemIR and provenance

The IR stores sampling, excitation, linearized operator, equilibrium, boundary conditions, output
intent, and solver policy separately. Required resolved provenance includes:

The example lowers to this canonical `StudyIR::FrequencyResponse` fragment before planning:

```json
{
  "kind": "frequency_response",
  "dynamics": {
    "kind": "llg",
    "gyromagnetic_ratio": 221100.0,
    "integrator": "auto",
    "fixed_timestep": null
  },
  "operator": {"kind": "linearized_llg", "include_demag": true},
  "equilibrium": {"kind": "provided"},
  "k_sampling": null,
  "normalization": "unit_l2",
  "damping_policy": "include",
  "spin_wave_bc": "free",
  "magnetostatic_bc": "open",
  "excitation": {"field_au_per_m": [0.0, 0.0, 1.0], "phase_rad": 0.0},
  "frequencies_hz": {"values_hz": [1000000000.0, 2000000000.0, 3000000000.0]},
  "sampling": {
    "outputs": [{"kind": "frequency_response_output", "observable": "m_complex"}]
  },
  "solver_policy": {
    "method": "auto",
    "preconditioner": "block_jacobi",
    "rtol": 1e-08,
    "max_iterations": 500,
    "restart_iterations": 50
  }
}
```

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

Script export preserves the full frequency sequence, excitation, phase, operator, boundary, output,
and solver policy. **Requested intent** remains in `StudyIR` and the request artifact; **resolved execution**
records the backend, device, precision, solver method, preconditioner, residency, and fallback
separately. **Validation errors** reject malformed values before execution. **Unsupported combinations**
fail explicitly rather than being rewritten into a different physical or execution request.
Validation failures include:

- empty, non-finite, or nonpositive frequency lists;
- zero drive is accepted only with explicit zero-response warning semantics; consumers must reject
  drive-normalized interpretation;
- missing or rejected equilibrium;
- unsupported explicit solver method;
- invalid boundary/Floquet metadata;
- unavailable dynamic demagnetization;
- incompatible device, precision, dependency, or preconditioner;
- singular direct operator or failed Krylov convergence;
- non-finite response, residual, or output;
- failed true-residual/full-block certification.

An unsupported request fails before execution. It cannot silently become FDM, free-boundary,
no-demag, CPU, dense validation, or a different solver method. Interrupted sweeps publish only an
explicitly partial artifact with completed-point count and requested-point count.

(numerical-methods-frequency-response-discrete-realization)=
## Discrete realization by lane

The dense validation/reference implementation converts its complex algebraic system to the exact
block-real form

```{math}
:label: eq-numerical-frequency-response-block-real
\begin{bmatrix}
A_R & -A_I \\
A_I & A_R
\end{bmatrix}
\begin{bmatrix}q_R\\q_I\end{bmatrix}
=
\begin{bmatrix}b_R\\b_I\end{bmatrix}.
```

This equation documents the algebraic oracle only. It does not certify that the dense v1
susceptibility or absorption proxy carries the full physical scaling.

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

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python stage schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | public response request | Python |
| Python stage builder | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | stage and solver-policy lowering | Python/IR |
| Native request validation | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | operator and boundary legality | FEM |
| Python policy validation | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | solver enum and numeric validation | Python/IR |
| Python study lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | canonical `StudyIR` fragment | Python/IR |
| Backend planning | `crates/fullmag-plan/src/lib.rs` | `plan` | rejects FDM and preserves requested/resolved backend | planner |
| FEM response planning | `crates/fullmag-plan/src/fem.rs` | `plan_fem_frequency_response` | FEM plan, device, precision, boundary, and capability gates | FEM planner |
| Native response solve | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_driven_frequency_response` | production/validation driven solve dispatch | FEM CPU/GPU |
| Native observable serialization | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `ResponsePointObservableJson build_response_point_observable_json` | distinguishes SI susceptibility from reduced-response and absorption proxies | FEM CPU/GPU |
| Runtime availability gate | `crates/fullmag-runner/src/frequency_response.rs` | `frequency_response_solver_method_rejection_reason` | rejects target lanes not yet executable | runner |
| Runtime resolved-name mapping | `crates/fullmag-runner/src/frequency_response.rs` | `resolved_frequency_response_solver_method_name` | broad runtime lane identity | runner |
| Dense block-real solve | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_block_real_harmonic_response` | complex system represented as a real $2n\times2n$ solve | validation/reference |
| Dense sweep and reuse | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_field_driven_block_real_sweep_with_interrupt` | per-frequency solve, template reuse, warm-start provenance | validation/reference |
| v1 response artifact | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `build_field_driven_response_sweep_artifact` | complex response, residuals, derived outputs, SI map | validation/reference |
| v1 derived observables | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `field_driven_response_point` | current susceptibility and absorbed-power calculations | validation/reference |
| v1 SI labels | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `response_sweep_si_units` | current serialized unit labels | validation/reference |

(numerical-methods-frequency-response-validation)=
## Verification and scientific validation

### Algebraic tests

1. Compare the block-real solve with a direct complex solve on the same tiny matrix.
2. Recompute the original operator residual independently of the solver recurrence.
3. Verify that the real/imaginary block layout reproduces
   {eq}`eq-numerical-frequency-response-block-real`.
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
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Public response schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` | request fields and validation | Python source/tests |
| Stage lowering | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` | canonical solver policy | Python/IR tests |
| Native legality | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` | native request validation | native source |
| Solver policy | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponseSolverPolicy` | solver-policy validation and serialization | Python tests |
| Study lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class FrequencyResponse` | canonical response `StudyIR` fragment | Python/IR tests |
| Backend selection | `crates/fullmag-plan/src/lib.rs` | `plan` | requested/resolved backend and FDM rejection | planner tests |
| FEM response plan | `crates/fullmag-plan/src/fem.rs` | `plan_fem_frequency_response` | response plan and capability gates | planner tests |
| Native response solve | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_driven_frequency_response` | native FEM response execution | native source/tests |
| Native observable contract | `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `ResponsePointObservableJson build_response_point_observable_json` | conditional SI susceptibility and explicit proxy provenance | native source/tests |
| Runtime lane gate | `crates/fullmag-runner/src/frequency_response.rs` | `frequency_response_solver_method_rejection_reason` | current executable subset | runner tests |
| Runtime resolved method | `crates/fullmag-runner/src/frequency_response.rs` | `resolved_frequency_response_solver_method_name` | resolved lane name | runner tests |
| Block-real reference | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_block_real_harmonic_response` | dense validation system | unit tests |
| Dense sweep | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `solve_field_driven_block_real_sweep_with_interrupt` | point loop, interruption, and reuse | unit tests |
| v1 artifact | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `build_field_driven_response_sweep_artifact` | artifact serialization | unit tests |
| v1 derived outputs | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `field_driven_response_point` | susceptibility and absorbed-power expressions | source audit |
| v1 unit labels | `crates/fullmag-runner/src/eigen/response_block_real.rs` | `response_sweep_si_units` | serialized SI map and known gaps | source audit |
| Canonical response observables | `public_docs/site/numerical-methods/frequency-domain/response-solver.md` | `DOC-ANCHOR:numerical-methods-frequency-response-susceptibility` | planned physical formulas transcribed from canonical physics/spec sources; not implementation evidence | planned contract |
