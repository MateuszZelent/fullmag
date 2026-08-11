# FEM Poisson-Airbox Modal Eigenproblem

- Status: bounded CPU/GPU engine executable; CPU window refinement certificate implemented; managed and independent field-sweep validation open
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-08-11
- Related physics notes:
  - `0700-frequency-domain-linearized-llg.md`
  - `0800-fem-static-pbc-demag.md`
  - `0828-fem-frequency-domain-floquet-demag.md`
  - `0831-fem-dynamic-pencil-modal-response-and-krylov.md`
  - `0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related implementation plan:
  - `docs/plans/active/fd_sovler_masterplan/20_dynamic_solver_audit_revalidation_and_remediation.md`

(problem-statement)=
## 1. Physical domain and problem statement

This note defines the first physically valid FEM modal eigensolve with dynamic
Poisson-airbox demagnetization. It is a `k=0`, alpha-zero, shared-domain
candidate around an accepted static equilibrium. The magnetic perturbation is
complex and tangent to the equilibrium; the scalar-potential perturbation lives
on the full magnetic-plus-airbox domain.

The topology-shaped PA-E1/PA-E4b payload is an algebraic test oracle only. It
is not a FEM Poisson-airbox model and must not be labeled production physics.

### Backend and device qualification boundary

| Solver | Device | Current state | Boundary |
|---|---|---|---|
| FEM | CPU | bounded executable; validation blocked | The shared-domain P1 solver executes, but a physics-owned field-sweep request independent of the Kittel oracle remains open. |
| FEM | GPU | bounded executable; validation blocked | Managed device-resident PETSc/SLEPc execution exists, but an independent field sweep, larger matrix-free cases, and convergence remain open. |
| FDM | CPU | not applicable | FDM demagnetization has a separate canonical physics owner. |
| FDM | GPU | not applicable | FDM demagnetization has a separate canonical physics owner. |

## 2. Physical model

(governing-equations)=
### 2.1 Governing equations

Fullmag uses

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(+i omega t)]
delta_m = Tq
m0 dot delta_m = 0
delta_H_demag = -grad(delta_phi).
```

With `delta_M=Ms delta_m` inside the magnetic region and zero elsewhere,

```text
div(grad(delta_phi)) = div(delta_M) in D,
D = Omega_m union Omega_air.
```

For a Robin approximation of the open exterior boundary `Gamma_open`, the
weak form is

```text
int_D grad(psi) dot grad(delta_phi) dV
+ beta int_Gamma_open psi delta_phi dS
= int_Omega_m Ms delta_m dot grad(psi) dV.
```

The Robin term is excluded from periodic cuts. Dirichlet eliminates the
corresponding potential DOFs. Pure Neumann has a constant nullspace and alone
uses a mean-zero gauge. Fully periodic three-dimensional k=0 demagnetization
is unsupported until a macroscopic-field convention is defined.

The modal magnetic system is represented by

```text
A_qq q + A_qphi phi = lambda B_qq q
A_phiq q + P phi = 0,
lambda = i omega.
```

```{math}
:label: eq-poisson-airbox-modal-block
\begin{aligned}
P\,\delta\phi &= C_{\phi q}q, \\
A_{\phi q}q + P\,\phi &= 0, \\
L_{\mathrm{eff}}q &= \lambda B_{qq}q, \qquad
L_{\mathrm{eff}} = A_{qq}-A_{q\phi}P^{-1}A_{\phi q},
\qquad \lambda = i\omega .
\end{aligned}
```

```{math}
:label: eq-poisson-airbox-weak-form
\int_{D}\nabla\psi\cdot\nabla\delta\phi\,\mathrm{d}V
 + \beta\int_{\Gamma_{\mathrm{open}}}\psi\,\delta\phi\,\mathrm{d}S
 = \int_{\Omega_m} M_s\,\delta\mathbf m\cdot\nabla\psi\,\mathrm{d}V .
```

