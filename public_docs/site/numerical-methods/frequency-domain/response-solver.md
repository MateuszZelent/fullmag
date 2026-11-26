---
title: Response Solver
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: /physics/foundations/llg-equation, /physics/foundations/observables
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
harmonic magnetic field $\widehat{\mathbf h}_{\mathrm{ext}}$, using either CPU/GPU Krylov solvers
or the RTX 4080 SUPER-qualified GPU direct sparse `cuDSS` solver (`gpu_sparse_direct`).

(response-solver-problem-statement)=
## 1. Physical problem and harmonic response scope

Given a verified equilibrium $\mathbf m_0(\mathbf x)$ on a shared magnetic-plus-airbox finite-element
mesh $\Omega = \Omega_m \cup \Omega_{\mathrm{air}}$ and a weak time-harmonic excitation field, the
forced linearized LLG problem determines the complex steady-state response amplitude
$\widehat{\mathbf m}(\mathbf x, \omega) \in T_{\mathbf m_0(\mathbf x)}S^2$ at each angular frequency
$\omega = 2\pi f > 0$, together with derived dynamic susceptibility and power-absorption spectra.
Accepted native FEM frequency-response sweeps run end-to-end with bounded artifact publication
([`collect_publish_accepted_frequency_response_artifacts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs#L279)).

(response-solver-governing-equations)=
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

### 2.2 Coupled augmented system and GPU `cuDSS` direct sparse solver

On FEM GPU (`solver_method="auto"` or `"gpu_sparse_direct"`), [`solve_driven_response_gpu_cudss`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss.cpp#L1301)
avoids nested Krylov iterations by assembling the coupled magnetic-tangent and magnetostatic
scalar-potential CSR system $Z_{\mathrm{aug}}(\omega)$ once from one-time exported Poisson sparse
blocks ([`export_demag_poisson_sparse_blocks`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp#L294)):

- **Exact 2×2 geometric block pre-scaling + 6-pass Ruiz equilibration:** Off-diagonal blocks in
  open-airbox P2 meshes span up to $10^{25}$ in magnitude ($O(10^{13})$ vs $O(10^{-12})$) alongside
  unit-diagonal Dirichlet `ess_tdofs` rows. Before six passes of Ruiz row/column infinity-norm
  equilibration $(D_r, D_c)$, exact 2×2 block geometric pre-scaling measures interior Poisson
  stiffness exclusively from multi-nonzero rows (`nnz > 1`) so unit-diagonal `ess_tdofs` rows do not
  mask interior scales, reducing perturbed pivots (`CUDSS_DATA_NPIVOTS`) to `0` across the entire
  sweep.
- **1× symbolic analysis + fast in-place GPU diagonal update:** All $4 N_{m,\mathrm{eff}}$
  frequency-dependent $2\times 2$ diagonal entries are reserved in the CSR sparsity pattern so
  `CUDSS_PHASE_ANALYSIS` executes strictly once per sweep (`symbolic_analysis_count == 1`). After
  post-analysis VRAM budget preflight (`FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` /
  `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB`), each frequency point updates only those
  $4 N_{m,\mathrm{eff}}$ entries in place on GPU via [`launch_driven_response_update_omega_entries`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L289)
  (zero CSR H2D recopy), runs general complex FP64 LU (`CUDA_C_64F`), and certifies both unscaled
  magnetic and Poisson residuals on GPU via [`launch_driven_response_unscaled_residual_cert`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L321).

### 2.3 Dynamic susceptibility and cycle-averaged absorbed power

The physical magnetization response is $\widehat{\mathbf M}(\mathbf x) = M_s(\mathbf x)\widehat{\mathbf m}(\mathbf x)$
(in $\mathrm{A\,m^{-1}}$). The dimensionless physical Polder susceptibility tensor
$\widehat{\boldsymbol\chi}_M$ and reduced-magnetization susceptibility tensor
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

### 2.4 Unpreconditioned true residual gate

For every frequency sample $\omega$, acceptance of $\widehat{\mathbf q}$ is gated on the
unpreconditioned unscaled residual of the original shifted operator $\mathsf A(\omega)$:

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

On GPU `cuDSS`, `launch_driven_response_unscaled_residual_cert` independently evaluates both the
magnetic residual $\rho_q$ and the Poisson residual $\rho_\phi$ (using a scale-aware roundoff floor
for divergence-free modes) via Blue/LAPACK scaled multi-block reductions in one scalar D2H readback.

(response-solver-symbols-and-si-units)=
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
## 4. Assumptions, boundary meaning, and validity limits

* **Stationary equilibrium**: $\mathbf m_0$ must be a converged static equilibrium; driving around a
  high-torque state invalidates the linear susceptibility tensor.
* **Damping regularization on the real frequency axis**: If `damping_policy="ignore"` ($\alpha_{\mathrm{eff}}=0$),
  $\mathsf A(\omega)$ becomes singular at undamped eigenfrequencies (`CUDSS_DATA_INFO != 0` fails
  closed even under `auto`). Physical line-shape sweeps should use `damping_policy="include"` with
  $\alpha > 0$.
* **Explicit solver-method runtime gate (`frequency_response_solver_method_rejection_reason`)**:
  - `None` or `"auto"` is accepted on FEM CPU and FEM GPU (preferring `gpu_sparse_direct_cudss` on
    eligible GPU sweeps when within VRAM budget, with explicit fallback to `gpu_operator_host_krylov`).
  - `"gpu_sparse_direct"` is accepted on FEM GPU for open-airbox Poisson, no-demag, and
    `periodic_airbox_k0` sweeps; it fails closed on CPU, on nonzero-$\mathbf k$ Floquet boundaries,
    on Fredkin–Koehler FEM/BEM demag, or when the post-analysis VRAM estimate exceeds budget.
  - `"gpu_operator_host_krylov"` requires GPU; `"schur_reduced"` requires `periodic_airbox_k0` or
    `floquet_airbox`; `"dense_reference"` requires non-periodic CPU validation.
  - Explicit selection of `"cpu_sparse_direct"`, `"full_coupled_field_split"`, `"modal_reduced"`, or
    `"gpu_device_krylov"` fails closed until runtime qualification for those routes is enabled.

(response-solver-python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

```python
# %% Imports and study setup
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_driven_fmr_sweep")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

box = study.geometry(
    fm.Box(size=(100 * nm, 50 * nm, 5 * nm), name="box"),
    name="box",
)
box.Ms = 8.0e5
box.Aex = 13.0e-12
box.alpha = 0.01
box.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.b_ext(0.05, 0.0, 0.0)
study.demag(model="airbox", variant="robin")

# %% Relax equilibrium and run GPU cuDSS driven frequency-response sweep
study.stages.add_relax(
    stage_id="relax_eq",
    algorithm="nonlinear_cg",
    max_steps=5_000,
    tolT=1.0e-8,
)
study.stages.add_frequency_response(
    frequencies_hz=[4.0e9, 6.0e9, 8.0e9, 10.0e9],
    excitation_field_au_per_m=(0.0, 100.0, 0.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
    magnetostatic_bc="open",
    solver_method="gpu_sparse_direct",
    solver_preconditioner="auto",
    solver_rtol=1.0e-10,
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
| `solver_method` | `str \| None` | `None` | $1$ | one of auto, dense_reference, cpu_sparse_direct, full_coupled_field_split, schur_reduced, modal_reduced, gpu_operator_host_krylov, gpu_device_krylov, gpu_sparse_direct | requested algebraic route (`gpu_sparse_direct` selects GPU cuDSS; omission/auto resolves automatically) | FEM CPU/GPU (`gpu_sparse_direct` GPU non-Floquet only) | `solver_policy.method` |
| `solver_preconditioner` | `str \| None` | `None` | $1$ | one of auto, graph_demag_coarse, demag_coarse, block_jacobi, none | requested Krylov preconditioner (unused under `gpu_sparse_direct_cudss`) | FEM bounded | `solver_policy.preconditioner` |
| `solver_rtol` | `float \| None` | `None` | $1$ | finite and positive | relative algebraic tolerance (defaults to $10^{-10}$ for `cuDSS` certification) | FEM | `solver_policy.rtol` |
| `solver_max_iterations` | `int \| None` | `None` | $1$ | positive integer; Boolean rejected | iteration ceiling | FEM iterative lanes | `solver_policy.max_iterations` |
| `solver_restart_iterations` | `int \| None` | `None` | $1$ | positive integer; at most solver_max_iterations when both are supplied | restarted-GMRES subspace length | FEM iterative lanes | `solver_policy.restart_iterations` |
| `MAX_ITERATIONS` | `int \| None` | `None` | $1$ | compatibility alias; conflicts with a different solver_max_iterations value | legacy spelling of the iteration ceiling | FEM iterative lanes | `solver_policy.max_iterations` |

(response-solver-problem-ir)=
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
    "method": "gpu_sparse_direct",
    "preconditioner": "auto",
    "rtol": 1e-10,
    "max_iterations": 200,
    "restart_iterations": 30
  }
}
```

When `gpu_sparse_direct_cudss` executes, [`resolve_native_frequency_response_solver_provenance`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L1466)
propagates `requested_solver_method`, `resolved_solver_method="gpu_sparse_direct_cudss"`,
`direct_solver_package="nvidia_cudss"`, `matrix_type="general_complex_f64"`,
`symbolic_analysis_count`, `numeric_factorization_count`, `estimated_peak_device_bytes`,
`device_budget_bytes`, `max_magnetic_relative_residual_l2`, `max_poisson_relative_residual_l2`,
and `gpu_device_resident_solver=true` (or `solver_fallback_reason` on `auto` Krylov fallback) into
the response diagnostics and manifest artifacts.

(response-solver-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves `frequencies_hz`, `excitation_field_au_per_m`,
  `excitation_phase_rad`, `observable`, `include_demag`, `damping_policy`, `magnetostatic_bc`, and
  `solver_policy` (including `method="gpu_sparse_direct"`) across Python $\leftrightarrow$ `ProblemIR`
  round-trip serialization.
* **Resolved execution**: records `resolved_frequency_response_solver_method_name` and
  `resolve_native_frequency_response_solver_provenance` (`gpu_sparse_direct_cudss` vs
  `gpu_operator_host_krylov` vs CPU routes), operator digest, per-frequency iteration or
  factorization count, unscaled residuals $(\rho_q, \rho_\phi)$ / $\varepsilon_{\mathrm{true}}(\omega)$,
  and convergence status.
* **Validation errors**: fail closed on empty or non-positive `frequencies_hz`, conflicting
  `k_vector` and `k_sampling`, `solver_restart_iterations > solver_max_iterations`, malformed
  `FULLMAG_FEM_DRIVEN_CUDSS_BUDGET_BYTES` / `FULLMAG_FEM_DRIVEN_CUDSS_MAX_VRAM_MIB`, singular
  $\alpha = 0$ exact-resonance systems (`CUDSS_DATA_INFO != 0`), or uncertified residuals (even
  under `auto`).
* **Unsupported combinations**: fail closed when FDM is requested, when `gpu_sparse_direct` is
  requested on CPU, with nonzero-$\mathbf k$ Floquet boundaries, with Fredkin–Koehler FEM/BEM demag,
  or over VRAM budget (`cudss_peak_memory_budget_exceeded`), or when an unenabled explicit
  solver-tree method is rejected by `frequency_response_solver_method_rejection_reason`.

(response-solver-discrete-realization)=
## 8. Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | implemented | Accepted native FEM host GMRES / Schur-reduced Krylov (`solve_driven_frequency_response`) and dense block-real validation (`solve_block_real_harmonic_response`), with bounded accepted artifact publication |
| FEM | GPU | implemented | Guarded `cuDSS` general complex FP64 LU (`solve_driven_response_gpu_cudss`, 1× symbolic analysis, $4 N_{m,\mathrm{eff}}$ in-place diagonal update, 2×2 block geometric pre-scaling + 6× Ruiz equilibration, VRAM preflight, unscaled GPU residual certification) for open, no-demag, and `periodic_airbox_k0` sweeps (RTX 4080 SUPER A/B verified); explicit `gpu_operator_host_krylov` fallback |
| FDM | CPU | unsupported | The planner and runtime reject native frequency-domain response on FDM |
| FDM | GPU | unsupported | No public FDM CUDA frequency-response lane exists |

### Execution sequence

1. **Equilibrium and tangent basis setup**: materializes $\mathbf m_0$ and constructs the nodal
   tangent basis $(\mathbf e_1, \mathbf e_2, \mathbf m_0)$ and `LinearizedDynamicPencil`.
2. **One-time sparse export & equilibration (GPU `cuDSS`)**: `export_demag_poisson_sparse_blocks`
   exports sorted CSR Poisson blocks once; `solve_driven_response_gpu_cudss` assembles
   $Z_{\mathrm{aug}}$, applies 2×2 block geometric pre-scaling + 6-pass Ruiz equilibration, runs 1×
   symbolic analysis, and verifies the VRAM budget preflight before starting factorization.
3. **Per-frequency shifted solve**: at each sample $\omega_j = 2\pi f_j$, evaluates
   $\mathsf A(\omega_j)\widehat{\mathbf q}_j = \widehat{\mathbf b}(\omega_j)$ via
   `launch_driven_response_update_omega_entries` + `cuDSS` LU (GPU direct), `solve_driven_frequency_response`
   (CPU/GPU Krylov), or `solve_block_real_harmonic_response` (dense validation).
4. **True residual gate and accepted artifact publication**: verifies unscaled residuals
   (`launch_driven_response_unscaled_residual_cert` / $\varepsilon_{\mathrm{true}} \le \mathrm{rtol}$)
   and publishes bounded response artifacts (`collect_publish_accepted_frequency_response_artifacts` /
   `build_field_driven_response_sweep_artifact`).

(response-solver-implementation-mapping)=
## 9. Implementation mapping

| Architectural stage | Python / Planner owner | Runner / Native C++ owner |
|---|---|---|
| Stage authoring and IR lowering | `FrequencyResponseStageSpec`, `FrequencyResponse`, and `FrequencyResponseSolverPolicy` | `frequency_response_solver_method_rejection_reason`, `resolved_frequency_response_solver_method_name`, and `resolve_native_frequency_response_solver_provenance` |
| Native planner and request validation | `plan_fem_frequency_response` and `schur_certification_passes` | `validate_driven_frequency_response_request` |
| GPU `cuDSS` direct sparse pipeline | `fullmag_fem_frequency_domain_solve_driven_response_v14` | `export_demag_poisson_sparse_blocks`, `solve_driven_response_gpu_cudss`, `launch_driven_response_update_omega_entries`, and `launch_driven_response_unscaled_residual_cert` |
| Shifted Krylov & dense validation solves | `solve_driven_frequency_response` ABI | `solve_driven_frequency_response` and `solve_block_real_harmonic_response` |
| Accepted sweep publication & artifacts | `SaveResponse` | `collect_publish_accepted_frequency_response_artifacts`, `solve_field_driven_block_real_sweep_with_interrupt`, `field_driven_response_point`, and `build_field_driven_response_sweep_artifact` |

(response-solver-validation)=
## 10. Validation and qualification

- **RTX 4080 SUPER A/B verification (GPU `cuDSS` `gpu_sparse_direct`, $\alpha = 0.01$, `rtol = 1e-10`, `1–25 GHz`):**
  - **Open-airbox P2 Robin (`3A_open_small`, `1,687` complex DOFs):** 8-frequency sweep runs in
    **`208.02 ms`** vs `31,473.60 ms` CPU GMRES (**`151.3×`** E2E; **`454×`** amortized at `8.66 ms/freq`
    over 25 frequencies where CPU GMRES stalls near `9 GHz`), complex response parity **`5.32e-10`**,
    `1` analysis / `25` factorizations, `11.7 MiB` VRAM, residuals `r_q <= 3.54e-16`, `r_phi <= 2.19e-15`.
  - **2D periodic airbox `k=0` (`periodic_airbox_k0`, 25 frequencies):** `1,690` DOFs runs in
    **`692.69 ms`** vs `2,919.94 ms` GPU GMRES (**`4.22×`**, parity **`3.08e-11`**); `4,410` DOFs
    runs in **`1,248.18 ms`** vs `3,603.07 ms` (**`2.89×`**, parity **`3.04e-11`**); `1 MiB` VRAM
    cap under `auto` falls back cleanly with `0.000e+00` parity vs GPU GMRES.
  - **Large open-airbox scaling (25 frequencies `1–25 GHz`):** scales cleanly to **`42,907` complex
    DOFs** (`6.08 s` total, `243.06 ms/freq`, `449.6 MiB` VRAM, **`0` perturbed pivots**,
    `r_q <= 1.15e-14`, `r_phi <= 1.45e-14`, `25/25 PASS`). Under `Required` + `1 MiB` cap,
    preflight fails closed before factorization with `cudss_peak_memory_budget_exceeded`.
- **Contracts & memory safety:** `fem_driven_response_cudss_contract` (including $10^{25}$
  asymmetric block pre-scaling regression and `compute-sanitizer --tool memcheck` 0 errors),
  non-MFEM CI (`10/10 PASS`), Rust `frequency_response` (`55/55` default + `67/67` `fem-gpu`), and
  Python round-trip tests all pass.

See {ref}`numerical-methods-performance-fem-spectral-multiphysics` for complete benchmark tables.

(response-solver-limitations)=
## 11. Limitations and failure modes

* **Known v1 unit metadata note**: In `crates/fullmag-runner/src/eigen/response_block_real.rs`,
  `response_sweep_si_units` currently labels `susceptibility_tensor` as `"1"` (dimensionless),
  whereas the scalar projection $\chi_{\mathrm{v1}} = \widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf m}/\widehat{\mathbf h}_{\mathrm{ext}}^H\widehat{\mathbf h}_{\mathrm{ext}}$
  carries physical unit $\mathrm{m\,A^{-1}}$ (multiplying by $M_s$ yields dimensionless $\widehat{\boldsymbol\chi}_M$).
* **GPU `cuDSS` scope**: Single-GPU, single-process FP64 complex (`CUDA_C_64F`); nonzero-$\mathbf k$
  Floquet boundaries and Fredkin–Koehler FEM/BEM demag are outside direct-solver scope (`auto` falls
  back to `gpu_operator_host_krylov`; `gpu_sparse_direct` fails closed).
* **Undamped resonance poles**: Running with `damping_policy="ignore"` at an undamped resonance
  produces a singular matrix (`CUDSS_DATA_INFO != 0`) and fails closed.

(response-solver-scientific-bibliography)=
## 12. Scientific bibliography

1. D. Polder, “On the theory of ferromagnetic resonance,” *Philosophical Magazine*, 40, 99–115 (1949).
2. A. G. Gurevich and G. A. Melkov, *Magnetization Oscillations and Waves*, CRC Press, 1996.
3. D. Ruiz, “A scaling algorithm to equilibrate both rows and columns norms in matrices,” Rutherford Appleton Laboratory Technical Report RAL-TR-2001-034 (2001).
4. J. L. Blue, “A portable Fortran program to find the Euclidean norm of a vector,” *ACM Transactions on Mathematical Software* **4**(1), 15–23 (1978), [doi:10.1145/355769.355771](https://doi.org/10.1145/355769.355771).
5. FullMag public physics contracts: {doc}`/physics/foundations/llg-equation`, {doc}`/physics/foundations/observables`, and {ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(response-solver-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3103) | [`class FrequencyResponseStageSpec`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3103) | Public frequency-response stage schema. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3571) | [`frequency_response_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3571) | Public stage and solver-policy construction. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5122) | [`add_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5122) | Public StudyStagesBuilder frequency-response entry point. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L117) | [`class FrequencyResponseSolverPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L117) | Solver-policy names (including `gpu_sparse_direct`) and validation. |
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1335) | [`class FrequencyResponse`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1335) | Frequency-response validation and exact ProblemIR lowering. |
| [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | [`class SaveResponse`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | Supported response-output vocabulary and lowering. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | [`coerce_k_sampling`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L458) | Exact single-point/path wave-vector lowering and mutual exclusion. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L165) | [`class KPoint`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L165) | Exact nested K-point label and vector lowering. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | [`class KPath`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/eigen.py#L182) | Exact ordered K-path points, segment counts, and closed-flag lowering. |
| [`backends/fem/src/frequency_domain/operator_contract.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | [`validate_driven_frequency_response_request`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | Native operator and boundary legality checks. |
| [`backends/fem/include/frequency_domain/driven_response_solver.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/driven_response_solver.hpp#L215) | [`solve_driven_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/driven_response_solver.hpp#L215) | Production driven-response ABI declaration. |
| [`backends/fem/src/frequency_domain/driven_response_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/driven_response_solver.cpp#L17743) | [`solve_driven_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/driven_response_solver.cpp#L17743) | Production validation, lane dispatch, solve, residual, and artifact entry point. |
| [`backends/fem/gpu/frequency_domain/driven_response_cudss.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss.cpp#L1301) | [`solve_driven_response_gpu_cudss`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss.cpp#L1301) | GPU `cuDSS` coupled CSR assembly, 2×2 pre-scaling + 6× Ruiz, 1× analysis, VRAM preflight, and LU sweep. |
| [`backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L289) | [`launch_driven_response_update_omega_entries`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L289) | In-place GPU update of the $4 N_{m,\mathrm{eff}}$ diagonal mass/damping entries per frequency. |
| [`backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L321) | [`launch_driven_response_unscaled_residual_cert`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/frequency_domain/driven_response_cudss_kernels.cu#L321) | Fused multi-block GPU unscaling and unscaled Blue-norm residual certification. |
| [`backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp#L294) | [`export_demag_poisson_sparse_blocks`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/demag_poisson_sparse_export.cpp#L294) | One-time sorted CSR export of Poisson $P$, `ess_tdofs`-zeroed RHS, and recovery blocks. |
| [`backends/fem/src/api.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L3168) | [`fullmag_fem_frequency_domain_solve_driven_response_v14`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/api.cpp#L3168) | C ABI v14 entry point delivering GPU direct options and sparse Poisson blocks. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7087) | [`plan_fem_frequency_response`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7087) | Resolves driven frequency-response lane, periodic constraint sets, and planner policy. |
| [`backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp#L96) | [`schur_certification_passes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp#L96) | Checks Schur complement residual and breakdown gates in `FrequencySolvePlan`. |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223) | [`frequency_response_solver_method_rejection_reason`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223) | Runtime availability gate (including GPU-only and non-Floquet rules for `gpu_sparse_direct`). |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L210) | [`resolved_frequency_response_solver_method_name`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L210) | Resolved runtime method identity. |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L1466) | [`resolve_native_frequency_response_solver_provenance`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L1466) | Extracts `gpu_sparse_direct_cudss` telemetry and `auto` fallback reasons for artifact patching. |
| [`crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs#L279) | [`collect_publish_accepted_frequency_response_artifacts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response/accepted_artifacts.rs#L279) | Bounded publication of accepted native FEM frequency-response artifacts. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L226) | [`solve_block_real_harmonic_response`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L226) | Dense block-real validation solve. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L134) | [`solve_field_driven_block_real_sweep_with_interrupt`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L134) | Per-frequency sweep, reuse, and interruption semantics. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L199) | [`build_field_driven_response_sweep_artifact`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L199) | Dense response artifact assembly. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L305) | [`response_sweep_si_units`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L305) | Current v1 serialized unit metadata. |
| [`crates/fullmag-runner/src/eigen/response_block_real.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L328) | [`field_driven_response_point`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/response_block_real.rs#L328) | Current v1 derived response observables. |

## Cross-links

* {ref}`numerical-methods-performance-fem-spectral-multiphysics`
* {doc}`index`
* {doc}`floquet-response`
* {doc}`/python-api/studies/frequency-response`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`
