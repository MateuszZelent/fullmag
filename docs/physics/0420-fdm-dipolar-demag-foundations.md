# FDM foundations for dipolar self-interaction (demagnetization)

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-23
- Related ADRs:
  - `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
- Related physics notes:
  - `docs/physics/0000-physics-documentation-standard.md`
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`

## 1. Problem statement

This note freezes the physical and numerical contract for the **dipolar self-interaction** in the
Fullmag FDM backend.

In micromagnetics, the long-range dipole-dipole interaction of the magnetization distribution is the
same physics that is usually exposed to users as the **demagnetizing field** or **stray field**.
The previous notes already covered `Demag` at the operator level, but this note makes the dipolar
origin explicit and fixes how it must be implemented on a regular Cartesian grid.

This note covers:

- the continuum dipolar interaction,
- its magnetostatic potential formulation,
- the exact cell-averaged tensor-convolution discretization used in FDM,
- the FFT/CUDA realization appropriate for Fullmag's GPU path,
- the validation and provenance requirements that keep FDM and FEM comparable.

This note is about the continuum micromagnetic dipolar interaction.
It does **not** define an atomistic pairwise-spin solver.

## 2. Physical model

### 2.1 Governing equations

Let

$$
\mathbf{M}(\mathbf{x},t)=M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x},t),
\qquad
\|\mathbf{m}\|=1,
$$

with $\mathbf{M}$ in `A/m` and reduced magnetization $\mathbf{m}$ dimensionless.

The dipolar interaction is the magnetostatic self-interaction of $\mathbf{M}$ in free space with no
free current:

$$
\nabla\times\mathbf{H}_{\mathrm{d}} = 0,
\qquad
\nabla\cdot\mathbf{B}=0,
\qquad
\mathbf{B}=\mu_0(\mathbf{H}_{\mathrm{d}}+\mathbf{M}).
$$

Because the curl vanishes, introduce a scalar potential $u$:

$$
\mathbf{H}_{\mathrm{d}}=-\nabla u.
$$

Substituting into Gauss' law gives the full-space Poisson problem

$$
\Delta u = \nabla\cdot\mathbf{M}
\quad\text{in }\mathbb{R}^3,
\qquad
u(\mathbf{x})\to 0 \text{ as } |\mathbf{x}|\to\infty.
$$

The corresponding magnetostatic energy is

$$
E_{\mathrm{d}}
=
\frac{\mu_0}{2}\int_{\mathbb{R}^3}|\mathbf{H}_{\mathrm{d}}|^2\,dV
=
-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf{M}\cdot\mathbf{H}_{\mathrm{d}}\,dV
\ge 0.
$$

Fullmag should treat the user-facing `Demag()` term and the physics term "dipolar interaction" as
exact synonyms.

### 2.2 Magnetic-charge and dipolar-kernel formulations

Define the volume and surface magnetic charges

$$
\rho_m = -\nabla\cdot\mathbf{M},
\qquad
\sigma_m = \mathbf{M}\cdot\mathbf{n}.
$$

Then the scalar potential may be written as