For a pure-Neumann scalar block, the second row is augmented by `c eta` and
`cT phi=0`. Robin and Dirichlet have no `eta` row.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|---|---|---|
| `$m_0$`, `$\delta\mathbf m$` | normalized equilibrium magnetization and tangent perturbation | `$1$` |
| `$M_s$` | saturation magnetization | `$\mathrm{A\,m^{-1}}$` |
| `$\mathbf h_{\mathrm{eff},0}$`, `$\delta\mathbf H_{\mathrm{demag}}$` | equilibrium effective field and dynamic demagnetizing field | `$\mathrm{A\,m^{-1}}$` |
| `$\delta\phi$` | scalar magnetic potential | `$\mathrm{A}$` |
| `$\gamma_0$` | `$\mu_0|\gamma|$` gyromagnetic factor in the A/m convention | `$\mathrm{rad\,s^{-1}\,(A\,m^{-1})^{-1}}$` |
| `$\omega$` | angular frequency | `$\mathrm{rad\,s^{-1}}$` |
| `$\beta$` | Robin coefficient | `$\mathrm{m^{-1}}$` |
| `$P$` | scalar Poisson stiffness block | `$\mathrm{m}$` |
| `$q$` | tangent-plane modal coefficients | `$1$` |
| `$\Delta f$` | refinement-pass frequency spacing | `$\mathrm{Hz}$` |
| `$f_{\min}$` | lower bound of the requested frequency window | `$\mathrm{Hz}$` |
| `$f_{\max}$` | upper bound of the requested frequency window | `$\mathrm{Hz}$` |
| `$f_a$` | frequency of the first candidate in a cluster comparison | `$\mathrm{Hz}$` |
| `$f_b$` | frequency of the second candidate in a cluster comparison | `$\mathrm{Hz}$` |
| `$U$` | orthonormal basis matrix for a base-pass frequency cluster | `$1$` |
| `$V$` | orthonormal basis matrix for the paired refinement-pass frequency cluster | `$1$` |
| `$u_i$` | base-pass orthonormal magnetic cluster vector | `$1$` |
| `$v_j$` | refinement-pass orthonormal magnetic cluster vector | `$1$` |
| `$i$` | base-pass cluster-basis index | `$1$` |
| `$j$` | refinement-pass cluster-basis index | `$1$` |
| `$u_i^{\ast}v_j$` | Hermitian inner product between paired magnetic cluster vectors | `$1$` |
| `$r$` | rank of a paired frequency cluster | `$1$` |
| `$s(U,V)$` | normalized invariant-subspace overlap for paired clusters | `$1$` |
| `$\lambda$` | modal eigenvalue | `$\mathrm{s^{-1}}$` |
| `$B_{qq}$` | gyrotropic tangent mass block | `$\mathrm{m^3}$` |
| `$A_{qq},A_{q\phi},A_{\phi q}$` | magnetic and mixed descriptor blocks | `$\mathrm{m^3\,s^{-1}}$`, `$\mathrm{m^3\,(A)^{-1}\,s^{-1}}$`, `$\mathrm{A\,m}$` respectively |

(assumptions-and-validity)=
### 2.3 Assumptions and validity limits

- `m0` originates in an accepted equilibrium artifact with matching mesh,
  material, physics and boundary signatures.
- The initial real path supports P1 tetrahedral potential and tangent magnetic
  fields, alpha=0, k=0, uniform material within each supported region and
  x/y-periodic, open-z thin films.
- Nonzero-k dynamic demag requires complex Bloch `grad_k/div_k` assembly and is
  not approximated by the k=0 operator.

## 3. Solver family and numerical interpretation

(discrete-realization)=

### 3.1 FEM

`P`, source `C`, potential feedback and magnetic blocks are assembled from the
same shared mesh and quadrature. The production selected-spectrum solve is
Schur reduced, with the full descriptor reconstructed solely for certification.

