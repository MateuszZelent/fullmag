---
title: Frequency Domain
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: response-solver, floquet-response, their source maps, frequency-domain planner headers, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-frequency-domain-root)=
# Frequency-domain response

:::{admonition} Linear response and native lane boundary
:class: important

The frequency-domain solver computes a **first-order steady harmonic response** around a declared
equilibrium. It is not a nonlinear harmonic-balance solver and it is not a Fourier transform of a
transient. The reviewed native production contract is FEM. FDM CPU and FDM CUDA frequency-domain
execution are explicitly unsupported.
:::

## From linearized LLG to a harmonic system

Let $\mathbf m_0$ be an accepted equilibrium and let the perturbation and applied field use the
recorded convention

```{math}
:label: eq-frequency-root-ansatz
\delta\mathbf m(t)
=\Re\!\left\{\widehat{\mathbf m}(\omega)
\exp(\mathrm i\omega t)\right\},
\qquad
\delta\mathbf h_{\mathrm{ext}}(t)
=\Re\!\left\{\widehat{\mathbf h}_{\mathrm{ext}}
\exp(\mathrm i\omega t)\right\}.
```

After tangent-space linearization, Fullmag represents the driven system as

```{math}
:label: eq-frequency-root-system
\mathsf A(\omega)\widehat{\mathbf q}
=\widehat{\mathbf b},
\qquad
\mathsf A(\omega)=\mathsf K+\mathrm i\omega\mathsf G,
\qquad
\widehat{\mathbf b}=\mathsf C\widehat{\mathbf h}_{\mathrm{ext}}.
```

$\mathsf K$ contains the tangent derivative of the enabled effective-field operators;
$\mathsf G$ contains the gyrotropic, mass, and damping structure according to the native
formulation; $\mathsf C$ maps the declared drive into tangent coordinates. The temporal sign,
operator scaling, and field units are part of the operator digest and must be preserved with every
response sample.

The frequency-domain and eigenvalue problems use related operators but different right-hand sides:

- eigenmodes seek nonzero $\mathbf q$ for which the homogeneous pencil is singular;
- response prescribes $\omega$ and solves a forced linear system;
- a resonance peak can be broadened or shifted by damping and can be absent when the drive has zero
  overlap with the mode.

## Response fields and susceptibility units

The solver reconstructs a complex tangent perturbation. Two response conventions must be kept
separate:

```{math}
:label: eq-frequency-root-susceptibilities
\widehat{\boldsymbol\chi}_{M}
=\frac{\widehat{\mathbf M}}
{\widehat{\mathbf h}_{\mathrm{ext}}},
\qquad
\widehat{\boldsymbol\chi}_{m}
=\frac{\widehat{\mathbf m}}
{\widehat{\mathbf h}_{\mathrm{ext}}},
\qquad
\widehat{\mathbf M}=M_s\widehat{\mathbf m}.
```

$\widehat{\boldsymbol\chi}_{M}$ is the conventional dimensionless magnetic susceptibility because
both numerator and denominator have units $\mathrm{A\,m^{-1}}$.
$\widehat{\boldsymbol\chi}_{m}$ is a reduced-magnetization response with units
$\mathrm{m\,A^{-1}}$. A production artifact must name which quantity it stores; the symbol
“susceptibility” alone is insufficient.

A driven response has a physical amplitude fixed by the drive. Eigenvector normalization must not
rescale the reported susceptibility. When the public `normalization` field is used by an internal
modal basis, provenance must distinguish basis normalization from the final driven response.

## Algebraic residual

For each frequency,

```{math}
:label: eq-frequency-root-residual
\mathbf r(\omega)
=\widehat{\mathbf b}-\mathsf A(\omega)\widehat{\mathbf q},
\qquad
\varepsilon_{\mathrm{true}}(\omega)
=\frac{\lVert\mathbf r(\omega)\rVert_2}
{\max(\lVert\widehat{\mathbf b}\rVert_2,b_{\mathrm{scale}})}.
```

A preconditioned residual or Krylov recurrence estimate is not automatically the true residual of
the assembled physical operator. Fullmag's frequency solve plan sets
`require_true_residual_verification=true`; the final response must therefore be checked by applying
the selected operator to the returned state.

For a zero or nearly zero right-hand side, a declared absolute scale is needed. A relative residual
with a zero denominator is undefined and must not be reported as convergence.

## Coupled and reduced formulations

