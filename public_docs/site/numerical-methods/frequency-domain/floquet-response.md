---
title: Floquet Response
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: /physics/interactions/demagnetization/periodic-demag, /physics/foundations/llg-equation
---

(public-docs-numerical-methods-frequency-domain-floquet-response)=
(numerical-methods-frequency-domain-floquet-response)=
# Floquet frequency-domain response

This chapter specifies how Bloch–Floquet phase boundary conditions ($\mathbf k \neq \mathbf 0$) are
incorporated into the driven frequency-response solver on a periodic unit cell or 2.5D waveguide
cross-section, and clarifies the solver boundary against GPU `cuDSS` direct driven response and the
narrow single-$\mathbf k$ GPU Floquet modal slice.

(floquet-response-problem-statement)=
## 1. Physical problem and Bloch–Floquet boundary closure

In a spatially periodic magnonic crystal or translationally invariant waveguide with static periodic
equilibrium $\mathbf m_0(\mathbf r + \Delta\mathbf r) = \mathbf m_0(\mathbf r)$, a spatially
modulated harmonic excitation field $\widehat{\mathbf h}_{\mathrm{ext}}(\mathbf r)\propto \mathrm e^{\mathrm i\mathbf k\cdot\mathbf r}$
excites Bloch spin waves at wave vector $\mathbf k$ and angular frequency $\omega = 2\pi f$. Solving
the driven response on a single unit cell requires coupling periodic master/slave boundary node
pairs with a complex Bloch phase factor for both the tangent magnetization perturbation
$\widehat{\mathbf q}$ and the dynamic magnetostatic scalar potential $\widehat{\phi}$.

(floquet-response-governing-equations)=
## 2. Governing equations

### 2.1 Bloch–Floquet phase prolongation

Across any periodic face pair separated by lattice translation vector $\Delta\mathbf r$, the
complex magnetization and magnetostatic scalar potential amplitudes satisfy:

```{math}
:label: eq-numerical-floquet-phase
\widehat{\mathbf m}(\mathbf r + \Delta\mathbf r) = \mathrm e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}\widehat{\mathbf m}(\mathbf r),
\qquad
\widehat{\phi}(\mathbf r + \Delta\mathbf r) = \mathrm e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}\widehat{\phi}(\mathbf r),
\qquad
\widehat{\mathbf q}_{\mathrm{full}} = C(\mathbf k)\,\widehat{\mathbf q},
```

where the sign in the exponent follows `FloquetBC.phase_convention` (default
`"exp_minus_i_k_dot_delta_r"`) and $C(\mathbf k)$ is the complex unitary boundary-prolongation
matrix mapping reduced master degrees of freedom $\widehat{\mathbf q}$ to full mesh degrees of
freedom $\widehat{\mathbf q}_{\mathrm{full}}$.

### 2.2 Wave-vector-shifted harmonic linear system

Projecting the linearized operator through $C(\mathbf k)$ (or substituting the 2.5D shifted
gradient $D_{\mathbf k} = \nabla_\perp - \mathrm i k\hat{\mathbf z}$ in waveguide geometry) yields
the $\mathbf k$- and $\omega$-parameterized linear system:

```{math}
:label: eq-numerical-floquet-response
\bigl(\mathsf K(\mathbf k) - \mathrm i\omega\mathsf G(\mathbf k)\bigr)\widehat{\mathbf q}(\mathbf k, \omega)
=
\widehat{\mathbf b}(\mathbf k, \omega),
\qquad
\mathsf K(\mathbf k) = C(\mathbf k)^H \mathsf K_{\mathrm{full}} C(\mathbf k),
\qquad
D_{\mathbf k} = \nabla_\perp - \mathrm i k\,\hat{\mathbf z}.
```

Because $C(\mathbf k)$ is complex for $\mathbf k\cdot\Delta\mathbf r \notin \pi\mathbb Z$,
$\mathsf K(\mathbf k)$ is complex Hermitian rather than real symmetric, and
`build_floquet_dynamic_demag_k_real_split` / `build_floquet_waveguide_demag_k_real_split` assemble
its real-split $2\times 2$ block representation.