The mixed blocks use the descriptor signs

```text
C_phi_q q = int_Omega_m Ms (Tq) dot grad(psi) dV
A_phiq = -C_phi_q
A_qphi = -mu0 A_phiq^T = mu0 C_phi_q^T
phi(q) = -P^-1 A_phiq q
L_eff = A_qq - A_qphi P^-1 A_phiq.
```

Consequently, the demagnetizing contribution to the energy Hessian is
positive semidefinite. For an in-plane, x/y-periodic thin film, the uniform
out-of-plane tangent component receives the `+Ms` restoring stiffness while
the uniform in-plane component does not. Reversing the `A_qphi` sign produces
`H0-Ms`, a real unstable eigenvalue, and must fail the reciprocal-coupling and
K0-3 Kittel gates.

Certification reports dimensionless blockwise backward errors:

```text
eps_q   = ||r_q|| / (||A_qq q|| + ||A_qphi phi|| + |lambda| ||B_qq q|| + eps)
eps_phi = ||r_phi|| / (||A_phiq q|| + ||P phi|| + ||c eta|| + eps)
eps_gauge = |cT phi| / (||c|| ||phi|| + eps).
```

The accepted full residual is `max(eps_q, eps_phi, eps_gauge)` and is not
replaced by a smaller backend-reported residual.

The managed runtime is the real-scalar `libpetsc-real-dev` plus
`libslepc-real-dev` lane. It represents the complex target
`sigma=i omega_target` only with the ADR-017 real-split
`real_frequency_rotated` pencil:

```text
R(L) y = omega R(i B_alpha) y
tau = omega_target.
```

`EPSSetTarget(tau)` is legal only on that named rotated pencil. A real scalar
target `omega_target` on the original `lambda=i omega` pencil is invalid and
must reject rather than approximate the imaginary-axis target.

For `target="frequency_window"`, the CPU Schur realization uses the
deterministic certificate `shift_nev_refinement_subspace_v1`. The base pass
retains the 16 midpoint shifts. The refinement pass uses 32 half-step-shifted
partitions plus one guard shift on each side of the requested interval:

```{math}
:label: eq-poisson-airbox-window-refinement-schedule
\Delta f=\frac{f_{\max}-f_{\min}}{32}, \qquad
\left[f_{\min}-\frac{\Delta f}{2},\,
      f_{\max}+\frac{\Delta f}{2}\right].
```

Both reported edge-coverage margins therefore equal $\Delta f/2$ and must be
strictly positive. The refinement
nearest-frequency requests twice the requested mode count, subject to the same
descriptor-dimension guard; its resolved `nev` must be greater than the base
`nev`.

Every nearest-frequency subsolve must return `ok`, and every accepted candidate
must already pass the full original, unscaled descriptor residual described
above. Accepted frequencies are clustered with tolerance
$\max(1\,\mathrm{Hz},10^{-8}\max(|f_a|,|f_b|))$. Within each cluster,
the magnetic $q$ components are reorthogonalized to determine rank. Given
orthonormal bases $U=\{u_i\}_{i=1}^{r}$ and
$V=\{v_j\}_{j=1}^{r}$ for equal-rank base and refinement clusters, the
reported invariant-subspace overlap uses the Hermitian inner product
$u_i^{\ast}v_j$:

```{math}
:label: eq-poisson-airbox-window-subspace-overlap
s(U,V)=\left(\frac{1}{r}\sum_{i=1}^{r}\sum_{j=1}^{r}
\left|u_i^{\ast}v_j\right|^2\right)^{1/2}.
```

The window is certified only when both schedules complete without failure or
cancellation, the requested mode count is covered without splitting a
degenerate cluster, paired clusters have stable frequencies and ranks,
$\min s(U,V)\ge 1-10^{-6}$, both edge margins are positive, and neither schedule
nor cluster JSON is truncated. A disagreement returns `solve_error`, keeps
`window_complete=false`, publishes
`frequency_window_refinement_disagreement`, and records a non-certified
certificate. When the requested count would split a residual-certified
cluster, that offending cluster frequency and rank remain visible in the
certificate even though `accepted_mode_count` is zero. Cancellation remains
`interrupted` with `cancel_requested`.

