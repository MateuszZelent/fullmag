---
title: Demag Solvers
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: demag solver terminal pages, their source maps, and source revision 88c7160080bc1e8519950df283d2dd02087cc3da
---

(public-docs-numerical-methods-demag-solvers-root)=
# Demagnetization solver realizations

:::{admonition} One interaction, several boundary-value problems
:class: important

The physical demagnetizing field is defined once under
{doc}`../../physics/interactions/demagnetization/index`. The methods below are distinct numerical
realizations of that interaction. Changing from an open FDM convolution to an FEM airbox, FEM/BEM,
or a periodic operator changes the discrete boundary-value problem and must be recorded in
`ProblemIR` and execution provenance.
:::

## Magnetostatic problem

In the absence of free currents, the demagnetizing field satisfies

```{math}
:label: eq-demag-root-maxwell
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot\left(\mathbf H_{\mathrm d}+\mathbf M\right)=0
\quad\text{in }\mathbb R^3,
\qquad
\mathbf H_{\mathrm d}(\mathbf x)\to\mathbf0
\quad\text{as }|\mathbf x|\to\infty.
```

Writing $\mathbf H_{\mathrm d}=-\nabla u$ gives

```{math}
:label: eq-demag-root-potential
\nabla^2u=\nabla\cdot\mathbf M
```

in the distributional sense, including the magnetization jump at the magnetic boundary. The
magnetostatic energy is

