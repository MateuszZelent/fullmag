---
title: Response Solver
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0700-frequency-domain-linearized-llg.md
---

(public-docs-numerical-methods-frequency-domain-response-solver)=
(numerical-methods-frequency-domain-response-solver)=
# Driven frequency-response solver

This chapter specifies the harmonic driven response formulation around a static micromagnetic
equilibrium $\mathbf m_0(\mathbf x)$. Whereas the modal eigensolver ({doc}`/numerical-methods/eigensolvers/linearized-llg`)
solves the homogeneous generalized eigenvalue problem $(\mathsf K - \mathrm i\omega\mathsf G)\widehat{\mathbf q} = \mathbf 0$
for discrete resonant frequencies, the driven frequency-response solver evaluates the steady-state
forced complex amplitude $\widehat{\mathbf q}(\omega)$ across a user-prescribed grid of positive
drive frequencies $f \in \{f_1,\dots,f_{N_\omega}\}$ ($\omega = 2\pi f$) under an external
harmonic magnetic field $\widehat{\mathbf h}_{\mathrm{ext}}$.

(response-solver-problem-statement)=
(problem-statement)=
## 1. Physical problem and harmonic response scope

Given a verified equilibrium $\mathbf m_0(\mathbf x)$ on a shared magnetic-plus-airbox finite-element
mesh $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$ and a weak time-harmonic excitation field, the
forced linearized LLG problem determines the complex steady-state response amplitude
$\widehat{\mathbf m}(\mathbf x, \omega) \in T_{\mathbf m_0(\mathbf x)}S^2$ at each angular frequency
$\omega = 2\pi f > 0$, together with derived dynamic susceptibility and power-absorption spectra.

(response-solver-governing-equations)=
(governing-equations)=
## 2. Governing equations

### 2.1 Time-harmonic ansatz and shifted tangent system

For a harmonic drive at angular frequency $\omega > 0$, the reduced magnetization perturbation and
external drive field are represented in the $\mathrm e^{-\mathrm i\omega t}$ phase convention by:

```{math}
:label: eq-numerical-frequency-response-ansatz
\delta\mathbf m(\mathbf x, t) = \operatorname{Re}\!\left\{\widehat{\mathbf m}(\mathbf x)\,\mathrm e^{-\mathrm i\omega t}\right\},
\qquad
\mathbf h_{\mathrm{ext}}(\mathbf x, t) = \operatorname{Re}\!\left\{\widehat{\mathbf h}_{\mathrm{ext}}(\mathbf x)\,\mathrm e^{-\mathrm i\omega t}\right\}.
```

Projecting onto the local orthonormal tangent basis $(\mathbf e_1(\mathbf x), \mathbf e_2(\mathbf x))$
yields the shifted complex linear system at each frequency sample $\omega$:

```{math}
:label: eq-numerical-frequency-response-system
\mathsf A(\omega)\,\widehat{\mathbf q}
=
\bigl(\mathsf K - \mathrm i\omega\mathsf G\bigr)\widehat{\mathbf q}
=
\widehat{\mathbf b}(\omega),
\qquad
\widehat{\mathbf b}(\omega) = \mathsf C\,\widehat{\mathbf h}_{\mathrm{ext}}.
```

In the canonical rate-operator normalization (`LinearizedDynamicPencil`), $\mathsf K = L = \gamma_0 J A_{\mathrm{tot}}$
(in $\mathrm{s^{-1}}$), $\mathsf G = B_\alpha = I - \alpha_{\mathrm{eff}}J$ (dimensionless, $1$),
$\mathsf A(\omega)$ has unit $\mathrm{s^{-1}}$, and the drive coupling operator $\mathsf C = \gamma_0 J T^\top$
(in $\mathrm{m\,A^{-1}\,s^{-1}}$) maps $\widehat{\mathbf h}_{\mathrm{ext}}$ (in $\mathrm{A\,m^{-1}}$)
to $\widehat{\mathbf b}$ (in $\mathrm{s^{-1}}$). Once $\widehat{\mathbf q} = [\widehat q_1, \widehat q_2]^\top$
is obtained, the three-component Cartesian perturbation is reconstructed via:

```{math}
:label: eq-numerical-frequency-response-reconstruction
\widehat{\mathbf m}(\mathbf x)
=
\widehat q_1(\mathbf x)\mathbf e_1(\mathbf x) + \widehat q_2(\mathbf x)\mathbf e_2(\mathbf x),
\qquad
\mathbf m_0(\mathbf x)\cdot\widehat{\mathbf m}(\mathbf x) = 0.
```

(numerical-methods-frequency-response-si-observable-reference)=
### 2.2 Dynamic susceptibility and cycle-averaged absorbed power