### 3.2 GPU

A GPU result is production-capable only when the assembled blocks, vectors,
Krylov basis and preconditioner remain resident on the device through the full
selected-spectrum iteration. The managed PETSc/SLEPc lane now executes the
bounded shared-domain K0 fixture with `seqaijcusparse` matrices and
`seqcuda` vectors, a device Schur operator, shift-invert, and no CPU fallback.
The bounded materialized path is used through 1024 descriptor dimensions;
larger problems select the explicit matrix-free shell and still require a
separate convergence qualification. One-shot `A*x` or dense inverse-iteration
contracts are not a device-resident modal solver.

### 3.3 FDM CPU and GPU

FDM CPU/GPU are not realizations of this FEM Poisson-airbox note. Their
demagnetization kernels and FFT/Newell boundary semantics are documented by the
FDM interaction owner; no FDM capability is inferred from the FEM results.

### 3.4 FDM and hybrid

This note does not alter FDM demagnetization or introduce hybrid semantics.

(python-api)=
## 4. Python API

The public API is stage-first and physics-first. The following example is the
smallest complete K0 request: it declares the shared domain, material, static
demagnetization, accepted relaxation source, and an explicit frequency window.

```python
# %%
import fullmag as fm

study = fm.study("k0_modal_airbox")
study.engine("fem")
study.device("auto", precision="double")
study.mode("strict")
study.interactive(True)

# %%
study.universe(mode="manual", size=(1200e-9, 600e-9, 550e-9))
film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.0
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag(realization="poisson_robin")

# %%
study.stages.add_eigenmodes(
    count=1,
    target="frequency_window",
    frequency_min=1.0e9,
    frequency_max=3.0e9,
    operator="linearized_llg",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open",
)
result = study.run()
```

For the bounded production lane, `include_demag=True`, `k_vector=(0, 0, 0)`,
`damping_policy="ignore"`, and `magnetostatic_bc="open"` are part of the
qualified contract. The public function also accepts the parameters below;
unsupported combinations are rejected during validation rather than silently
falling back to a different operator.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `eigenmodes.count` | `int` | `10` | `$1$` | `count > 0` | selected mode count | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_count` |
| `eigenmodes.target` | `str` | `"lowest"` | `$1$` | `lowest`, `nearest`, or `frequency_window` | spectral selection strategy | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_target` |
| `eigenmodes.target_frequency` | `float or None` | `None` | `$\mathrm{Hz}$` | finite when target is `nearest` | nearest target frequency | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_target_frequency` |
| `eigenmodes.frequency_min` | `float or None` | `None` | `$\mathrm{Hz}$` | finite and no greater than `frequency_max` | lower frequency-window bound | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_frequency_min` |
| `eigenmodes.frequency_max` | `float or None` | `None` | `$\mathrm{Hz}$` | finite and no less than `frequency_min` | upper frequency-window bound | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_frequency_max` |
| `eigenmodes.operator` | `str` | `"linearized_llg"` | `$1$` | supported operator identifier | linearized dynamics operator | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_operator` |
| `eigenmodes.include_demag` | `bool` | `True` | `$1$` | must be `True` for K0 demag qualification | dynamic demagnetizing feedback | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_include_demag` |
| `eigenmodes.equilibrium_source` | `str` | `"relax"` | `$1$` | `relax`, `provided`, or `artifact` | source of accepted equilibrium | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_equilibrium_source` |
| `eigenmodes.equilibrium_artifact` | `str or None` | `None` | `$1$` | required when source is `artifact` | equilibrium artifact path | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_equilibrium_artifact` |
| `eigenmodes.normalization` | `str` | `"unit_l2"` | `$1$` | `unit_l2` or `unit_max_amplitude` | mode normalization convention | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_normalization` |
| `eigenmodes.damping_policy` | `str` | `"ignore"` | `$1$` | `ignore` or `include`; `include` is not qualified here | damping treatment | FEM CPU and FEM GPU bounded K0 only with `ignore` | `stages[].eigen_damping_policy` |
| `eigenmodes.k_vector` | `tuple[float, float, float] or None` | `None` | `$\mathrm{m^{-1}}$` | K0 requires `(0, 0, 0)`; nonzero k is deferred | Bloch wave vector | FEM CPU and FEM GPU at K0 only | `stages[].eigen_k_vector` |
| `eigenmodes.k_sampling` | `object or None` | `None` | `$1$` | only supported by a qualified dispersion planner | dispersion sampling request | not qualified by this note | `stages[].eigen_k_sampling` |
| `eigenmodes.bc` | `str or dict` | `"free"` | `$1$` | supported spin boundary policy | exchange boundary policy | FEM CPU and FEM GPU bounded K0 | `stages[].eigen_spin_wave_bc` |
| `eigenmodes.magnetostatic_bc` | `str` | `"open"` | `$1$` | `open`, `poisson_robin`, `poisson_dirichlet`, or `pure_neumann` policy | scalar-potential boundary policy | FEM CPU and FEM GPU bounded K0 with open airbox | `stages[].eigen_magnetostatic_bc` |