```{math}
:label: eq-demag-root-energy
E_{\mathrm d}
=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

All implementations must preserve this sign and SI convention. They differ in how the infinite
exterior, periodicity, scalar-potential gauge, source integration, and field recovery are
approximated.

## Realization matrix

| Realization | Discrete unknown/operator | Exterior treatment | Current lane boundary | Terminal page |
|---|---|---|---|---|
| FDM Newell convolution | cell-averaged $3\times3$ tensor kernel and FFT spectra | open zero-padded embedding | CPU reference and CUDA source-backed lanes | {doc}`fdm-convolution` |
| FEM Poisson airbox | scalar potential on a conforming magnetic-plus-air mesh | finite Dirichlet or Robin outer closure | FEM CPU implemented; CUDA Poisson components source-backed | {doc}`fem-poisson-airbox` |
| FEM/BEM Fredkin--Koehler | interior sparse FEM solves plus dense boundary map | boundary integral represents open space | FEM CPU source-backed; GPU unsupported | {doc}`fem-bem` |
| Periodic demag | FDM periodic-image kernel or FEM reduced periodic potential | explicit periodic lattice and gauge/zero-mode policy | FDM/FEM CPU source-backed; GPU qualification is policy-specific | {doc}`periodic-demag` |

The public `Demag.model` normalization vocabulary may contain values beyond the four qualified pages,
including `fmm`. At the reviewed revision, this documentation makes no executable FMM claim because
no terminal method page and source map qualify such a lane. The planner must reject an unavailable
realization rather than replace it silently.

## FDM cell-averaged convolution

### Discrete field

For destination cell $p$, source cell $q$, and Cartesian components $i,j$,

```{math}
:label: eq-demag-root-fdm-field
H_{\mathrm d,p,i}
=-\sum_q\sum_jN^{\mathrm{cell}}_{pq,ij}M_{q,j}.
```

$\mathbf N^{\mathrm{cell}}$ is the demagnetization tensor averaged over the source and destination
rectangular cells. Fullmag constructs it with the Newell formulas in
`crates/fullmag-fdm-demag/src/newell.rs` — `compute_newell_kernels`. The discrete tensor symmetry
reduces storage and enables convolution, but the self term, cell dimensions, padding, and ordering
remain part of the implementation contract.

The corresponding energy reduction is

```{math}
:label: eq-demag-root-fdm-energy
E_{\mathrm d,h}
=-\frac{\mu_0}{2}\sum_pV_p
\mathbf M_p\cdot\mathbf H_{\mathrm d,p}.
```

### FFT acceleration

For a translationally invariant embedding,

```{math}
:label: eq-demag-root-fdm-fft
\widehat{\mathbf H}_{\mathrm d}(\mathbf k)
=-\widehat{\mathbf N}^{\mathrm{cell}}(\mathbf k)
\widehat{\mathbf M}(\mathbf k).
```

An open-boundary convolution requires zero padding large enough to prevent circular wrap-around.
Kernel spectra are geometry- and grid-dependent and should be cached across field evaluations. For
$N$ padded cells, the transform cost is $O(N\log N)$ with $O(N)$ spectra and work arrays. The actual
memory coefficient depends on precision, real-to-complex packing, tensor symmetry, batched plans,
and whether input, spectra, and outputs remain device-resident.

The CPU route builds spectra in
`crates/fullmag-engine/src/fdm/cpu/fft.rs` — `compute_newell_kernel_spectra`; tensor multiplication
and sign convention are owned by `crates/fullmag-fdm-demag/src/multiply.rs` —
`accumulate_tensor_convolution`. The CUDA FP64 dispatch is
`backends/fdm/gpu/cuda/interactions/demag_fp64.cu` — `launch_demag_field_fp64`.

### Open and periodic policies are not interchangeable

Open zero padding approximates an isolated finite body. `truncated_images` explicitly sums a finite
set of translated copies. A periodic reciprocal or reduced-potential method represents an infinite
periodic problem with a zero-mode convention. These three policies can produce different fields
for the same unit-cell magnetization and must never share an unlabeled cache key.

## FEM Poisson airbox

Let $\Omega_a=\Omega_m\cup\Omega_{\mathrm{air}}$ be a conforming magnetic-plus-air domain and
$\Gamma_a$ its selected outer boundary. The strong equations are

```{math}
:label: eq-demag-root-airbox-strong
\nabla^2u=\nabla\cdot\mathbf M
\quad\text{in }\Omega_m,
\qquad
\nabla^2u=0
\quad\text{in }\Omega_a\setminus\Omega_m.
```

For Robin closure, Fullmag documents the weak problem

```{math}
:label: eq-demag-root-airbox-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\int_{\Gamma_a}\beta uv\,\mathrm dS
=
\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV,
```

with

```{math}
:label: eq-demag-root-airbox-robin
\partial_nu+\beta u=0,
\qquad
\beta=\frac{c}{R_\star}.
```

Dirichlet closure instead fixes the selected outer degrees of freedom to $u=0$ and omits the Robin
boundary mass term. Neither closure is the exact infinite-domain condition at finite airbox size.
A production result therefore requires **two** independent limits:

1. mesh/order and algebraic-solver convergence at fixed airbox;
2. airbox-extent and outer-closure convergence at a sufficiently resolved mesh.

The CPU implementation separates RHS assembly, boundary construction, Hypre/MFEM solution, field
recovery, and energy reduction:

| Responsibility | Source symbol |
|---|---|
| magnetic source | `demag_poisson_rhs.cpp` — `assemble_demag_poisson_rhs` |
| Dirichlet/Robin operator | `demag_poisson_boundary.cpp` — `initialize_demag_poisson_boundary_operator` |
| Krylov/Hypre solve | `demag_poisson_hypre.cpp` — `solve_demag_poisson_hypre` |
| $-\nabla u$ recovery and magnetic masking | `demag_poisson_recovery.cpp` — `recover_demag_poisson_field` |
| field-based energy | `demag_poisson_energy.cpp` — `demag_poisson_energy_from_field` |

The device source `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` —
`demag_rhs_csr_kernel` establishes a CUDA RHS implementation, but does not by itself prove a
complete device-resident Poisson solve for every mesh, preconditioner, or boundary policy.

## FEM/BEM Fredkin--Koehler realization

The hybrid method avoids volumetric air by decomposing

```{math}
:label: eq-demag-root-bem-decomposition
u=u_1+u_2,
```

where $u_1$ solves the interior Poisson problem and $u_2$ is harmonic in the magnetic body. A dense
boundary-integral map converts the trace of $u_1$ into boundary values for $u_2$. Fullmag explicitly
builds this map in `demag_fem_bem_operator.cpp` — `DenseDemagBemOperator::build`, including the
solid-angle contribution required at boundary nodes.

The current orchestration is
`backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` —
`context_compute_demag_fem_bem`. Sparse subproblems are handled by
`solve_demag_fem_bem_sparse_system`; boundary values are injected by
`prepare_demag_fem_bem_dirichlet_rhs`.

For $N_\Gamma$ boundary degrees of freedom, a directly stored dense map has
$O(N_\Gamma^2)$ storage and apply cost. This can dominate a fine three-dimensional problem even
though no air volume is meshed. The original Fredkin--Koehler scaling argument exploits
$N_\Gamma=O(N^{2/3})$ for regular three-dimensional meshes, giving storage $O(N^{4/3})$ in terms of
volume unknowns $N$. Fullmag documentation must report the actual boundary size rather than infer
performance from the volume-node count alone.

The reviewed production claim is FEM CPU. A GPU request must fail capability validation; CPU
execution is not an acceptable hidden fallback.

## Periodic demagnetization

### FDM truncated images

For lattice translations $\mathbf t_{\boldsymbol\ell}$ and a finite image set $\mathcal I$,

```{math}
:label: eq-demag-root-periodic-fdm
\mathbf H_{\mathrm d}(\mathbf r_i)
=-\sum_{\boldsymbol\ell\in\mathcal I}
\sum_j
\mathbf N\!\left(\mathbf r_i-\mathbf r_j-
\mathbf t_{\boldsymbol\ell}\right)\mathbf M_j.
```

`image_counts=(n_x,n_y,n_z)` defines this finite approximation. Increasing the counts is a
convergence study, not a change in physical sample size. The spectra owner is
`compute_periodic_newell_kernel_spectra` in `crates/fullmag-engine/src/fdm/cpu/fft.rs`.

### FEM periodic reduction

Let $P$ prolong reduced representative degrees of freedom to the full mesh. The periodic scalar
potential system is

```{math}
:label: eq-demag-root-periodic-fem
A_p=P^{\mathsf T}A_{\mathrm{open}}P,
\qquad
b_p=P^{\mathsf T}b,
\qquad
A_pu_p=b_p.
```

The implementation owner is
`backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` —
`solve_demag_periodic_poisson_reduced`. Periodic node pairing, representative orientation, gauge,
nullspace, and zero-mode treatment are part of the operator. A visually periodic mesh is
insufficient if its algebraic equivalence classes are wrong.

## Public API and canonical intent

```python
# %% Select one demagnetization realization explicitly
import fullmag as fm