Dynamic magnetostatics can introduce an auxiliary scalar-potential unknown. A generic coupled block
system is

```{math}
:label: eq-frequency-root-coupled-block
\begin{bmatrix}
A_{mm}(\omega) & A_{m\phi}\\
A_{\phi m} & A_{\phi\phi}
\end{bmatrix}
\begin{bmatrix}
\widehat q\\
\widehat\phi
\end{bmatrix}
=
\begin{bmatrix}
\widehat b\\
0
\end{bmatrix}.
```

Eliminating $\widehat\phi$ gives the Schur operator

```{math}
:label: eq-frequency-root-schur
S(\omega)
=A_{mm}(\omega)
-A_{m\phi}A_{\phi\phi}^{-1}A_{\phi m}.
```

A Schur-reduced solve is valid only if the reduced residual reconstructs the full coupled residual
and the inner potential solve is accurate enough. The reviewed planner defines a
`SchurCertificationState` with:

- availability of quality diagnostics;
- successful full/reduced residual reconstruction;
- finite nonnegative relative residual mismatch not exceeding the configured default $10^{-10}$;
- observed residual contraction not exceeding the configured default $0.95$;
- exact binding to mesh, material, and physics signatures.

A certificate from a different mesh, material set, or interaction list is rejected even when its
scalar quality metrics pass.

## Planner lanes represented in the source

`backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp` defines the following
execution lanes:

| Lane | Operator representation | Linear solver | Qualification intent |
|---|---|---|---|
| `dense_reference` | `dense_tiny` | dense direct | tiny validation/oracle problems |
| `cpu_sparse_direct` | sparse CSR | sparse direct | a single frequency when memory and dependency gates pass |
| `full_coupled_field_split` | coupled block `MatNest`-like representation | host FGMRES | periodic $k=0$ coupled magnetization/potential system with full blocks |
| `schur_reduced` | matrix-free reduced operator | host GMRES/FGMRES | certified reduced dynamic-demag path or nonperiodic iterative path |
| `modal_reduced` | validated modal basis | reduced solve | many-frequency sweep after basis validation |
| `gpu_operator_host_krylov` | matrix-free GPU operator | host GMRES | GPU matvec with host Krylov; not device-resident Krylov |
| `gpu_device_krylov` | matrix-free GPU operator | device FGMRES | device-resident Krylov only with preconditioner certification |

The same header defines operator representations, solver families, preconditioners, rejection
reason, selection reason, and fallback reason as separate plan fields. These are required
provenance, not logging decoration.

## Planner selection order

At the reviewed revision,
`backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` implements this
high-level order:

1. validation/tiny problem $\rightarrow$ `dense_reference`;
2. missing required accepted equilibrium $\rightarrow$ reject with
   `equilibrium_artifact_missing`;
3. single frequency with acceptable sparse-direct memory $\rightarrow$ `cpu_sparse_direct`;
4. periodic-airbox $k=0$ without a symmetric-mesh certificate $\rightarrow$ reject;
5. periodic $k=0$ with full coupled blocks $\rightarrow$ `full_coupled_field_split`;
6. explicitly requested and certified periodic Schur reduction $\rightarrow$ `schur_reduced`;
7. many frequencies with a validated modal basis $\rightarrow$ `modal_reduced`;
8. requested GPU with device Krylov and certified preconditioner $\rightarrow$
   `gpu_device_krylov`;
9. requested GPU with a GPU operator backend $\rightarrow$ `gpu_operator_host_krylov`;
10. nonperiodic iterative fallback $\rightarrow$ matrix-free `schur_reduced` plan with host GMRES
    and block Jacobi.

The plan is a selection record, not proof that the selected dependencies initialized or that a GPU
kernel executed. The runtime must publish the resolved lane and reject capability mismatches.

:::{admonition} Planner hardening boundary at the reviewed revision
:class: warning

The convenience overload currently ORs `prefer_existing_host_krylov` into both the internal
`requested_gpu` and `gpu_operator_backend_available` inputs. A preference flag is not independent
hardware-capability evidence. Consequently, documentation and provenance must not infer a real GPU
operator solely from the returned lane name; runtime capability and device execution must be
verified separately.
:::

## Sparse direct, Krylov, and reduced solves

### Sparse direct

A sparse factorization can be attractive for one frequency and moderate problem size, especially
when it produces a robust oracle. Its memory is governed by fill-in, not by the number of nonzeros
in the original operator alone. The planner therefore requires a separate
`sparse_direct_memory_ok` capability.

