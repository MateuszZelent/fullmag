---
title: Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md
---

(public-docs-physics-interactions-demagnetization-boundary-conditions)=
# Boundary Conditions

Boundary conditions select the magnetostatic Green problem. They are part of the physical
realization and the numerical operator, not a cosmetic mesh option. This chapter documents the
outer closure for the shared-domain FEM Poisson realization and contrasts it with the FDM
open-boundary convolution. The complete Poisson solve, field recovery, and energy reduction are
documented in {doc}`fem-poisson-airbox`; this page owns the boundary operator and its
provenance.

(demag-boundary-problem-statement)=
## 1. Physical problem and boundary partition

Let $\Omega_m$ be the magnetic region, $\Omega_a$ the conforming magnetic-plus-air FEM domain, and
$\Gamma_a$ the selected outer airbox boundary. In the unbounded physical problem the scalar
potential decays at infinity. A finite FEM domain must replace that condition by an explicit
operator on $\Gamma_a$.

The mesh does not make every boundary face an outer airbox face. Each boundary face carries a
marker. The resolved `poisson_boundary_marker` selects the marker that represents
$\Gamma_a$. Interface faces between magnetic and air elements, periodic seam faces, and unrelated
boundary markers must not be accidentally included in the outer boundary operator.

The FDM realization has no FEM boundary marker, boundary mass matrix, or essential true-DOF list.
Its open boundary is represented by the finite convolution embedding and zero padding; periodic
FDM uses a different image or spectral policy. Consequently, a FEM marker error cannot be repaired
by changing an FDM parameter.

(demag-boundary-governing-equations)=
## 2. Governing equations

The ideal open-boundary condition is

```{math}
:label: eq-demag-boundary-open
u(\mathbf x)\longrightarrow0
\qquad\text{when}\qquad
|\mathbf x|\longrightarrow\infty.
```

The two finite-airbox closures are different mathematical problems.

### Dirichlet closure

The selected outer boundary is assigned a prescribed potential:

```{math}
:label: eq-demag-boundary-dirichlet
u=0\qquad\text{on }\Gamma_a.
```

The value is enforced as an essential condition. In the discrete MFEM system, the corresponding
essential true degrees of freedom are discovered from the selected boundary marker and eliminated
from the sparse operator. The operator is not merely relabelled; its rows and columns are changed.

### Robin closure

The selected outer boundary uses a first-order open-boundary approximation:

```{math}
:label: eq-demag-boundary-robin
\partial_n u+\beta u=0
\qquad\text{on }\Gamma_a,
\qquad
\partial_n u=\mathbf n\cdot\nabla u.
```

Here $\partial_n$ is the outward normal derivative. Integrating the Poisson equation by parts
adds a boundary mass contribution to the volume stiffness operator:

```{math}
:label: eq-demag-boundary-robin-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\beta\int_{\Gamma_a}uv\,\mathrm dS
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV
\qquad\forall v\in V.
```

Its discrete operator is

```{math}
:label: eq-demag-boundary-robin-discrete
A_{\mathrm R}=K+\beta B_{\Gamma_a}.
```

$K$ is assembled from the volume stiffness integrator and $B_{\Gamma_a}$ is assembled from a
boundary mass integrator on the selected marker only. The Robin surface contribution is therefore
an operator contribution, not an additional post-processing energy term.

(demag-boundary-robin-scaling)=
## 3. Robin coefficient and resolved geometry

The current runtime derives $\beta$ from a dimensionless coefficient $c$ and a reference radius
$R_\star$:

```{math}
:label: eq-demag-boundary-beta-scaling
\beta=\frac{c}{R_\star},
\qquad
R_\star=\frac12\max_{d\in\mathcal A_{\mathrm open}}
\left(x_{d,\max}-x_{d,\min}\right).
```

$\mathcal A_{\mathrm open}$ contains the non-periodic coordinate axes. If the mesh has periodic
node-pair metadata, the planner excludes the corresponding axes from this extent calculation. If
no open axis is found, the implementation uses the largest mesh extent as the fallback reference
scale and records that resolved policy. The fallback is not a claim that a fully periodic problem
has become an open-boundary problem.