The physical magnetization response is $\widehat{\mathbf M}(\mathbf x) = M_s(\mathbf x)\widehat{\mathbf m}(\mathbf x)$
(in $\mathrm{A\,m^{-1}}$). The dimensionless physical Polder susceptibility tensor
$\widehat{\boldsymbol\chi}_M$ and the reduced-magnetization susceptibility tensor
$\widehat{\boldsymbol\chi}_m$ (in $\mathrm{m\,A^{-1}}$) are defined by:

```{math}
:label: eq-numerical-frequency-response-physical-susceptibility
\widehat{\mathbf M}(\omega)
=
M_s\,\widehat{\mathbf m}(\omega)
=
\widehat{\boldsymbol\chi}_M(\omega)\,\widehat{\mathbf h}_{\mathrm{ext}}(\omega),
```

```{math}
:label: eq-numerical-frequency-response-reduced-susceptibility
\widehat{\mathbf m}(\omega)
=
\widehat{\boldsymbol\chi}_m(\omega)\,\widehat{\mathbf h}_{\mathrm{ext}}(\omega).
```

In the current v1 dense sweep writer (`field_driven_response_point`), the scalar drive-projected
reduced susceptibility is evaluated as:

```{math}
:label: eq-numerical-frequency-response-v1-susceptibility
\chi_{\mathrm{v1}}(\omega)
=
\frac{\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf m}(\omega)}{\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf h}_{\mathrm{ext}}}.
```

The cycle-averaged absorbed magnetic power density (in $\mathrm{W\,m^{-3}}$) is:

```{math}
:label: eq-numerical-frequency-response-absorbed-power
p_{\mathrm{abs}}(\omega)
=
\frac{1}{2}\mu_0\omega\,\operatorname{Im}\!\left\{\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf M}(\omega)\right\}.
```

### 2.3 Unpreconditioned true residual gate

For every frequency sample $\omega$, acceptance of $\widehat{\mathbf q}$ is gated on the
unpreconditioned residual of the original shifted operator $\mathsf A(\omega)$:

```{math}
:label: eq-numerical-frequency-response-residual
\mathbf r(\omega) = \widehat{\mathbf b}(\omega) - \mathsf A(\omega)\widehat{\mathbf q}(\omega),
```

```{math}
:label: eq-numerical-frequency-response-relative-residual
\varepsilon_{\mathrm{true}}(\omega)
=
\frac{\lVert\mathbf r(\omega)\rVert_2}{\max\!\bigl(\lVert\widehat{\mathbf b}(\omega)\rVert_2,\, b_{\mathrm{scale}}\bigr)}.
```