nm = 1.0e-9
study = fm.study("poisson_demag")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(fm.Box(500 * nm, 125 * nm, 3 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.demag(model="airbox", variant="robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=500,
)
study.stages.add_relax(stage_id="equilibrium", tolT=1.0e-6)
```

| Public value | Meaning | Validation consequence |
|---|---|---|
| `Demag.model="airbox"` | shared-domain FEM scalar potential | requires an FEM magnetic-plus-air mesh and supported closure |
| `Demag.variant="robin"` | Robin outer operator | records the closure; must not normalize to Dirichlet |
| `Demag.model="fredkin_koehler"` | body-only FEM/BEM | CPU-only at the reviewed qualification boundary |
| FDM cell-size policy | Newell cell geometry and FFT grid | object extents and grid compatibility are validated |
| `FemLinearSolverPolicy.solver` | `CG` or `GMRES` | must be compatible with the assembled operator/preconditioner |
| `FemLinearSolverPolicy.preconditioner` | `AMG`, `JACOBI`, or `NONE` | resolved dependency and setup are provenance |
| `FemLinearSolverPolicy.rtol` | relative algebraic tolerance, default $10^{-8}$ | positive; achieved residual must be reported |
| `FemLinearSolverPolicy.max_iterations` | iteration ceiling, default 500 | budget exhaustion is a failed/unconverged solve |
| `FdmPbc.demag` | `open`, `truncated_images`, or `periodic_airbox_k0` | selects a different boundary operator; unsupported solver combinations fail |

The terminal pages own the exact aliases and `ProblemIR` paths. Requested realization and resolved
execution remain separate: serializing `poisson_robin` does not prove Hypre, CUDA, or a particular
preconditioner executed.

## Choosing a realization

| Situation | Appropriate starting point | Required convergence evidence |
|---|---|---|
| Regular Cartesian finite body | open FDM Newell/FFT | cell refinement, padding/self-term checks, energy--field consistency |
| Periodic FDM unit cell with finite image approximation | truncated-image spectra | image-count convergence and lattice-axis verification |
| Curved FEM body with scalable sparse solve | Poisson airbox | mesh, airbox extent, closure, and algebraic residual studies |
| FEM body where avoiding air volume is decisive | Fredkin--Koehler FEM/BEM | boundary refinement, dense-map accuracy and memory scaling |
| Fully periodic FEM potential | reduced periodic Poisson | node-pair consistency, gauge/nullspace, zero-mode and mesh convergence |

No choice is universally superior. FDM convolution trades geometric flexibility for regular-grid
FFT efficiency. Poisson airbox trades open-boundary exactness for sparse scalability. FEM/BEM avoids
air cells but introduces a dense boundary object. Periodic formulations solve a different physical
boundary problem.

## Validation requirements

### Analytical and manufactured cases

- uniformly magnetized rectangular prisms: compare volume-averaged field and energy with an
  independently evaluated demagnetizing tensor;
- ellipsoids: verify approximately uniform internal field on converged geometry/mesh sequences;
- zero magnetization: field and energy must be zero within roundoff and solver tolerance;
- potential manufactured solution in an airbox: verify weak-form order, boundary closure, and field
  recovery independently.

### Variational consistency

For an admissible perturbation $\boldsymbol\eta$,

```{math}
:label: eq-demag-root-directional-derivative
\frac{E_{\mathrm d}(\mathbf m+\varepsilon\boldsymbol\eta)
-E_{\mathrm d}(\mathbf m-\varepsilon\boldsymbol\eta)}{2\varepsilon}
\to
-\mu_0\int_{\Omega_m}M_s
\mathbf H_{\mathrm d}\cdot\boldsymbol\eta\,\mathrm dV.
```

This test detects sign, factor-of-two, masking, volume-weight, and field-recovery errors that a
field-only comparison can miss.

### Algebraic and boundary evidence

Record the scalar-potential residual, iteration count, convergence reason, gauge/nullspace policy,
outer boundary, periodic equivalence digest, airbox size, and boundary-operator dimensions. A small
Krylov residual does not establish small truncation or mesh error.

### CPU/GPU parity

Use identical kernel spectra or assembled operators, mesh/grid, precision policy, magnetization,
and energy reduction. Compare both field norms and total energy. A source-visible CUDA kernel is
not evidence that host fallback or repeated transfers were absent.

## Implementation source index

| Realization | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| FDM tensor construction | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels` | cell-averaged Newell kernel |
| FDM tensor multiply | `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` | tensor-vector convolution and sign |
| FDM open spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_newell_kernel_spectra` | padded CPU kernel spectra |
| FDM periodic spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | periodic/image kernel spectra |
| FDM CPU field and energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `demag_field_from_vectors` | reference field and reduction |
| FDM CUDA field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | FP64 device dispatch |
| FEM Poisson RHS | `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | magnetic source assembly |
| FEM Poisson boundary | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Dirichlet/Robin closure |
| FEM Poisson solve | `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp` | `solve_demag_poisson_hypre` | linear solve and telemetry |
| FEM field recovery | `backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp` | `recover_demag_poisson_field` | $-\nabla u$ and magnetic mask |
| FEM/BEM dense map | `backends/fem/cpu/mfem/interactions/demag_fem_bem_operator.cpp` | `DenseDemagBemOperator::build` | boundary-integral operator |
| FEM/BEM orchestration | `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | hybrid solve pipeline |
| FEM periodic reduction | `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` | representative reduction and gauge |

## Limitations

- Open FDM convolution is tied to Cartesian cell geometry and a specific padding convention.
- Finite airboxes introduce truncation error even when the linear system is solved exactly.
- The documented FEM/BEM map is dense and currently CPU-only.
- Periodic image truncation is not the same as an exact infinite lattice sum.
- Periodic scalar potentials require an explicit gauge/zero-mode policy.
- The existence of the public `fmm` vocabulary is not an executable production claim at this
  revision.
- Algebraic residual, mesh error, airbox error, and physical model error are independent quantities.

## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Wiley, 1963.
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *Journal of Geophysical Research* **98**, 9551--9555 (1993),
   [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
3. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE
   Transactions on Magnetics* **26**, 415--417 (1990),
   [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
4. C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical
   Journal B* **92**, 120 (2019),
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
5. R. Anderson et al., “MFEM: A modular finite element methods library,” *Computers & Mathematics
   with Applications* **81**, 42--74 (2021),
   [doi:10.1016/j.camwa.2020.06.009](https://doi.org/10.1016/j.camwa.2020.06.009).

```{toctree}
:maxdepth: 1

fdm-convolution
fem-poisson-airbox
fem-bem
periodic-demag
```
## Control Room crosswalk

This is a navigation page; use the terminal page named by the selected stage or solver. The category itself has no standalone editor. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