### GMRES and FGMRES

The shifted tangent system is generally complex and nonsymmetric, so CG is not the default model.
GMRES minimizes the residual over an expanding Krylov space; restarted GMRES limits memory but can
stagnate. FGMRES permits a varying or nonlinear preconditioner, which is relevant for field-split
and inexact Schur actions.

Every iterative sample should record iteration count, restart length, final recurrence residual,
recomputed true residual, preconditioner identity, contraction metrics, and termination reason.
`max_iterations` is a budget, not convergence.

### Modal reduction

For a validated basis $V$,

```{math}
:label: eq-frequency-root-modal-reduction
\widehat{\mathbf q}\approx V\widehat{\mathbf a},
\qquad
V^{\ast}\mathsf A(\omega)V\widehat{\mathbf a}
=V^{\ast}\widehat{\mathbf b}.
```

This can make a many-frequency sweep inexpensive, but it is accurate only in the subspace captured
by $V$. Qualification must include basis provenance, frequency interval, residual in the **full**
operator, and comparison with direct/full-order samples. A reduced residual alone is insufficient.

## Frequency sweep semantics

For frequencies $f_j>0$, the Python boundary stores hertz and the operator uses
$\omega_j=2\pi f_j$. A production sweep should:

- preserve user ordering or record any canonical sorting and inverse permutation;
- report one status and residual per sample rather than one aggregate success bit;
- reuse frequency-independent operators/preconditioners only when their cache signatures match;
- avoid carrying a failed solution as an unlabelled initial guess;
- preserve complex phase and excitation amplitude;
- record whether warm starts, factor reuse, Krylov recycling, or a modal basis were used.

Adaptive frequency sampling is not implied by a dense list. Resolving a narrow resonance requires a
frequency-convergence study independent of the linear-solver tolerance.

## Floquet/Bloch response

For periodic faces separated by $\Delta\mathbf r$, Fullmag documents the convention

```{math}
:label: eq-frequency-root-floquet-phase
\widehat{\mathbf m}(\mathbf r+\Delta\mathbf r)
=\exp\!\left(-\mathrm i\mathbf k\cdot\Delta\mathbf r\right)
\widehat{\mathbf m}(\mathbf r).
```

The $\mathbf k$-dependent driven system is

```{math}
:label: eq-frequency-root-floquet-system
\left[\mathsf K(\mathbf k)+
\mathrm i\omega\mathsf G(\mathbf k)\right]
\widehat{\mathbf q}(\omega,\mathbf k)
=\widehat{\mathbf b}(\omega,\mathbf k).
```

A nonzero `k_vector` is not enough. `FloquetBC.pair_ids` must resolve to complete periodic mesh pairs
with finite translations, compatible orientations, and phase-loop closure. The current native
production slice is narrow: projected nonzero-$k$ response without qualified dynamic
demagnetization is represented; nonzero-$k$ dynamic demag is rejected until the coupled
$\delta\mathbf m/\delta\phi$ operator is qualified. See {doc}`floquet-response`.

## Public Python contract

```python
# %% FEM driven response with explicit solver policy
import fullmag as fm

nm = 1.0e-9
study = fm.study("fem_frequency_response")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="robin")

study.stages.add_frequency_response(
    frequencies_hz=(1.0e9, 2.0e9, 3.0e9),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="provided",
    damping_policy="include",
    bc="free",
    magnetostatic_bc="open",
    solver_method="schur_reduced",
    solver_preconditioner="block_jacobi",
    solver_rtol=1.0e-8,
    solver_max_iterations=500,
    solver_restart_iterations=50,
)
```

### Important request fields