The runtime policy can select the dimensionless coefficient by mode:

* the default policy uses the configured `robin_beta_factor`;
* mode `1` forces $c=1$;
* mode `2` forces $c=2$;
* an invalid boundary marker fails before the matrix is accepted.

The effective $\beta$ is a resolved value derived from the actual mesh. The current public Python
API selects `variant="robin"` but does not expose $c$ or $\beta$ as independent user
parameters. They must therefore be reported from runtime/provenance diagnostics, not reconstructed
from the Python request alone.

(demag-boundary-discrete-operator)=
## 4. Exact implementation sequence

For FEM CPU the boundary module is called after the volume Poisson bilinear form exists:

1. determine whether the resolved realization is Robin or Dirichlet;
2. inspect the mesh boundary-attribute range;
3. validate that `poisson_boundary_marker` is a valid marker;
4. for Robin, build a zero/nonzero marker array with only the selected outer marker enabled;
5. remove periodic seam markers from that Robin marker array;
6. assemble and finalize the boundary mass matrix $B_{\Gamma_a}$;
7. form $A_{\mathrm R}=K+\beta B_{\Gamma_a}$ and clear the essential-DOF list;
8. for Dirichlet, discover essential true DOFs on the selected marker;
9. reject an empty essential-DOF list;
10. eliminate the Dirichlet rows and columns from the sparse operator;
11. pass the boundary-conditioned operator to the configured CG/GMRES and preconditioner path.

The boundary module does not assemble the magnetic right-hand side, solve the potential, recover
$\mathbf H_{\mathrm d}$, or reduce $E_{\mathrm d}$. Those ownership boundaries are deliberate so
that the same field and energy contract is used for Dirichlet and Robin.

(demag-boundary-symbols-and-si-units)=
## 5. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $u$ | magnetic scalar potential | $\mathrm{A}$ |
| $\mathbf n$ | outward unit normal on $\Gamma_a$ | $1$ |
| $\partial_n u$ | outward normal derivative of the scalar potential | $\mathrm{A\,m^{-1}}$ |
| $\beta$ | Robin boundary coefficient | $\mathrm{m^{-1}}$ |
| $c$ | dimensionless Robin coefficient selected by runtime policy | $1$ |
| $R_\star$ | mesh reference radius for Robin scaling | $\mathrm{m}$ |
| $\Omega_m$ | magnetic subdomain | $\mathrm{m^3}$ |
| $\Omega_a$ | complete magnetic-plus-air FEM domain | $\mathrm{m^3}$ |
| $\Gamma_a$ | selected outer airbox boundary | $\mathrm{m^2}$ |
| $\mathcal A_{\mathrm open}$ | set of non-periodic coordinate axes | $1$ |
| $\mathbf M$ | magnetization field in the magnetic subdomain | $\mathrm{A\,m^{-1}}$ |
| $V$ | FEM trial/test-function space | $1$ |
| $K$ | assembled volume stiffness matrix | $\mathrm{m}$ |
| $B_{\Gamma_a}$ | assembled boundary mass matrix on $\Gamma_a$ | $\mathrm{m^2}$ |
| $A_{\mathrm R}$ | Robin-conditioned sparse operator | $\mathrm{m}$ |
| $v$ | FEM test function | $1$ |
| $x_{d,\max},x_{d,\min}$ | mesh extrema on open axis $d$ | $\mathrm{m}$ |
| $\mathrm{marker}$ | integer physical boundary attribute | $1$ |

(demag-boundary-assumptions-and-validity)=
## 6. Assumptions and validity limits

Robin is an approximation to the exterior Dirichlet-to-Neumann map. Its error depends on the
airbox shape, distance, mesh resolution, selected coefficient, and unresolved multipole content.
Dirichlet is also a finite-domain truncation; $u=0$ on a nearby boundary is not the exact
condition at infinity.

The following comparisons are invalid:

* comparing Dirichlet and Robin as if they were two tolerances of one operator;
* changing $\beta$ while changing airbox distance and calling the difference solver error;
* including periodic seam faces in the open Robin mass matrix;
* accepting a Dirichlet solve with no selected essential true DOFs;
* treating a low Krylov residual as proof that the airbox truncation error is small;
* claiming FDM/FEM parity without matching the physical boundary problem.

Convergence must vary airbox distance, airbox mesh size, magnetic mesh size, boundary variant, and
linear-solver tolerances independently. A production report must include the resolved marker,
$\beta$, open-axis set, periodic seam set, matrix policy, and solver convergence telemetry.

(demag-boundary-python-api)=
## 7. Python API and complete boundary-related parameters

The public boundary selector is `Demag`; the actual FEM boundary operator also depends on
the resolved shared-domain mesh and the FEM solver policy. The solver policy is documented in full in
{doc}`../../../python-api/interactions/demagnetization`; the table below records the boundary-facing
selection and its canonical lowering.


| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | Must be `airbox` when a boundary `variant` is supplied; accepted model names are `airbox`, `bem`, `fredkin_koehler`, and `fmm`. | Selects the realization family. | FEM airbox for this chapter. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | For `airbox`, allowed values are `auto`, `robin`, and `dirichlet`; `auto` normalizes to Robin. | Selects the finite-airbox outer closure. | FEM Poisson CPU/GPU subject to qualification. | `energy[].realization` |
| `Demag.realization` | `optional str` | `None` | $1$ | Legacy values are validated against the canonical and compatibility realization vocabulary; it cannot be combined with `model`. | Selects the legacy demagnetization realization. | Legacy FDM/FEM realization paths according to the resolved value. | `energy[].realization` |

`poisson_boundary_marker`, `robin_beta_mode`, `robin_beta_factor`, the periodic seam marker
set, and the resolved effective $\beta$ are runtime/planner values rather than current public
constructor parameters. They must appear in resolved execution provenance when present.

(demag-boundary-problem-ir)=
## 8. ProblemIR and provenance

The Python-to-IR normalization is:

| Python request | Canonical `ProblemIR` realization | Boundary meaning |
|---|---|---|
| `Demag(model="airbox")` | `poisson_robin` | Default finite-airbox Robin closure. |
| `Demag(model="airbox", variant="auto")` | `poisson_robin` | Explicit auto request normalized to Robin. |
| `Demag(model="airbox", variant="robin")` | `poisson_robin` | Robin boundary mass contribution. |
| `Demag(model="airbox", variant="dirichlet")` | `poisson_dirichlet` | Essential true-DOF elimination. |

Requested intent must retain the original model and variant. Resolved execution must additionally
record the FEM lane, mesh identity, outer marker and source of that marker, periodic seam markers,
open-axis set, Robin mode/factor, effective $\beta$, solver/preconditioner, tolerances, iteration
limit, convergence state, and runtime/device identity.

(demag-boundary-round-trip-and-failure-semantics)=
## 9. Round-trip and failure semantics

Canonical Python export reproduces the requested `model` and `variant`, not merely the resolved
marker or $\beta$. The following are constructor validation errors:

* supplying `variant` without `model`;
* supplying a `variant` to `bem`, `fredkin_koehler`, or `fmm`;
* using an unknown model or airbox variant;
* combining the new `model` API with legacy `realization`.

Unsupported combinations include a boundary `variant` on `bem`, `fredkin_koehler`, or `fmm`, a
`variant` without `model`, and simultaneous use of `model` and legacy `realization`. The
planner/runtime rejects a missing shared-domain airbox mesh, a marker absent from
`mesh.bdr_attributes`, a marker outside the attribute range, and a Dirichlet selection that
produces no essential true DOFs. These are fail-closed errors. The planner must not silently
replace Robin with Dirichlet, remove the airbox, include periodic seams, or switch to FDM.

(demag-boundary-discrete-realization)=
## 10. Discrete realization by lane

### FEM CPU