(floquet-response-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\widehat{\mathbf m}$ | complex dynamic reduced-magnetization amplitude | $1$ |
| $\widehat{\phi}$ | complex dynamic magnetostatic scalar potential amplitude | $\mathrm{A}$ |
| $\mathbf r$ | spatial position vector in the unit cell | $\mathrm{m}$ |
| $\Delta\mathbf r$ | direct-lattice translation vector between periodic face partners | $\mathrm{m}$ |
| $\mathbf k$ | Bloch–Floquet spin-wave wave vector | $\mathrm{rad\,m^{-1}}$ |
| $C(\mathbf k)$ | complex unitary Bloch boundary-prolongation matrix | $1$ |
| $\mathsf K(\mathbf k)$ | Bloch-reduced $\mathbf k$-dependent tangent rate-stiffness operator | $\mathrm{s^{-1}}$ |
| $\mathsf G(\mathbf k)$ | Bloch-reduced $\mathbf k$-dependent damping-modified tangent metric | $1$ |
| $\omega$ | angular drive frequency $2\pi f$ | $\mathrm{rad\,s^{-1}}$ |
| $\widehat{\mathbf q}$ | master-DOF complex tangent response amplitude vector | $1$ |
| $\widehat{\mathbf b}(\mathbf k,\omega)$ | Bloch-projected harmonic drive right-hand side vector | $\mathrm{s^{-1}}$ |
| $D_{\mathbf k}$ | 2.5D waveguide shifted-gradient differential operator $\nabla_\perp - \mathrm i k\hat{\mathbf z}$ | $\mathrm{m^{-1}}$ |

(floquet-response-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Setting | Mathematical meaning | Validity constraint |
|---|---|---|
| `FloquetBC(pair_ids=...)` | Applies $\mathrm e^{\pm\mathrm i\mathbf k\cdot\Delta\mathbf r}$ across conforming master/slave face nodes. | Partner faces must have matching node topology certified by the V6 seam map. |
| `magnetostatic_bc="floquet_airbox"` | Applies the same Bloch phase factor to $\widehat{\phi}$ on lateral airbox boundaries while retaining Robin/Dirichlet closure on open top/bottom airbox faces. | Required when `include_demag=True` at $\mathbf k \neq \mathbf 0$; using `magnetostatic_bc="open"` at $\mathbf k \neq \mathbf 0$ breaks Bloch translational invariance. |
| `solver_method="gpu_sparse_direct"` | GPU `cuDSS` general complex LU for driven frequency response ({doc}`response-solver`). | **Explicitly rejected** by [`frequency_response_solver_method_rejection_reason`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223) on nonzero-$\mathbf k$ Floquet boundaries (`floquet_airbox` or nonzero-$\mathbf k$ `spin_wave_bc="floquet"`); under `solver_method="auto"`, GPU sweeps fall back explicitly to `gpu_operator_host_krylov` with `solver_fallback_reason="nonzero_k_floquet_unsupported"`. |
| Single-$\mathbf k$ GPU Floquet modal slice | Source-visible `cuDSS` Hermitian augmented shift slice (`solve_gpu_floquet_shared_domain`, `augmented_floquet_cudss_cuda`). | Scoped strictly to `StudyIR::Eigenmodes` with a single `KPoint` and `alpha = 0` ({doc}`/numerical-methods/eigensolvers/linearized-llg`); does not enable GPU direct driven response at nonzero $\mathbf k$. |

(floquet-response-python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

```python
# %% Floquet frequency-response stage configuration
import fullmag as fm

nm = 1.0e-9
study = fm.study("floquet_driven_response")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

cell = study.geometry(
    fm.Box(size=(100 * nm, 100 * nm, 10 * nm), name="unit_cell"),
    name="unit_cell",
)
cell.Ms = 8.0e5
cell.Aex = 13.0e-12
cell.alpha = 0.01
cell.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

# %% Periodic relaxation followed by Floquet driven response
study.exchange()
study.b_ext(0.0628, 0.0, 0.0)
study.demag(model="airbox", variant="robin")
study.stages.add_relax(
    stage_id="relax_eq",
    algorithm="nonlinear_cg",
    max_steps=5000,
    tolT=1.0e-8,
)
study.stages.add_frequency_response(
    frequencies_hz=[6.0e9, 8.0e9, 10.0e9],
    excitation_field_au_per_m=(0.0, 50.0, 0.0),
    observable="susceptibility_tensor",
    include_demag=False,
    equilibrium_source="relax",
    damping_policy="include",
    k_sampling=fm.KPoint(label="k_x", k=(2.0e7, 0.0, 0.0)),
    bc=fm.FloquetBC(
        pair_ids=["x_periodic"],
        phase_convention="exp_minus_i_k_dot_delta_r",
    ),
    magnetostatic_bc="floquet_airbox",
)
```

### `FloquetBC` and Floquet response parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FloquetBC.pair_ids` | `Sequence[str]` | `required` | $1$ | at least one nonempty pair ID | periodic face pair identities | FEM mesh/planner | `study.spin_wave_bc.pair_ids` |
| `FloquetBC.phase_convention` | `str` | `exp_minus_i_k_dot_delta_r` | $1$ | nonempty supported convention | sign convention for phase | FEM Floquet | `study.spin_wave_bc.phase_convention` |
| `FrequencyResponseStageSpec.k_vector` | `tuple[float,float,float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | finite three-vector | legacy Bloch vector | FEM Floquet | `study.k_vector` |
| `FrequencyResponseStageSpec.k_sampling` | `object \| None` | `None` | $1$ | valid k sampling schema | Bloch sampling | FEM Floquet | `study.k_sampling` |
| `FrequencyResponseStageSpec.include_demag` | `bool` | `True` | $1$ | Boolean | include dynamic demag | narrow gated slice | `study.operator.include_demag` |
| `FrequencyResponseStageSpec.magnetostatic_bc` | `str` | `open` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` | magnetostatic closure | FEM | `study.magnetostatic_bc` |

(floquet-response-problem-ir)=
## 6. ProblemIR, normalization, and provenance

`FloquetBC` lowers into `spin_wave_bc` and is paired with `k_sampling` and `magnetostatic_bc` in
`StudyIR::FrequencyResponse`:

```json
{
  "k_sampling": {
    "kind": "single",
    "k_vector": [20000000.0, 0.0, 0.0]
  },
  "spin_wave_bc": {
    "kind": "floquet",
    "pair_ids": ["x_periodic"],
    "phase_convention": "exp_minus_i_k_dot_delta_r"
  },
  "magnetostatic_bc": "floquet_airbox"
}
```

(floquet-response-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves `FloquetBC.pair_ids`, `FloquetBC.phase_convention`, `k_sampling`,
  `include_demag`, `magnetostatic_bc`, and `solver_policy` across Python $\leftrightarrow$ `ProblemIR`
  round-trip.
* **Resolved execution**: records the resolved constraint sets from
  `frequency_response_periodic_constraint_sets`, the real-split operator digest, and—on GPU
  `solver_method="auto"`—the explicit fallback `solver_fallback_reason="nonzero_k_floquet_unsupported"`
  to `gpu_operator_host_krylov`.
* **Validation errors**: fail closed when `FloquetBC.pair_ids` is empty or when both `k_vector` and
  `k_sampling` are specified simultaneously.
* **Unsupported combinations**: fail closed in `frequency_response_solver_method_rejection_reason`
  when `solver_method="gpu_sparse_direct"` is requested with nonzero-$\mathbf k$ Floquet boundaries
  (`magnetostatic_bc="floquet_airbox"` or nonzero-$\mathbf k$ `spin_wave_bc="floquet"`), and fail
  closed in `validate_driven_frequency_response_request` when nonzero-$\mathbf k$ dynamic
  demagnetization is requested outside the qualified Floquet airbox contract or on FDM.

(floquet-response-discrete-realization)=
## 8. Discrete realization and 4-lane support matrix

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial | Projected Floquet response (`FloquetReducedMagneticOperator`, real-split 3D Floquet and 2.5D waveguide blocks, `solve_driven_response_contract`); dynamic demag at nonzero $\mathbf k$ is capability-gated |
| FEM | GPU | partial | `gpu_sparse_direct` (`cuDSS`) is explicitly rejected for nonzero-$\mathbf k$ Floquet driven response (`auto` falls back to `gpu_operator_host_krylov` with `nonzero_k_floquet_unsupported`); the narrow single-$\mathbf k$ GPU Floquet `cuDSS` slice (`solve_gpu_floquet_shared_domain`, `augmented_floquet_cudss_cuda`) applies only to conservative modal eigenmodes ({doc}`/numerical-methods/eigensolvers/linearized-llg`) |
| FDM | CPU | unsupported | No native FDM Floquet driven-response lane exists |
| FDM | GPU | unsupported | No public FDM CUDA Floquet driven-response lane exists |

### Execution sequence

1. **Constraint lowering**: `frequency_response_periodic_constraint_sets` maps `pair_ids` and
   `phase_convention` into planner periodic partner sets, and
   `frequency_response_solver_method_rejection_reason` enforces solver-method legality.
2. **Bloch operator assembly**: `FloquetReducedMagneticOperator` and
   `build_floquet_dynamic_demag_k_real_split` (or `build_floquet_waveguide_demag_k_real_split`)
   assemble the real-split $\mathbf k$-dependent operator blocks.
3. **Shifted solve and reconstruction**: `solve_driven_response_contract` solves for the master
   DOFs $\widehat{\mathbf q}(\mathbf k, \omega)$ and reconstructs slave boundary DOFs by multiplying
   with $C(\mathbf k)$.

(floquet-response-implementation-mapping)=
## 9. Implementation mapping

| Architectural stage | Python / Planner owner | Native C++ / Runner owner |
|---|---|---|
| Boundary authoring, planner constraints, and method gate | `FloquetBC` and `frequency_response_periodic_constraint_sets` | `validate_driven_frequency_response_request` and `frequency_response_solver_method_rejection_reason` |
| Bloch magnetic and magnetostatic $\mathbf k$-operators | `FrequencyResponseStageSpec` | `FloquetReducedMagneticOperator`, `build_floquet_dynamic_demag_k_real_split`, and `build_floquet_waveguide_demag_k_real_split` |
| Projected response solve & modal GPU slice cross-boundary | `FrequencyResponse` | `solve_driven_response_contract` (driven response) and `solve_gpu_floquet_shared_domain` (modal-only narrow single-$\mathbf k$ GPU slice) |

(floquet-response-validation)=
## 10. Validation and qualification

| Validation gate | Mathematical criterion | Required evidence |
|---|---|---|
| $\Gamma$-point continuity | At $\mathbf k = \mathbf 0$, `FloquetBC` reproduces the periodic $\mathbf k=\mathbf 0$ response to machine precision. | Operator digest and solution parity check. |
| Bloch seam quasi-periodicity | Reconstructed boundary values satisfy $\widehat{\mathbf q}(\mathbf r_b) = \mathrm e^{-\mathrm i\mathbf k\cdot\Delta\mathbf r}\widehat{\mathbf q}(\mathbf r_a)$. | Seam verification in `solve_driven_response_contract`. |
| `gpu_sparse_direct` Floquet gate | `solver_method="gpu_sparse_direct"` fails closed on `floquet_airbox` and nonzero-$\mathbf k$ `FloquetBC`; `auto` records `nonzero_k_floquet_unsupported`. | Rust `frequency_response` unit tests and `fem_driven_response_cudss_contract`. |

(floquet-response-limitations)=
## 11. Limitations and failure modes

* **Conforming periodic meshes**: 3D Floquet reduction requires partner boundary faces to have
  identical surface triangulations; non-conforming periodic meshes are rejected at the V6 seam
  certification step.
* **No GPU `cuDSS` direct driven response at nonzero $\mathbf k$**: Direct sparse `cuDSS` driven
  response is currently scoped to open, no-demag, and `periodic_airbox_k0` sweeps; nonzero-$\mathbf k$
  Floquet driven response remains gated away from `gpu_sparse_direct`.

(floquet-response-scientific-bibliography)=
## 12. Scientific bibliography

1. F. Bloch, “Über die Quantenmechanik der Elektronen in Kristallgittern,” *Zeitschrift für Physik*, 52, 555–600 (1929).
2. FullMag public physics contracts: {doc}`/physics/interactions/demagnetization/periodic-demag`, {doc}`/physics/foundations/llg-equation`, and {ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(floquet-response-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L676) | [`class FloquetBC`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L676) | Floquet pair and phase schema. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7542) | [`frequency_response_periodic_constraint_sets`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7542) | Lowers Floquet pair IDs and Bloch phase into planner constraint sets. |
| [`crates/fullmag-runner/src/frequency_response.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223) | [`frequency_response_solver_method_rejection_reason`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/frequency_response.rs#L223) | Rejects `gpu_sparse_direct` fail-closed on nonzero-k Floquet boundaries. |
| [`backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | [`class FloquetReducedMagneticOperator`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp#L48) | Applies complex Bloch prolongation C(k) to tangent magnetic blocks. |
| [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | [`build_floquet_dynamic_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L107) | 3D Floquet k-dependent dynamic demagnetization operator. |
| [`backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | [`build_floquet_waveguide_demag_k_real_split`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp#L63) | 2.5D waveguide shifted-gradient dynamic demagnetization operator. |
| [`backends/fem/src/frequency_domain/operator_contract.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | [`validate_driven_frequency_response_request`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/operator_contract.cpp#L107) | Floquet legality and dynamic-demag gate. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L3608) | [`solve_driven_response_contract`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L3608) | Projected response contract and diagnostics. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2168) | [`solve_gpu_floquet_shared_domain`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2168) | Modal-only narrow single-k GPU Floquet cuDSS slice (`augmented_floquet_cudss_cuda`). |

## Cross-links

* {ref}`numerical-methods-performance-fem-spectral-multiphysics`
* {doc}`index`
* {doc}`response-solver`
* {doc}`/python-api/boundary-conditions/floquet-boundary-conditions`
* {doc}`/python-api/studies/frequency-response`
* {doc}`/frontend/capability-register`