| Field | Default | Unit | Contract |
|---|---:|---:|---|
| `frequencies_hz` | required | $\mathrm{Hz}$ | nonempty finite positive sequence |
| `excitation_field_au_per_m` | `(0,0,1)` | $\mathrm{A\,m^{-1}}$ | finite drive vector; zero amplitude cannot define normalized susceptibility |
| `excitation_phase_rad` | `0` | $\mathrm{rad}$ | finite phase in the recorded temporal convention |
| `observable` | `susceptibility_tensor` | quantity-dependent | output schema must declare reduced or physical magnetization units |
| `include_demag` | `True` | $1$ | changes the dynamic operator and capability gates |
| `equilibrium_source` | `provided` | $1$ | `provided`, `relax`, or `artifact` |
| `damping_policy` | `ignore` | $1$ | `ignore` or `include`; affects resonance poles and linewidth |
| `k_vector` | `None` | $\mathrm{m^{-1}}$ | one Bloch sample; requires compatible boundary metadata |
| `bc` | `free` | $1$ | dynamic spin-wave boundary policy |
| `magnetostatic_bc` | `open` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` |
| solver `rtol` | policy default | $1$ | positive algebraic relative tolerance |
| solver `max_iterations` | policy default | $1$ | positive budget; exhaustion is not convergence |

The terminal page {doc}`response-solver` owns exact `ProblemIR` paths and round-trip behavior.

## Realization matrix

| Solver | Device | Status | Realization boundary |
|---|---|---|---|
| FEM | CPU | source-backed / partial | native validation and driven-response contract; exact lane selected by planner |
| FEM | GPU | partial / qualification-dependent | GPU operator with host Krylov and device-Krylov lanes require independent capability proof |
| FDM | CPU | unsupported | planner rejects native frequency-domain studies |
| FDM | GPU | unsupported | no public FDM CUDA frequency-domain lane |

## Implementation mapping

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Public response schema | `packages/fullmag-py/src/fullmag/world.py` | `class FrequencyResponseStageSpec` |
| Stage construction | `packages/fullmag-py/src/fullmag/world.py` | `frequency_response_stage` |
| Floquet boundary schema | `packages/fullmag-py/src/fullmag/model/study.py` | `class FloquetBC` |
| Native request legality | `backends/fem/src/frequency_domain/operator_contract.cpp` | `validate_driven_frequency_response_request` |
| Native response contract | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_driven_response_contract` |
| Execution-lane model | `backends/fem/include/frequency_domain/planner/frequency_solve_plan.hpp` | `FrequencySolvePlan` and related enums |
| Lane selection | `backends/fem/include/frequency_domain/planner/frequency_solve_planner.hpp` | `plan_frequency_response` |
| Runtime orchestration | `crates/fullmag-runner/src/frequency_response.rs` | frequency-response runner owner |

## Validation programme

1. **Macrospin susceptibility:** compare resonance frequency, complex phase, and damping-dependent
   linewidth with an independently evaluated linear macrospin model.
2. **Time/frequency cross-check:** drive with sufficiently small amplitude in time domain, discard
   transients, Fourier-analyse the steady response, and compare complex amplitude at selected
   frequencies.
3. **True residual:** recompute $\widehat b-\mathsf A\widehat q$ using the same full operator digest.
4. **Frequency refinement:** refine around peaks and verify peak position, amplitude, and integrated
   response.
5. **Mesh/order convergence:** repeat with independently refined FEM spaces and converged
   equilibrium.
6. **Reduced/full parity:** compare modal or Schur-reduced samples with full coupled/direct samples,
   including the full residual.
7. **CPU/GPU parity:** use identical operator, precision policy, tolerance, drive, and boundary
   metadata; prove the resolved device lane.
8. **Floquet phase:** verify every paired degree of freedom, translation vector, and closed phase
   loop; explicitly test rejection of nonzero-$k$ dynamic demag.

A smooth plotted curve is not sufficient evidence. Every sample needs a status, true residual,
resolved lane, and units.

## Limitations

- The solver is linear response only; large-angle dynamics and nonlinear harmonic generation are
  outside this contract.
- Native FDM frequency response is unsupported.
- Nonzero-$k$ dynamic demagnetization is not production-qualified.
- The planner represents both GPU-operator/host-Krylov and device-resident Krylov; they are distinct
  performance and provenance claims.
- A Schur or modal reduced result is qualified only after full-operator residual reconstruction.
- Sparse-direct feasibility depends on fill-in and available memory, not only original matrix size.
- The current public observable naming must distinguish dimensionless $\delta M/\delta H$ from
  reduced $\delta m/\delta H$ with units $\mathrm{m\,A^{-1}}$.
- Policy preferences and source-visible GPU operators do not prove actual device execution.

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
4. V. Hernández, J. E. Román, and V. Vidal, “SLEPc: A scalable and flexible toolkit for the
   solution of eigenvalue problems,” *ACM Transactions on Mathematical Software* **31**, 351--362
   (2005), [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
5. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

```{toctree}
:maxdepth: 1

response-solver
floquet-response
```
## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver. The category itself has no standalone editor. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