MFEM assembles the selected boundary operator on the host. Robin creates a boundary mass form and
adds it to the copied sparse stiffness matrix. Dirichlet discovers essential true DOFs and
eliminates rows and columns. The resulting operator is passed to the native Hypre solver policy.

### FEM GPU

The device Poisson lane receives the resolved boundary policy and must preserve the same marker,
periodic seam exclusion, Robin coefficient, operator identity, and solver stopping semantics.
Device CSR/operator setup and device Hypre execution are separate qualification claims; a host
assembly or source compilation does not prove executed-device parity.

### FDM CPU and GPU

Neither FDM lane constructs $B_{\Gamma_a}$ or essential true DOFs. Open FDM uses the
cell-averaged tensor and its finite convolution embedding. Periodic FDM uses the selected periodic
image/spectral policy. These lanes are not alternate implementations of the FEM airbox boundary
operator.

(demag-boundary-implementation-mapping)=
## 11. Implementation mapping

The boundary operator ownership is:

1. Python `Demag` validates and normalizes the requested model/variant;
2. FEM planning resolves the shared-domain mesh, marker, periodic seams and Robin policy;
3. the native boundary module constructs the operator;
4. the linear-solver module consumes the conditioned operator;
5. recovery and energy modules consume only the solved potential/field.

(demag-boundary-validation)=
## 12. Validation and qualification

| Validation | Required evidence |
|---|---|
| Dirichlet marker | Marker is in the mesh attribute range and produces non-empty essential true DOFs. |
| Robin marker | Only the selected marker contributes to $B_{\Gamma_a}$. |
| Periodic seams | Every periodic seam marker is excluded from the Robin mass selection. |
| Robin scaling | Resolved $c$, $R_\star$, open-axis set, and $\beta=c/R_\star$ are recorded. |
| Operator identity | Robin uses $A_{\mathrm R}=K+\beta B_{\Gamma_a}$; Dirichlet uses essential elimination. |
| Solver convergence | `rtol`, `atol`, `max_iterations`, solver kind, preconditioner, residual and convergence flag are recorded. |
| Airbox convergence | Vary distance and mesh independently for each boundary variant. |
| CPU/GPU parity | Same mesh, marker, boundary policy, precision, solver policy and executed-device identity. |

Contract tests cover marker import, Robin mode/factor propagation, Dirichlet/Robin selection, and
operator construction. Runtime qualification must additionally show field and energy convergence;
source-level contract success alone is not a production numerical proof.

(demag-boundary-limitations)=
## 13. Limitations

Neither finite Dirichlet nor finite Robin is exact at a finite airbox distance. The current public
API does not expose arbitrary $\beta$ or a direct boundary-marker argument; those resolved values
come from the mesh/planner/runtime contract. A GPU source path is not reported as qualified without
executed-device evidence.

(demag-boundary-scientific-bibliography)=
## 14. Scientific bibliography

1. Fredkin, D. R. and Koehler, T. R., “A finite element method for computing demagnetizing fields
   in ferromagnetic materials,” *IEEE Transactions on Magnetics* 26 (1990).
2. Brown, W. F., *Micromagnetics*, Wiley, 1963.
3. FullMag internal reference: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`.

(demag-boundary-source-code-index)=
## 15. Source-code index

| Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Boundary variant validation and IR normalization. | Public API |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM realization and capability resolution. | FEM planner |
| `crates/fullmag-plan/src/mesh.rs` | `certified_airbox_boundary_marker` | Certified outer-boundary marker selection. | FEM planner |
| `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Robin/Dirichlet operator construction, periodic seam exclusion and marker checks. | FEM CPU |
| `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | Consumes the conditioned operator under solver policy. | FEM CPU |
| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `upload_demag_poisson_operators` | Device CSR operator upload and boundary-policy transfer. | FEM GPU |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra` | FDM open/periodic convolution realization. | FDM CPU |
| `backends/fdm/gpu/cuda/runtime/context.cu` | `context_upload_demag_kernel_spectra` | FDM device convolution state; no FEM boundary matrix. | FDM GPU |