(response-solver-symbols-and-si-units)=
(symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\delta\mathbf m$ | dynamic reduced-magnetization perturbation | $1$ |
| $\mathbf m_0$ | equilibrium reduced magnetization | $1$ |
| $\widehat{\mathbf m}$ | complex reduced-magnetization response amplitude | $1$ |
| $\widehat{\mathbf M}$ | complex physical magnetization response amplitude $M_s\widehat{\mathbf m}$ | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf h}_{\mathrm{ext}}$ | complex harmonic excitation-field amplitude | $\mathrm{A\,m^{-1}}$ |
| $\mathsf A(\omega)$ | shifted complex tangent response operator $\mathsf K - \mathrm i\omega\mathsf G$ (rate normalization) | $\mathrm{s^{-1}}$ |
| $\mathsf K$ | tangent rate-stiffness dynamic matrix (or $\mathrm{J}$ in energy-Hessian form) | $\mathrm{s^{-1}}$ |
| $\mathsf G$ | damping-modified tangent metric $I - \alpha_{\mathrm{eff}}J$ (or $\mathrm{J\,s}$ in energy-Hessian form) | $1$ |
| $\omega$ | angular drive frequency $2\pi f$ | $\mathrm{rad\,s^{-1}}$ |
| $t$ | time | $\mathrm{s}$ |
| $\widehat{\mathbf q}$ | complex tangent-coordinate response vector | $1$ |
| $\widehat{\mathbf b}$ | assembled harmonic drive right-hand side vector (rate normalization) | $\mathrm{s^{-1}}$ |
| $\mathsf C$ | gyromagnetic tangent drive-coupling operator $\gamma_0 J T^\top$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\mathbf e_1$ | first local orthonormal tangent basis vector | $1$ |
| $\mathbf e_2$ | second local orthonormal tangent basis vector | $1$ |
| $\widehat{\boldsymbol\chi}_M$ | physical Polder susceptibility tensor ($\widehat{\mathbf M}$ per $\widehat{\mathbf h}_{\mathrm{ext}}$) | $1$ |
| $\widehat{\boldsymbol\chi}_m$ | reduced-magnetization susceptibility tensor ($\widehat{\mathbf m}$ per $\widehat{\mathbf h}_{\mathrm{ext}}$) | $\mathrm{m\,A^{-1}}$ |
| $\chi_{\mathrm{v1}}$ | projected scalar reduced susceptibility $\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf m}/\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf h}_{\mathrm{ext}}$ | $\mathrm{m\,A^{-1}}$ |
| $p_{\mathrm{abs}}$ | cycle-averaged absorbed magnetic power density | $\mathrm{W\,m^{-3}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf r$ | unpreconditioned original-operator residual $\widehat{\mathbf b} - \mathsf A(\omega)\widehat{\mathbf q}$ | $\mathrm{s^{-1}}$ |
| $\varepsilon_{\mathrm{true}}$ | dimensionless true relative linear-solve residual | $1$ |
| $b_{\mathrm{scale}}$ | absolute right-hand-side residual normalization floor | $\mathrm{s^{-1}}$ |

(response-solver-assumptions-and-validity)=
(assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

* **Stationary equilibrium**: $\mathbf m_0$ must be a converged static equilibrium; driving around a
  high-torque state invalidates the linear susceptibility tensor.
* **Damping regularization on the real frequency axis**: If `damping_policy="ignore"` ($\alpha_{\mathrm{eff}}=0$),
  $\mathsf A(\omega)$ becomes exactly singular whenever $\omega$ coincides with an undamped
  eigenfrequency $\omega_n$. Physical line-shape sweeps should use `damping_policy="include"` with
  $\alpha > 0$.
* **Explicit solver-method runtime gate**: In the current runner
  (`frequency_response_solver_method_rejection_reason`), omitting `solver_method` (`None`) or
  selecting `auto` / `schur_gmres` / `dense_reference` is accepted, whereas explicit selection of
  `cpu_sparse_direct`, `full_coupled_field_split`, `modal_reduced`, or `gpu_device_krylov` fails
  closed until runtime qualification for those explicit routes is enabled.

(response-solver-python-api)=
(python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

```python
# %% Imports and study setup
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_driven_fmr_sweep")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

box = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="box"),
    name="box",
)
box.Ms = 8.0e5
box.Aex = 1.3e-11
box.alpha = 0.01
box.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.zeeman(field=(4.0e4, 0.0, 0.0))
study.demag(model="airbox", variant="robin")

# %% Relax equilibrium and run driven frequency-response sweep
study.stages.add_relax(
    stage_id="relax_eq",
    algorithm="nonlinear_cg",
    max_steps=5_000,
    tolT=1.0e-8,
)
study.stages.add_frequency_response(
    stage_id="fmr_sweep",
    frequencies_hz=[4.0e9, 6.0e9, 8.0e9, 10.0e9],
    excitation_field_au_per_m=(0.0, 100.0, 0.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
    magnetostatic_bc="open",
    solver_method="auto",
    solver_preconditioner="auto",
    solver_rtol=1.0e-8,
    solver_max_iterations=200,
    solver_restart_iterations=30,
)
```

### `add_frequency_response` / `FrequencyResponse` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `frequencies_hz` | `Sequence[float]` | `required` | $\mathrm{Hz}$ | nonempty; every value finite and positive | prescribed response samples | FEM | `frequencies_hz.values_hz` |
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

(response-solver-problem-ir)=
(problem-ir)=
## 6. ProblemIR, normalization, and provenance

`FrequencyResponse.to_ir_dict` lowers the stage into `StudyIR::FrequencyResponse` with explicit
frequency grid, excitation vector/phase, operator flags, and `solver_policy`:

```json
{
  "kind": "frequency_response",
  "frequencies_hz": {
    "kind": "explicit",
    "values_hz": [4000000000.0, 6000000000.0, 8000000000.0, 10000000000.0]
  },
  "excitation": {
    "kind": "uniform_field",
    "field_au_per_m": [0.0, 100.0, 0.0],
    "phase_rad": 0.0
  },
  "operator": {
    "kind": "linearized_llg",
    "include_demag": true
  },
  "damping_policy": "include",
  "magnetostatic_bc": "open",
  "solver_policy": {
    "method": "auto",
    "preconditioner": "auto",
    "rtol": 1e-8,
    "max_iterations": 200,
    "restart_iterations": 30
  }
}
```

(response-solver-round-trip-and-failure-semantics)=
(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves `frequencies_hz`, `excitation_field_au_per_m`,
  `excitation_phase_rad`, `observable`, `include_demag`, `damping_policy`, `magnetostatic_bc`, and
  `solver_policy` across Python $\leftrightarrow$ `ProblemIR` serialization.
* **Resolved execution**: records `resolved_frequency_response_solver_method_name`, operator digest,
  per-frequency iteration count, unpreconditioned residual $\varepsilon_{\mathrm{true}}(\omega)$,
  and convergence status.
* **Validation errors**: fail closed on empty or non-positive `frequencies_hz`, conflicting
  `k_vector` and `k_sampling`, or `solver_restart_iterations > solver_max_iterations`.
* **Unsupported combinations**: fail closed when FDM is requested, or when an unenabled explicit
  solver-tree method is rejected by `frequency_response_solver_method_rejection_reason`.

(response-solver-discrete-realization)=
(discrete-realization)=
## 8. Discrete realization and execution sequence

1. **Equilibrium and tangent basis setup**: materializes $\mathbf m_0$ and constructs the nodal
   tangent basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ and `LinearizedDynamicPencil`.
2. **Frequency-independent operator Reuse**: assembles the frequency-independent tangent blocks
   ($L, B_\alpha$ or $A_{qq}, A_{q\phi}, A_{\phi q}, P, B_{qq}$) once outside the frequency loop.
3. **Per-frequency shifted solve**: at each sample $\omega_j = 2\pi f_j$, evaluates
   $\mathsf A(\omega_j)\widehat{\mathbf q}_j = \widehat{\mathbf b}(\omega_j)$ via the native C++
   solver (`solve_driven_frequency_response`) or the runner's real-split block solver
   (`solve_block_real_harmonic_response` / `solve_field_driven_block_real_sweep_with_interrupt`).
4. **True residual gate and observable reduction**: verifies
   $\varepsilon_{\mathrm{true}}(\omega_j) \le \mathrm{rtol}$ and writes the susceptibility and power
   spectra via `build_field_driven_response_sweep_artifact`.

(numerical-methods-frequency-response-planner-struct-source)=
(numerical-methods-frequency-response-planner-input-overload-source)=
(numerical-methods-frequency-response-planner-capability-overload-source)=
(response-solver-implementation-mapping)=
(implementation-mapping)=
## 9. Implementation mapping

| Architectural stage | Python / Planner owner | Runner / Native C++ owner |
|---|---|---|
| Stage authoring and IR lowering | `FrequencyResponseStageSpec`, `FrequencyResponse`, and `FrequencyResponseSolverPolicy` | `frequency_response_solver_method_rejection_reason` and `resolved_frequency_response_solver_method_name` |
| Native planner and request validation | `struct FrequencySolvePlan` and `plan_frequency_response` | `validate_driven_frequency_response_request` |
| Shifted harmonic linear solve | `solve_driven_frequency_response` ABI | `solve_driven_frequency_response` and `solve_block_real_harmonic_response` |
| Sweep orchestration and artifact emission | `SaveResponse` | `solve_field_driven_block_real_sweep_with_interrupt`, `field_driven_response_point`, and `build_field_driven_response_sweep_artifact` |

(response-solver-validation)=
(validation)=
## 10. Validation and qualification

| Validation check | Mathematical criterion | Evidence source |
|---|---|---|
| True residual gate | $\varepsilon_{\mathrm{true}}(\omega) = \lVert\widehat{\mathbf b} - \mathsf A(\omega)\widehat{\mathbf q}\rVert_2 / \max(\lVert\widehat{\mathbf b}\rVert_2, b_{\mathrm{scale}}) \le \mathrm{rtol}$. | `solve_driven_frequency_response` and `solve_block_real_harmonic_response`. |
| Resonance Lorentzian peak | Driven susceptibility peak frequency at small $\alpha$ matches the corresponding modal eigenfrequency $f_n$ from `Eigenmodes`. | Cross-stage modal vs driven consistency check. |
| Passivity ($\alpha > 0$) | Cycle-averaged absorbed power satisfies $p_{\mathrm{abs}}(\omega) \ge 0$ for all $\omega > 0$. | `field_driven_response_point` sign check. |

(response-solver-limitations)=
(limitations)=
## 11. Limitations and failure modes

* **Known v1 unit metadata note**: In `crates/fullmag-runner/src/eigen/response_block_real.rs`,
  `response_sweep_si_units` currently labels `susceptibility_tensor` as `"1"` (dimensionless),
  whereas the scalar projection $\chi_{\mathrm{v1}} = \widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf m}/\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf h}_{\mathrm{ext}}$
  computed from dimensionless $\widehat{\mathbf m}$ and $\widehat{\mathbf h}_{\mathrm{ext}}$ in
  $\mathrm{A\,m^{-1}}$ carries physical unit $\mathrm{m\,A^{-1}}$ (multiplying by $M_s$ yields the
  dimensionless Polder susceptibility $\widehat{\boldsymbol\chi}_M$).
* **Undamped resonance poles**: Running with `damping_policy="ignore"` at a frequency coinciding
  with an undamped mode produces a singular matrix $\mathsf A(\omega_n)$ and a failed linear solve.

(response-solver-scientific-bibliography)=
(scientific-bibliography)=
## 12. Scientific bibliography

1. D. Polder, “On the theory of ferromagnetic resonance,” *Philosophical Magazine*, 40, 99–115 (1949).
2. A. G. Gurevich and G. A. Melkov, *Magnetization Oscillations and Waves*, CRC Press, 1996.
3. FullMag physics contracts: `docs/physics/0700-frequency-domain-linearized-llg.md` and `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.

(response-solver-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2816) | [`class FrequencyResponseStageSpec`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L2816) | Public frequency-response stage schema. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3272) | [`frequency_response_stage`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L3272) | Public stage and solver-policy construction. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4683) | [`add_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/world.py#L4683) | Public StudyStagesBuilder frequency-response entry point. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L114) | [`class FrequencyResponseSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L114) | Solver-policy names and numeric validation. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1250) | [`class FrequencyResponse`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L1250) | Frequency-response validation and exact ProblemIR lowering. |
| [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | [`class SaveResponse`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | Supported response-output vocabulary and lowering. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | [`coerce_k_sampling`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | Exact single-point/path wave-vector lowering and mutual exclusion. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L165) | [`class KPoint`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L165) | Exact nested K-point label and vector lowering. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | [`class KPath`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | Exact ordered K-path points, segment counts, and closed-flag lowering. |
| [`backends/fem/src/frequency_domain/operator_contract.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | [`validate_driven_frequency_response_request`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | Native operator and boundary legality checks. |
| [`backends/fem/include/frequency_domain/driven_response_solver.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/driven_response_solver.hpp#L177) | [`solve_driven_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/driven_response_solver.hpp#L177) | Production driven-response ABI declaration. |
| [`backends/fem/src/frequency_domain/driven_response_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/driven_response_solver.cpp#L16901) | [`solve_driven_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/driven_response_solver.cpp#L16901) | Production validation, lane dispatch, solve, residual, and artifact entry point. |
| [`public_docs/site/numerical-methods/frequency-domain/response-solver.md`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L391) | [`DOC-ANCHOR:numerical-methods-frequency-response-si-observable-reference`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L391) | Literature-backed target definitions for full-SI susceptibility and magnetic work. |
| [`public_docs/site/numerical-methods/frequency-domain/response-solver.md`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L392) | [`DOC-ANCHOR:numerical-methods-frequency-response-planner-struct-source`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L392) | Validated documentation identity for `backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp` (`struct FrequencySolvePlan`). |
| [`public_docs/site/numerical-methods/frequency-domain/response-solver.md`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L393) | [`DOC-ANCHOR:numerical-methods-frequency-response-planner-input-overload-source`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L393) | Validated documentation identity for `plan_frequency_response(const FrequencySolvePlannerInput&)`. |
| [`public_docs/site/numerical-methods/frequency-domain/response-solver.md`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L394) | [`DOC-ANCHOR:numerical-methods-frequency-response-planner-capability-overload-source`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/public_docs/site/numerical-methods/frequency-domain/response-solver.md#L394) | Validated documentation identity for `plan_frequency_response(const FrequencyBackendCapabilities&, const FrequencySolverPolicy&)`. |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/frequency_response.rs#L212) | [`frequency_response_solver_method_rejection_reason`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/frequency_response.rs#L212) | Current runtime availability boundary for explicit solver methods. |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/frequency_response.rs#L199) | [`resolved_frequency_response_solver_method_name`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/frequency_response.rs#L199) | Resolved runtime method identity. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L226) | [`solve_block_real_harmonic_response`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L226) | Dense block-real validation solve. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L134) | [`solve_field_driven_block_real_sweep_with_interrupt`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L134) | Per-frequency sweep, reuse, and interruption semantics. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L199) | [`build_field_driven_response_sweep_artifact`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L199) | Dense response artifact assembly. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L305) | [`response_sweep_si_units`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L305) | Current v1 serialized unit metadata. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L328) | [`field_driven_response_point`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/response_block_real.rs#L328) | Current v1 derived response observables. |

## Cross-links

* {doc}`index`
* {doc}`floquet-response`
* {doc}`/python-api/studies/frequency-response`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`