(problem-ir)=
## 5. ProblemIR, planning, and provenance

The Python fields lower to one canonical stage object. A normalized request
retains the user's requested intent, for example
`eigen_k_vector=(0, 0, 0)` and `eigen_include_demag=True`. Planning then adds
resolved execution and provenance without rewriting the physical request:

```text
requested: engine=fem, device=auto, precision=double,
           eigen_operator=linearized_llg, k=(0,0,0), include_demag=true
resolved:  solver_adapter=k0_poisson_airbox_cpu_schur_slepc
           or k0_poisson_airbox_gpu_petsc_slepc,
           algebraic_form=schur_reduced_descriptor,
           spectral_transform=shift_invert,
           spectral_scalar_mode=real_split,
           assembly_kind=mfem_weak_form_shared_domain
```

The internal modal payload carries the following backend-owned provenance:

```text
assembly_kind = mfem_weak_form_shared_domain | synthetic_algebraic_oracle
outer_boundary_kind = poisson_robin | poisson_dirichlet | pure_neumann
gauge_policy = none | mean_zero_augmented
gauge_reason = coercive_outer_boundary | pure_neumann_nullspace
spectral_scalar_mode = complex | real_split
sigma_real_per_s, sigma_imag_rad_per_s
```

The boundary, gauge, and reason form one validated tuple. `poisson_robin` and
`poisson_dirichlet` require `gauge_policy=none` and
`gauge_reason=coercive_outer_boundary`; `pure_neumann` requires
`gauge_policy=mean_zero_augmented`, normalized quadrature-assembled mean
weights, and `gauge_reason=pure_neumann_nullspace`. Synthetic PA-E1/PA-E4b
payloads remain algebra-only and cannot establish a production claim.

`k0_kittel_validation` is a postsolve oracle only. It must not change the
physical external field, assembled blocks, equilibrium or periodic
certificates, spectral target, execution-lane selection, solver status, or
request signatures. A multi-field K0-3 study therefore requires a separate
physics-owned field-sweep request; a Gamma-point path whose fields are sourced
from analytical Kittel samples is not valid physical evidence.

(round-trip-and-failure-semantics)=
## 6. Round-trip and failure semantics

Script export reproduces the stage-first Python fields and their canonical
`ProblemIR` destinations. The exported request must preserve requested intent;
the runtime report separately records resolved execution, solver adapter,
device ownership, transfer audit, and artifact provenance. This separation is
required for reproducibility and for comparing CPU and GPU runs.