$$
u(\mathbf{x})
=
\frac{1}{4\pi}\int_{\Omega_m}\frac{\rho_m(\mathbf{x}')}{|\mathbf{x}-\mathbf{x}'|}\,dV'
+
\frac{1}{4\pi}\int_{\partial\Omega_m}\frac{\sigma_m(\mathbf{x}')}{|\mathbf{x}-\mathbf{x}'|}\,dS'.
$$

This form makes the dipolar origin obvious: magnetic charges on surfaces and in the volume create a
long-range field.

An equivalent formulation uses a tensor kernel. Let

$$
G(\mathbf{r}) = \frac{1}{4\pi |\mathbf{r}|},
\qquad
\mathcal{N}_{ij}(\mathbf{r}) = -\partial_i\partial_j G(\mathbf{r}).
$$

For $\mathbf{r}\neq 0$,

$$
\mathcal{N}_{ij}(\mathbf{r})
=
\frac{1}{4\pi}
\left(
\frac{\delta_{ij}}{|\mathbf{r}|^3}
-
\frac{3r_i r_j}{|\mathbf{r}|^5}
\right).
$$

The field is then

$$
\mathbf{H}_{\mathrm{d}}(\mathbf{x})
=
-\int_{\Omega_m}\mathcal{N}(\mathbf{x}-\mathbf{x}')\,\mathbf{M}(\mathbf{x}')\,dV'.
$$

This is the continuum dipolar operator that the FDM convolution must approximate.

### 2.3 Relation to the pairwise dipole-dipole interaction

For well-separated magnetic moments, the point-dipole field is recovered from the same kernel:

$$
\mathbf{H}_{\mathrm{dip}}(\mathbf{r})
=
\frac{1}{4\pi |\mathbf{r}|^3}
\left[
3\hat{\mathbf{r}}\big(\hat{\mathbf{r}}\cdot\mathbf{m}_{\mathrm{dip}}\big)-\mathbf{m}_{\mathrm{dip}}
\right].
$$

Micromagnetics does not sum discrete atomic dipoles directly.
Instead, it uses the continuum magnetization field $\mathbf{M}(\mathbf{x})$ and the induced
magnetostatic operator shown above.

### 2.4 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| $\mathbf{m}$ | reduced magnetization | 1 |
| $\mathbf{M}$ | magnetization density | A/m |
| $M_s$ | saturation magnetization | A/m |
| $\mathbf{H}_{\mathrm{d}}$ | dipolar/demag field | A/m |
| $u$ | magnetic scalar potential | A |
| $\mu_0$ | vacuum permeability | N/A$^2$ |
| $\rho_m$ | volume magnetic charge | A/m$^2$ |
| $\sigma_m$ | surface magnetic charge | A/m |
| $\mathcal{N}$ | continuum dipolar kernel | 1/m$^3$ |
| $E_{\mathrm{d}}$ | dipolar/demag energy | J |

### 2.5 Assumptions and approximations

- The dipolar interaction is computed in the magnetostatic limit.
- The computational domain is embedded in free space with open boundaries.
- In FDM, geometry is represented on a regular Cartesian grid.
- The discrete operator is based on **cell-averaged magnetization** and **cell-averaged field**,
  not on point-sampled dipoles.
- Open boundaries are realized by zero-padded convolution, not by periodic wraparound.

## 3. Numerical interpretation

### 3.1 FDM interpretation

#### 3.1.1 Discrete state on a Cartesian grid

Let the magnetic body be represented on a regular grid of rectangular cells $V_p$ with sizes
$\Delta x, \Delta y, \Delta z$.
For each active cell $p$ define a piecewise-constant magnetization

$$
\mathbf{M}_p = M_{s,p}\,\mathbf{m}_p.
$$

Outside active cells, $\mathbf{M}=0$.
This means that free-surface and material-interface magnetic charges are generated automatically by
jumps in the piecewise-constant field.

#### 3.1.2 Exact cell-averaged tensor coefficients

The target-cell averaged demag field is

$$
\bar{\mathbf{H}}_{\mathrm{d},p}
=
\frac{1}{|V_p|}\int_{V_p}\mathbf{H}_{\mathrm{d}}(\mathbf{x})\,dV.
$$

Using piecewise-constant source cells,

$$
\bar{H}_{\mathrm{d},i,p}
=
-\sum_q \mathcal{N}^{\mathrm{cell}}_{ij}(p-q)\,M_{j,q},
$$

with translation-invariant coefficients on a uniform grid,

$$
\mathcal{N}^{\mathrm{cell}}_{ij}(\ell,m,n)
=
\frac{1}{|V_0|}
\int_{V_0}\int_{V_{\ell m n}}
\mathcal{N}_{ij}(\mathbf{x}-\mathbf{x}')\,dV'\,dV.
$$

These are the standard finite-difference demagnetizing tensor coefficients.
For rectangular cells they should be computed from the exact Newell-type closed forms, not by
numerical quadrature in the hot path.

**Newell analytic forms — kernel computation algorithm.**

The six kernel components are computed from two scalar base functions $f$ and $g$ (Newell et al.,
IEEE Trans. Magn. 29, 1993) via an 8-point antidifference.

Define the antidifference operator:

$$
\mathcal{A}[\phi](x,y,z)
=
\sum_{p,q,r \in \{0,1\}} (-1)^{p+q+r}\,
\phi\!\left(
x + \left(p-\tfrac{1}{2}\right)\Delta x,\;
y + \left(q-\tfrac{1}{2}\right)\Delta y,\;
z + \left(r-\tfrac{1}{2}\right)\Delta z
\right).
$$

The six tensor components at cell-pair displacement $(l, m, n)$ are:

$$
N_{xx}(l,m,n) = \frac{\mathcal{A}[f](l\Delta x,\;m\Delta y,\;n\Delta z)}{\Delta x\,\Delta y\,\Delta z},
\qquad
N_{yy}(l,m,n) = \frac{\mathcal{A}[f](m\Delta y,\;l\Delta x,\;n\Delta z)}{\Delta x\,\Delta y\,\Delta z},
$$
$$
N_{zz}(l,m,n) = \frac{\mathcal{A}[f](n\Delta z,\;m\Delta y,\;l\Delta x)}{\Delta x\,\Delta y\,\Delta z},
$$
$$
N_{xy}(l,m,n) = \frac{\mathcal{A}[g](l\Delta x,\;m\Delta y,\;n\Delta z)}{\Delta x\,\Delta y\,\Delta z},
\qquad
N_{xz}(l,m,n) = \frac{\mathcal{A}[g](l\Delta x,\;n\Delta z,\;m\Delta y)}{\Delta x\,\Delta y\,\Delta z},
$$
$$
N_{yz}(l,m,n) = \frac{\mathcal{A}[g](m\Delta y,\;n\Delta z,\;l\Delta x)}{\Delta x\,\Delta y\,\Delta z}.
$$

The **diagonal base function** $f(x,y,z)$, for $x,y,z\ge0$:

$$
f(x,y,z)
=
\frac{2x^2-y^2-z^2}{6}\,R
+
\frac{y(z^2-x^2)}{4}\ln\!\frac{z+R}{\sqrt{x^2+y^2}}
+
\frac{z(y^2-x^2)}{4}\ln\!\frac{y+R}{\sqrt{x^2+z^2}}
-
xyz\arctan\!\frac{yz}{xR},
$$

where $R=\sqrt{x^2+y^2+z^2}$.

Degenerate cases ($x=0$, $y=0$, $z=0$, or pairs thereof) require L'Hôpital limits; the
corresponding limit expressions are listed in Newell (1993) Table II and implemented in Boris's
`DemagTFunc_fg.cpp::f()` using `log1p` for numerical stability (avoiding cancellation near $R\approx y$ or $R\approx z$).

The **off-diagonal base function** $g(x,y,z)$ has a similar structure with 7 terms
(one polynomial-$R$, four logarithmic, two arctangent).
Its full form is given in Newell (1993) eq. (C7) and implemented in
`external_solvers/BORIS/Boris/DemagTFunc_fg.cpp::g()`.
The leading term is $-xyz R/3$; the remaining terms ensure the correct cell-averaged integral
of the off-diagonal dipolar kernel.

**Symmetry reduction.** The kernel is symmetric ($N_{ij}=N_{ji}$) and satisfies
$N_{xx}+N_{yy}+N_{zz}=\delta_{l=m=n=0}$ (trace = 1 for the self-term only).
On an open-boundary uniform grid:
- diagonal components are even in every index: $N_{xx}(-l,m,n)=N_{xx}(l,m,n)$,
- off-diagonal components are odd in each of their two active indices:
  $N_{xy}(-l,m,n)=-N_{xy}(l,m,n)$, $N_{xy}(l,-m,n)=-N_{xy}(l,m,n)$.

These symmetries allow the full kernel to be built from the first octant ($l,m,n \ge 0$) only,
then reflected into the remaining 7 octants before the FFT.
This is exactly the filling pattern in Boris's `CalcDiagTens3D` (8-fold octant placement).

**Far-field asymptotic fallback.** For cell-pair distances beyond a configurable threshold
(Boris default: 40 cell diameters), the exact $f/g$ integrals converge to a multipole expansion:

$$
N_{xx}^{\text{asymp}}(\mathbf{r})
\approx
\frac{1}{4\pi r^3}\!\left(1-\frac{3x^2}{r^2}\right)+O(r^{-5}),
\qquad
N_{xy}^{\text{asymp}}(\mathbf{r})
\approx
-\frac{3xy}{4\pi r^5}+O(r^{-7}).
$$

Boris implements these via `DemagAsymptoticDiag` and `DemagAsymptoticOffDiag` with
15 and 10 precomputed Taylor coefficients respectively.
We should use the same threshold strategy in the reference Rust implementation to avoid
unnecessary exact integrations for large grids.

**Implementation checklist for the Rust kernel builder:**

1. Implement `newell_f(x, y, z) -> f64` with special cases for zero arguments (use `log1p`).
2. Implement `newell_g(x, y, z) -> f64` following Newell (1993) eq. (C7).
3. Implement `antidiff(phi, l, m, n, dx, dy, dz) -> f64` for the 8-point formula.
4. Fill the first-octant kernel, then reflect to all 8 octants.
5. Optionally switch to asymptotic formulas beyond 40 cell radii.
6. Store as 6 real arrays of size $(N_x/2+1) \times (N_y/2+1) \times (N_z/2+1)$ in half-complex
   FFT format after taking the FFT.

Important invariants:

- only six kernel components are independent:
  $\mathcal{N}_{xx},\mathcal{N}_{yy},\mathcal{N}_{zz},\mathcal{N}_{xy},\mathcal{N}_{xz},\mathcal{N}_{yz}$,
- the self-term is finite after cell averaging,
- the discrete operator is symmetric,
- the discrete energy
  $$
  E_{\mathrm{d}} = -\frac{\mu_0}{2}\sum_p |V_p|\,\mathbf{M}_p\cdot\bar{\mathbf{H}}_{\mathrm{d},p}
  $$
  must be non-negative,
- the trace of the self demag tensor equals $1$ for a fully occupied rectangular cell.

#### 3.1.3 Why point-dipole summation is the wrong implementation target

The naive formula

$$
\mathbf{H}_p \stackrel{\text{wrong target}}{\approx}
\sum_{q\ne p}
\frac{1}{4\pi r_{pq}^3}
\left[
3\hat{\mathbf{r}}_{pq}\big(\hat{\mathbf{r}}_{pq}\cdot\mathbf{m}_q\big)-\mathbf{m}_q
\right]
$$

is not an acceptable production discretization for Fullmag FDM because it:

- treats each cell as a point dipole instead of a finite volume,
- gives the wrong near-field/self interaction,
- converges slowly with refinement,
- makes GPU scaling far worse than FFT-based convolution.

Point-dipole summation is useful only as a tiny-grid reference test.
The production discretization must be the **exact cell-averaged tensor convolution** above.

#### 3.1.4 FFT realization

Because the kernel is translation-invariant on a regular grid, the field is computed as a discrete
convolution.
The production algorithm is:

1. build the six real-space kernel arrays on the padded grid,
2. zero-pad magnetization to avoid circular wraparound,
3. FFT the three magnetization components,
4. FFT the six kernel components once and cache them,
5. perform spectral tensor multiplication,
6. inverse FFT and crop the physical domain.

In Fourier space,

$$
\widehat{H}_{x}
=
-(\widehat{N}_{xx}\widehat{M}_{x} + \widehat{N}_{xy}\widehat{M}_{y} + \widehat{N}_{xz}\widehat{M}_{z}),
$$

with analogous equations for $\widehat{H}_{y}$ and $\widehat{H}_{z}$.

#### 3.1.4a ~~Current~~ Previous implementation: spectral projection (superseded)

> **Status**:
> - the `fullmag-engine` CPU reference uses the **full Newell tensor convolution**
>   described in §3.1.2;
> - the native CUDA FDM backend now consumes the same precomputed Newell tensor spectra and
>   applies the same tensor FFT convolution with cuFFT.

The legacy spectral algorithm computes the demag field in Fourier space via the closed-form
continuum projection:

$$
\widehat{\mathbf{H}}_{\mathrm{d}}(\mathbf{k})
=
-\frac{\mathbf{k}\,(\mathbf{k}\cdot\widehat{\mathbf{M}}(\mathbf{k}))}{|\mathbf{k}|^2},
\qquad \mathbf{k}\neq 0,
$$

with $\widehat{\mathbf{H}}_{\mathrm{d}}(\mathbf{0})=0$.

This is equivalent to solving $\Delta u = \nabla\cdot\mathbf{M}$ spectrally and taking
$\mathbf{H}_{\mathrm{d}}=-\nabla u$, which is the exact continuum dipolar operator on a periodic
domain.

**Legacy implementation steps** (today mirrored by the native CUDA FDM backend, not by the CPU reference):

1. Zero-pad $\mathbf{M} = M_s \mathbf{m}$ into reusable workspace buffers of size $(2N_x, 2N_y, 2N_z)$.
2. Forward FFT all three components using cached FFT plans (`FftWorkspace`).
3. For each $\mathbf{k}$: compute $\mathbf{k}\cdot\widehat{\mathbf{M}}$, then
   $\widehat{\mathbf{H}}_i = -(k_i / |\mathbf{k}|^2)\,(\mathbf{k}\cdot\widehat{\mathbf{M}})$.
4. Inverse FFT the three field components.
5. Normalize by $1/(P_x P_y P_z)$ and crop to the physical grid.

**Trade-offs vs Newell tensor convolution**:

- **Pro**: No kernel precomputation, simpler code, exact for the continuum operator.
- **Con**: Does not capture cell-averaging effects; equivalent to point-sampling the continuum
  field at grid points rather than averaging over finite cells. For coarse grids, the Newell
  tensor gives more accurate near-field interactions.
- **Con**: Assumes periodic zero-padded boundaries rather than truly cell-averaged open boundaries.

This section is retained as historical context and as a fallback/reference implementation shape.
The canonical FDM demag path for both CPU and CUDA is now the Newell tensor FFT realization.

The standard open-boundary realization is zero-padding to at least

$$
(2N_x, 2N_y, 2N_z)
$$

before convolution.
This computes free-space demag on the original physical domain and prevents periodic image
interactions.

#### 3.1.5 CUDA implementation target

The intended GPU implementation is:

- **SoA field layout** for `Mx, My, Mz` and `Hdx, Hdy, Hdz`,
- **cached cuFFT plans** per padded shape and precision,
- **precomputed kernel spectra** uploaded once per geometry/grid,
- a **fused complex spectral multiply** kernel for the 3x3 symmetric tensor action,
- optional overlap of FFT, multiply, and artifact staging later,
- demag energy evaluated either from the cropped field or as a spectral reduction, but always
  published in physical `J`.

Precision policy:

- kernel construction and calibration should be done in double precision,
- the execution mode may later choose single or double precision according to the explicit
  precision/capability policy,
- provenance must record kernel precision, FFT precision, padding shape, and calibration profile.

#### 3.1.6 Nonuniform materials and region boundaries

For FDM, the dipolar operator acts on

$$
\mathbf{M}_p = M_{s,p}\,\mathbf{m}_p.
$$

This means:

- vacuum/outside cells are represented as $M_s=0$,
- material jumps are represented by jumps in $\mathbf{M}$,
- no separate interface-charge bookkeeping is needed in the regular-grid operator,
- geometry error comes from voxelization/staircasing, not from the dipolar operator itself.

### 3.2 FEM interpretation

The same dipolar physics in FEM is realized through a scalar-potential solve on an unstructured mesh
rather than by a tensor-product FFT convolution.
See:

- `0430-fem-dipolar-demag-mfem-gpu-foundations.md`

### 3.3 Hybrid interpretation

Hybrid dipolar execution is deferred.
A future hybrid backend may combine FDM-style convolution on regular subdomains with FEM-style
projection/coupling on irregular regions, but that is out of scope for the current contract freeze.

### 3.4 Semantic differences between backends

The shared physics is identical:

- same continuum dipolar interaction,
- same units,
- same observables `H_demag` and `E_demag`.

The numerical realization differs:

- **FDM** uses cell-averaged tensor convolution on a voxelized grid,
- **FEM** uses a potential formulation on a mesh,
- **hybrid** is deferred.

## 4. API and IR impact

### 4.1 Python API objects

No new user object is required.
The public energy term remains:

```python
fm.Demag()
```

But its documentation must explicitly say that this is the continuum **dipolar self-interaction**.

### 4.2 `ProblemIR` fields

`EnergyTermIR::Demag` already exists and remains the canonical semantic marker.
The execution plan should add FDM-specific realization metadata such as:

- `operator_kind = "fdm_demag_fft"`,
- `kernel_kind = "cell_averaged_newell"`,
- `padding = [2Nx, 2Ny, 2Nz]`,
- `fft_precision`,
- `kernel_precision`,
- `active_mask_hash`.

### 4.3 Planner impact

The planner must:

- reject `Demag()` for backends that do not yet implement it in executable mode,
- build padded-grid metadata,
- construct or reference the demag-kernel cache key,
- ensure that requested outputs `H_demag` and `E_demag` are legal when `Demag()` is active.

### 4.4 Capability-matrix impact

The capability matrix should distinguish:

- semantic support for `Demag`,
- internal-reference FDM demag,
- public-executable FDM demag,
- FEM dipolar operator status separately from local FEM terms.

## 5. Validation strategy

### 5.1 Analytical checks

- symmetry of the kernel coefficients,
- self-term trace equal to `1`,
- positivity of $E_{\mathrm{d}}$,
- average demag field for uniformly magnetized ellipsoidal/box-like benchmark cases,
- far-field agreement with the point-dipole asymptotic field.

### 5.2 Cross-backend checks

- compare FDM and FEM average demag field for the same box-like body,
- compare `E_demag` under controlled refinement,
- compare projected `H_demag` snapshots at matched times once both backends support demag.

### 5.3 Regression cases

- tiny-grid direct $O(N^2)$ cell-cell convolution vs FFT result,
- uniformly magnetized thin film,
- elongated strip with known demag-dominated shape anisotropy trend,
- multi-region voxelized geometry with varying $M_s$.

### 5.4 Observables and tolerances

Required observables:

- `H_demag`,
- `E_demag`,
- `time`,
- `step`,
- `solver_stats.max_abs_H_demag`.

For calibrated FFT demag, tolerances should be defined against:

- direct convolution on small grids,
- stable double-precision baselines,
- later cross-backend projections.

## 6. Completeness checklist

- [ ] Python API docs describe `Demag()` as dipolar self-interaction
- [ ] `ProblemIR` semantics frozen for dipolar interaction
- [ ] planner emits FDM demag realization metadata
- [ ] capability matrix split between semantic/reference/executable status
- [ ] FDM CPU reference direct-convolution path exists for tiny grids
- [ ] FDM FFT path exists and matches the reference
- [ ] CUDA/cuFFT path exists with explicit precision provenance
- [ ] outputs publish `H_demag` and `E_demag`
- [ ] validation suite includes direct-vs-FFT and box benchmarks
- [ ] docs explain the distinction between dipolar physics and the demag operator name

## 7. Known limits and deferred work

- **Newell kernel implemented**: the `fullmag-engine` CPU reference now uses the Boris-style
  27-point stencil Newell tensor convolution (§3.1.2), replacing the spectral projection
  operator. The `newell.rs` module implements `newell_f`, `newell_g`, `ldia`, and
  `compute_newell_kernels`. The precomputed kernel spectra are stored in `FftWorkspace`.
- periodic demag is out of scope for this contract;
  the baseline is free-space/open-boundary demag,
- nonuniform cell sizes are out of scope for the first FDM dipolar implementation,
- multilayer-specialized convolution is deferred,
- multi-GPU FFT decomposition is deferred,
- atomistic dipole-dipole simulations are out of scope,
- hybrid FDM/FEM dipolar coupling is deferred,
- magnetostatic field compression alternatives are not needed for tensor-product FDM v1.