Validation errors are fail-closed. The planner rejects missing accepted
equilibrium fields, a missing shared-airbox periodic certificate, an invalid
boundary/gauge tuple, a nonzero k-vector in the K0 lane, a real target applied
to the unrotated imaginary-axis pencil, or a request for an unavailable
device-resident realization. Unsupported combinations are reported with the
requested fields and the resolved capability reason; they do not silently
select CPU, synthetic algebra, or a different demagnetization boundary.

Any artifact with `assembly_kind=synthetic_algebraic_oracle` must carry
`production_periodic_airbox_claim=false`. Production-labelled periodic-airbox
verification requires `assembly_kind=mfem_weak_form_shared_domain` and matching
managed assembly and physics evidence.

(implementation-mapping)=
## 7. Implementation and evidence mapping

| Contract | Source/evidence |
|---|---|
| Shared-domain P1 blocks and reciprocal sign | `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`; `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp` |
| CPU Schur MatShell, two-pass window certificate, cluster rank and invariant-subspace comparison | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`; `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` |
| GPU device Schur PETSc/SLEPc realization | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`; `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp` |
| Oracle-independent single-point request lowering | `crates/fullmag-runner/src/dispatch.rs`; `eigen_path_single_k_point_plan` |
| Deferred physical K0-3 field sweep | Requires a separate physics-owned field-sweep request; the Kittel oracle cannot supply physical fields. |
| CPU/GPU parity and transfer audit | `docs/audits/2026-08-02-fem-k0-eigensolve-current-status.md`; `scripts/verify_fem_frequency_domain_eigen_artifacts.py` |
| Artifact validation and mode payloads | `scripts/verify_fem_frequency_domain_eigen_artifacts.py`; `docs/specs/frequency-domain-artifacts-v2.md` |

(discrete-realization)=
## 8. Discrete realization and validation strategy

The CPU and GPU lanes share the FEM weak-form physics and descriptor signs,
but use separate PETSc/MFEM runtime realizations. CPU uses host PETSc vectors
and the bounded Schur MatShell. GPU uses managed PETSc/SLEPc with
`seqaijcusparse` matrices, `seqcuda` vectors, device Schur application and
zero per-iteration full-vector transfers. The materialized GPU path is bounded
to descriptor dimensions through 1024; larger problems select a matrix-free
shell and still require convergence and scaling evidence.

Validation proceeds in this order:

1. Manufactured Robin and Dirichlet potential tests establish weak-form signs
   and gauge policy.
2. Sphere/ellipsoid tests establish demag field sign and energy positivity.
3. Primitive/supercell x/y PBC tests establish airbox periodic reduction.
4. K0-1, K0-2 and K0-3 field sweeps establish Larmor, local stiffness and
   thin-film Kittel behavior respectively.
5. Multi-mode selected-spectrum tests establish the target transformation.
6. CPU `frequency_window` tests perturb both shift schedule and `nev`, preserve
   degenerate clusters by rank, compare invariant subspaces, and fail closed on
   disagreement, cancellation, or diagnostic truncation.
7. CPU/GPU parity applies only after both operate on the same real assembled
   blocks and both certify the original descriptor residual.

(validation)=
## 9. Validation evidence and completion gates

Existing managed artifacts demonstrate bounded CPU/GPU execution, residual
certification, normalized mode metadata, spectrum/branch/dispersion payloads,
binary plus Zarr mode fields, and GPU residency telemetry. Their 15-point
frequency sweep used analytical Kittel samples to set the physical external
field, so it cannot qualify K0-3 physics or CPU/GPU field-sweep parity. Fresh
physics validation requires a separate physical field-sweep request whose
inputs are independent of the analytical oracle.

The bounded evidence does not qualify arbitrary mesh sizes, the GPU
matrix-free branch, damping, nonzero k, or release-wide negative/capability
coverage. Those are explicit continuation gates, not implied by the Kittel
fixture.

The source-level CPU window contract is covered by deterministic synthetic
tests for two separated modes, one rank-two degenerate cluster, disagreement
when a request would split that cluster, and cancellation. On 2026-08-11 the
focused target compiled and these four cases completed in the repository FEM
container. This is implementation evidence only: the authoritative managed
recipe could not materialize its runtime because its target below
`/mnt/fullmag-zfn2-native/managed-fem-runtime/` was not writable. Therefore no
fresh managed CPU solve or production qualification is claimed here.

## 10. Completeness checklist

- [x] Real shared-domain FEM modal block assembly for the bounded P1 K0 CPU scope
- [x] BC-dependent gauge policy for the bounded CPU path
- [x] ADR-017 `real_frequency_rotated` selected-spectrum transform with
  `tau=omega_target` for the managed real PETSc/SLEPc runtime
- [x] Full original-block residual certification for the bounded CPU and GPU paths
- [x] Source-level two-pass CPU window refinement certificate with cluster-rank
  and invariant-subspace comparison
- [ ] Fresh authoritative managed-runtime execution of the CPU window certificate
- [ ] Independent K0-3 physical field sweep and managed CPU/GPU parity evidence
- [x] Bounded device-resident GPU modal solver for the materialized Schur path
- [ ] GPU matrix-free convergence and scaling beyond the materialized bound
- [ ] Nonzero-k Floquet dynamic demag

(limitations)=
## 11. Known limits and deferred work

Nonzero-k dynamic demag, damping qualification, nonuniform-texture
qualification, arbitrary mesh-size coverage, GPU matrix-free convergence,
large-problem scaling, an explicit physical K0 field-sweep request, and broad
periodic-airbox release gates remain open.
They must fail explicitly rather than reuse this bounded k=0 path.

The two-pass window certificate establishes stability of the requested modal
prefix under one deterministic shift-grid and `nev` perturbation. It is not a
contour-integral eigenvalue count and must not be interpreted as a mathematical
proof that every eigenvalue in an arbitrary interval was found.

(scientific-bibliography)=
## 12. Scientific bibliography

- COMSOL Micromagnetics Module User's Guide V2.13, frequency-domain chapter.
- `docs/physics/0700-frequency-domain-linearized-llg.md`.
- `docs/physics/0800-fem-static-pbc-demag.md`.
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`.
- `docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md`.

(source-code-index)=
## 13. Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Public stage construction | `packages/fullmag-py/src/fullmag/world.py` | `eigenmodes_stage` |
| CPU shared-domain Schur solve | `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp` | `FrequencyDomainStatus solve_poisson_airbox_modal_eigen_cpu_schur` |
| CPU two-pass window certificate contract | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowPublishesCompleteCertificateForSyntheticFixture` |
| CPU degenerate-cluster subspace contract | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowCertifiesDegenerateClusterByInvariantSubspace` |
| CPU degenerate-cluster disagreement contract | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowFailsClosedWhenRequestSplitsDegenerateCluster` |
| CPU empty-failure flag and count contract | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowEmptyFailurePreservesFlagsAndCounts` |
| CPU cancellation flag contract | `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp` | `void FrequencyWindowCancellationPreservesStopReason` |
| GPU PETSc/SLEPc Schur solve | `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp` | `FrequencyDomainStatus solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` |
| Runner native shared-domain state | `crates/fullmag-runner/src/fem_eigen.rs` | `build_shared_domain_linearization_state` |
| Oracle-independent single-k lowering | `crates/fullmag-runner/src/dispatch.rs` | `eigen_path_single_k_point_plan` |
| K0 sweep artifact validation | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_k0_kittel_field_sweep` |
| GPU device provenance validation | `scripts/verify_fem_frequency_domain_eigen_artifacts.py` | `validate_gpu_modal_k0_periodic_airbox_provenance` |
