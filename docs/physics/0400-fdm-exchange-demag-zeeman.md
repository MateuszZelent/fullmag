# FDM foundations for exchange, demagnetization, and external field

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-03-23
- Related ADRs: `docs/adr/0001-physics-first-python-api.md`
- Related specs:
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
  - `docs/specs/exchange-bc-policy-v0.md`
- Related physics notes:
  - `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
  - `docs/physics/0200-llg-exchange-reference-engine.md`
  - `docs/physics/0300-gpu-fdm-precision-and-calibration.md`

## 1. Problem statement

This note defines the continuum model, discrete formulas, and GPU-oriented implementation target
for the three most important micromagnetic field contributions in the Fullmag FDM backend:

- exchange,
- demagnetization,
- external (Zeeman) field.

The purpose of this note is to freeze the *physical and numerical contract* before Fullmag expands
beyond the current exchange-only executable slice.

At the time of writing:

- shared semantics already include `Exchange`, `Demag`, and `Zeeman`,
- the public executable path is still the narrow exchange-only FDM reference engine,
- the GPU FDM rollout is already structured around a CUDA path with explicit precision policy.

This note therefore does **not** describe fully implemented product behavior yet.
It defines how these three interactions **must** be implemented in the FDM backend so that later
CUDA work, output naming, and cross-backend comparison remain physically consistent.

## 2. Physical model

### 2.1 Governing equations

The state variable is the reduced magnetization

$$
\mathbf{m}(\mathbf{x}, t) = \frac{\mathbf{M}(\mathbf{x}, t)}{M_s(\mathbf{x})},
\qquad
\|\mathbf{m}\| = 1,
$$

with magnetization density

$$
\mathbf{M}(\mathbf{x}, t) = M_s(\mathbf{x})\,\mathbf{m}(\mathbf{x}, t).
$$

The effective field used by the LLG integrator is the sum

$$
\mathbf{H}_{\mathrm{eff}}
=
\mathbf{H}_{\mathrm{ex}}
+
\mathbf{H}_{\mathrm{demag}}
+
\mathbf{H}_{\mathrm{ext}}
+ \cdots
$$

where this note covers only the three displayed terms.

The field is defined from the energy functional by

$$
\delta E[\mathbf{m}; \boldsymbol\eta]
=
-\mu_0 \int_\Omega M_s\,\mathbf{H}_{\mathrm{eff}}\cdot\boldsymbol\eta\,dV,
$$

for admissible perturbations $\boldsymbol\eta$ tangent to the unit sphere.
In practical derivations below, we first compute the variational derivative of each energy term and
then identify the corresponding contribution to $\mathbf{H}_{\mathrm{eff}}$.

#### 2.1.1 Exchange

The exchange energy is

$$
E_{\mathrm{ex}}[\mathbf{m}]
=
\int_\Omega A(\mathbf{x})\,|\nabla \mathbf{m}|^2\,dV
=
\int_\Omega A(\mathbf{x})
\sum_{\alpha\in\{x,y,z\}} |\nabla m_\alpha|^2\,dV.
$$

Its first variation is

$$
\delta E_{\mathrm{ex}}[\mathbf{m};\boldsymbol\eta]
=
2\int_\Omega A\,\nabla\mathbf{m}:\nabla\boldsymbol\eta\,dV.
$$

Integrating by parts gives

$$
\delta E_{\mathrm{ex}}
=
-2\int_\Omega \nabla\cdot(A\nabla\mathbf{m})\cdot\boldsymbol\eta\,dV
+
2\int_{\partial\Omega} A\,\partial_n \mathbf{m}\cdot\boldsymbol\eta\,dS.
$$

For the exchange-only release, Fullmag freezes homogeneous Neumann boundary conditions,

$$
\partial_n \mathbf{m}|_{\partial\Omega}=0,
$$

so the boundary term vanishes and

$$
\mathbf{H}_{\mathrm{ex}}
=
\frac{2}{\mu_0 M_s}
\nabla\cdot(A\nabla\mathbf{m}).
$$

For constant $A$ this reduces to

$$
\mathbf{H}_{\mathrm{ex}}
=
\frac{2A}{\mu_0 M_s}\,\nabla^2\mathbf{m}.
$$

#### 2.1.2 Zeeman / external field

The Zeeman energy is

$$
E_{\mathrm{ext}}[\mathbf{m}]
=
-\mu_0\int_\Omega \mathbf{M}\cdot\mathbf{H}_{\mathrm{ext}}\,dV
=
-\mu_0\int_\Omega M_s\,\mathbf{m}\cdot\mathbf{H}_{\mathrm{ext}}\,dV.
$$

Therefore

$$
\delta E_{\mathrm{ext}}[\mathbf{m};\boldsymbol\eta]
=
-\mu_0\int_\Omega M_s\,\mathbf{H}_{\mathrm{ext}}\cdot\boldsymbol\eta\,dV,
$$

so directly

$$
\mathbf{H}_{\mathrm{ext}} = \mathbf{H}_{\mathrm{ext}}.
$$

That sounds trivial, but it is architecturally important:
this contribution is **not** a differential operator and **not** a solve.
It is a sampled or analytic vector field in units of `A/m`.

#### 2.1.3 Demagnetization

The demagnetizing field is fixed by magnetostatics with no free current:

$$
\nabla\times\mathbf{H}_{\mathrm{demag}} = 0,
\qquad
\nabla\cdot\mathbf{B} = 0,
\qquad
\mathbf{B}=\mu_0(\mathbf{H}_{\mathrm{demag}} + \mathbf{M}).
$$

Because the curl vanishes, introduce a scalar potential $u$:

$$
\mathbf{H}_{\mathrm{demag}} = -\nabla u.
$$

Substituting into Gauss' law yields the full-space Poisson problem

$$
\Delta u = \nabla\cdot\mathbf{M}
\quad\text{in }\mathbb{R}^3,
\qquad
u(\mathbf{x})\to 0 \text{ as } |\mathbf{x}|\to\infty.
$$

Equivalently, one may write the magnetostatic energy as either

$$
E_{\mathrm{demag}} = \frac{\mu_0}{2}\int_{\mathbb{R}^3}|\mathbf{H}_{\mathrm{demag}}|^2\,dV
$$

or

$$
E_{\mathrm{demag}} = -\frac{\mu_0}{2}\int_\Omega \mathbf{M}\cdot\mathbf{H}_{\mathrm{demag}}\,dV.
$$

The effective field contribution is simply

$$
\mathbf{H}_{\mathrm{demag}} = -\nabla u,
$$

which in a translation-invariant Cartesian discretization becomes a convolution of the cell-averaged
magnetization with a demagnetizing tensor kernel.

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| $\mathbf{m}$ | reduced magnetization | 1 |
| $\mathbf{M}$ | magnetization density | A/m |
| $M_s$ | saturation magnetization | A/m |
| $A$ | exchange stiffness | J/m |
| $\mu_0$ | vacuum permeability | N/A$^2$ |
| $\mathbf{H}_{\mathrm{ex}}$ | exchange field | A/m |
| $\mathbf{H}_{\mathrm{demag}}$ | demagnetizing field | A/m |
| $\mathbf{H}_{\mathrm{ext}}$ | external field | A/m |
| $u$ | magnetic scalar potential | A |
| $E_{\mathrm{ex}}$ | exchange energy | J |
| $E_{\mathrm{demag}}$ | demagnetization energy | J |
| $E_{\mathrm{ext}}$ | Zeeman energy | J |
| $\Delta x,\Delta y,\Delta z$ | grid cell sizes | m |
| $V_i$ | cell volume | m$^3$ |
| $S_f$ | face area | m$^2$ |
| $d_f$ | distance between cell centers across face $f$ | m |

### 2.3 Assumptions and approximations

- FDM uses a regular Cartesian grid with cell-centered magnetization.
- Exchange BC is homogeneous Neumann at free surfaces.
- Demag uses open-boundary magnetostatics unless future explicit periodic policies are added.
- Cell dimensions are uniform along each axis in a given FDM plan.
- Spatially varying coefficients are allowed conceptually, but the implementation must preserve the
  semantic split between regions, material assignment, and parameter fields.
- Nonmagnetic cells are represented by `M_s = 0` and/or an inactive mask.
- The current public `Zeeman(B=...)` API is physically ambiguous because the solver ultimately
  needs `H_ext` in `A/m`. Until the API is cleaned up, the planner must normalize the user input
  and record the conversion in provenance.

## 3. Numerical interpretation

### 3.1 FDM

#### 3.1.1 Grid, masks, and state realization

An FDM execution plan should realize at least:

- grid dimensions $(n_x,n_y,n_z)$,
- cell sizes $(\Delta x,\Delta y,\Delta z)$,
- active magnetic mask,
- region/material ownership,
- per-cell or per-material values of $M_s$, $A$, and future coefficients,
- cell-centered reduced magnetization $\mathbf{m}_i$,
- optional cell-centered external field samples $\mathbf{H}_{\mathrm{ext},i}$.

The GPU implementation should store vector fields in structure-of-arrays form:

- `m_x`, `m_y`, `m_z`,
- `H_ex_x`, `H_ex_y`, `H_ex_z`,
- `H_demag_x`, `H_demag_y`, `H_demag_z`,
- `H_eff_x`, `H_eff_y`, `H_eff_z`,
- optional `M_x`, `M_y`, `M_z` scratch for demag.

This layout aligns with CUDA coalescing and with batched FFT execution.

#### 3.1.2 Exchange: discrete energy and field

For a robust FDM implementation, exchange should be derived from a **face-based discrete energy**,
not from a naive per-cell formula.

Let $f=i|j$ denote a face shared by neighboring magnetic cells $i$ and $j$.
Define the discrete exchange energy by

$$
E_{\mathrm{ex},h}
=
\sum_{f=i|j}
A_f\,\frac{S_f}{d_f}\,\|\mathbf{m}_j-\mathbf{m}_i\|^2.
$$

This formula has the correct dimensions and naturally supports

- non-cubic cells,
- piecewise materials,
- spatially varying exchange stiffness,
- interface-aware coefficients.

Taking the derivative with respect to the vector in cell $i$ gives

$$
\frac{\partial E_{\mathrm{ex},h}}{\partial \mathbf{m}_i}
=
2\sum_{f=i|j} A_f\,\frac{S_f}{d_f}\,(\mathbf{m}_i-\mathbf{m}_j).
$$

Therefore the discrete exchange field must be

$$
\mathbf{H}_{\mathrm{ex},i}
=
-\frac{1}{\mu_0 M_{s,i}V_i}
\frac{\partial E_{\mathrm{ex},h}}{\partial \mathbf{m}_i}
=
\frac{2}{\mu_0 M_{s,i}V_i}
\sum_{f=i|j} A_f\,\frac{S_f}{d_f}\,(\mathbf{m}_j-\mathbf{m}_i).
$$

For a uniform magnetic material on a rectangular grid, this collapses to the familiar second-order
central-difference form

$$
\mathbf{H}_{\mathrm{ex},i,j,k}
=
\frac{2A}{\mu_0 M_s}
\left(
\frac{\mathbf{m}_{i+1,j,k}-2\mathbf{m}_{i,j,k}+\mathbf{m}_{i-1,j,k}}{\Delta x^2}
+
\frac{\mathbf{m}_{i,j+1,k}-2\mathbf{m}_{i,j,k}+\mathbf{m}_{i,j-1,k}}{\Delta y^2}
+
\frac{\mathbf{m}_{i,j,k+1}-2\mathbf{m}_{i,j,k}+\mathbf{m}_{i,j,k-1}}{\Delta z^2}
\right).
$$

##### Boundary treatment

For a free surface with Neumann BC, an exterior face contributes zero flux.
In implementation this is equivalent to either:

- omitting the exterior-face contribution, or
- mirroring the boundary value so that $\mathbf{m}_{\mathrm{ghost}}=\mathbf{m}_{\mathrm{boundary}}$.

These are equivalent for the second-order stencil currently frozen in Fullmag.

##### Heterogeneous exchange coefficient

At a magnetic interface, `A_f` must be a face-centered coefficient.
A good default for ordinary material jumps is the harmonic mean

$$
A_f = \frac{2A_iA_j}{A_i+A_j},
$$

because it is consistent with diffusive flux continuity.

Crucially, Fullmag should **not** implement heterogeneous exchange as

$$
A_i\,\nabla_h^2\mathbf{m}_i,
$$

because that mishandles material jumps.
The face-based form is the correct architectural foundation.

##### Energy density and scalar output

A compatible per-cell exchange energy density is obtained by splitting face contributions between
neighbors:

$$
e_{\mathrm{ex},i}
=
\frac{1}{2V_i}
\sum_{f=i|j}
A_f\,\frac{S_f}{d_f}\,\|\mathbf{m}_j-\mathbf{m}_i\|^2,
$$

and then

$$
E_{\mathrm{ex},h} = \sum_i e_{\mathrm{ex},i}V_i.
$$

This is the quantity that should ultimately back the canonical scalar output `E_ex`.

#### 3.1.3 Demag: tensor convolution and FFT realization

The FDM demag operator on a uniform grid should be implemented as a discrete convolution

$$
H_{\mathrm{demag},\alpha}(\mathbf{r}_i)
=
-\sum_{\beta\in\{x,y,z\}}
\sum_j N_{\alpha\beta}(\mathbf{r}_i-\mathbf{r}_j)\,M_\beta(\mathbf{r}_j),
$$

where

- $\alpha,\beta\in\{x,y,z\}$,
- $\mathbf{M}_j = M_{s,j}\mathbf{m}_j$,
- $N_{\alpha\beta}$ is the cell-averaged demagnetizing tensor for rectangular cells.

For cuboidal cells, the real-space kernel should be built from analytic Newell-type formulas.
Only six real kernels are unique by symmetry:

- $N_{xx}$,
- $N_{yy}$,
- $N_{zz}$,
- $N_{xy}$,
- $N_{xz}$,
- $N_{yz}$.

The diagonal self-term is finite and must be included correctly.
This is where a physically correct FDM demag implementation differs from a naive point-dipole sum.

##### FFT realization

Because the kernel is translation invariant on a regular grid, the open-boundary demag calculation
should use FFT-based convolution:

1. form cell-centered magnetization arrays $M_x$, $M_y$, $M_z$,
2. zero-pad each array to avoid circular-wrap contamination,
3. compute forward real-to-complex FFTs,
4. multiply by the precomputed Fourier-space demag tensor,
5. inverse FFT back to real space,
6. crop the physical domain,
7. divide by the FFT normalization convention,
8. write `H_demag` in `A/m`.

In Fourier space the operator is simply

$$
\widehat{\mathbf{H}}_{\mathrm{demag}}(\mathbf{k})
=
-\widehat{\mathbf{N}}(\mathbf{k})\,\widehat{\mathbf{M}}(\mathbf{k}),
$$

with a $3\times 3$ symmetric tensor multiply at each wavevector.

##### Padding policy

For open boundaries the standard choice is at least doubled padding in each active dimension,
for example

$$
(2n_x, 2n_y, 2n_z),
$$

so that the FFT realizes the linear convolution instead of an unphysical circular one.
The exact padding policy belongs to the execution plan and provenance.
It must not leak into the shared Python semantics.

##### GPU implementation contract

The CUDA implementation should:

- precompute and cache the Fourier-space kernel once per `(nx, ny, nz, dx, dy, dz)` geometry,
- keep `cufftHandle`s persistent across time steps,
- reuse device work buffers,
- use batched R2C/C2R transforms for the three magnetization components,
- fuse or tightly stage the $3\times 3$ complex tensor multiply,
- compute demag energy from either
  - the real-space identity
    $E_{\mathrm{demag}} = -\frac{\mu_0}{2}\sum_i V_i\,\mathbf{M}_i\cdot\mathbf{H}_{\mathrm{demag},i}$,
    or
  - an equivalent Fourier-space reduction.

##### Nonmagnetic cells

Cells outside the magnetic body should contribute zero magnetization to the convolution.
This means the demag operator may still be evaluated on the full padded grid, but only active
magnetic cells are physically meaningful for outputs and LLG stepping.

#### 3.1.4 Zeeman field realization

The discrete Zeeman energy is

$$
E_{\mathrm{ext},h}
=
-\mu_0\sum_i V_i\,M_{s,i}\,\mathbf{m}_i\cdot\mathbf{H}_{\mathrm{ext},i}.
$$

The field contribution is therefore simply

$$
\mathbf{H}_{\mathrm{ext},i} = \mathbf{H}_{\mathrm{ext}}(\mathbf{r}_i,t).
$$

Implementation paths:

- **uniform static field**: keep one host/device vector and broadcast in the update kernel,
- **uniform time-dependent field**: evaluate the time signal once per step and broadcast,
- **sampled spatial field**: store per-cell arrays in SoA form,
- **future scripted field**: sample during lowering, never in the hot loop.

##### Current API ambiguity: `B` vs `H`

The current public `Zeeman(B=...)` surface suggests a magnetic flux density in tesla, while the
solver contract and canonical output naming use `H_ext` in `A/m`.

For physical correctness, the FDM backend should consume an external field in `A/m`.
If the public input remains `B`, the planner/runtime must convert

$$
\mathbf{H}_{\mathrm{ext}} = \frac{\mathbf{B}}{\mu_0}
$$

for vacuum units and record this conversion in provenance.
A later API cleanup should prefer an explicit `H=` surface or an explicit unit-tagged field object.

#### 3.1.5 Total field accumulation

At each FDM evaluation point, the backend should accumulate

$$
\mathbf{H}_{\mathrm{eff},i}
=
\mathbf{H}_{\mathrm{ex},i}
+
\mathbf{H}_{\mathrm{demag},i}
+
\mathbf{H}_{\mathrm{ext},i}.
$$

The interaction energies remain separate and should back separate canonical scalar outputs:

- `E_ex`,
- `E_demag`,
- `E_ext`,
- later `E_total = E_ex + E_demag + E_ext + ...`.

The canonical field outputs should remain backend-independent:

- `H_ex`,
- `H_demag`,
- `H_ext`,
- later `H_eff`.

#### 3.1.6 CUDA production architecture

The intended production FDM architecture remains:

- host-side planning and dispatch in Rust/C++,
- heavy compute in CUDA kernels,
- SoA device buffers,
- persistent cuFFT plans for demag,
- explicit public precision policy `single` / `double`.

Recommended kernel split:

1. `exchange_kernel` — reads `m`, writes `H_ex` and optionally exchange energy density,
2. `assemble_M_kernel` — computes `M = M_s m` for demag,
3. `fft_demag_kernel` / FFT plan execution — writes `H_demag`,
4. `external_field_kernel` or broadcast logic — realizes `H_ext`,
5. `sum_fields_kernel` — accumulates `H_eff`,
6. `llg_step_kernel` — consumes `H_eff` and advances `m`,
7. reduction kernels for `E_ex`, `E_demag`, `E_ext`, diagnostics, and norms.

This separation keeps the physics terms modular while still allowing later fusion where profiling
proves it beneficial.

### 3.2 FEM

This note is FDM-specific.
For the FEM weak forms and the MFEM/libCEED/hypre GPU architecture, see:

- `0410-fem-exchange-demag-zeeman-mfem-gpu.md`

The only invariant enforced here is semantic:
`Exchange`, `Demag`, and `Zeeman` must mean the same continuum physics in FDM and FEM.

### 3.3 Hybrid

Hybrid execution is deferred.
The most likely future hybrid use for these interactions is grid-assisted demag for FEM or coupled
mesh/grid representations.
That is a planner/backend concern, not a shared-physics change.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The shared Python API already has:

- `fm.Exchange()`,
- `fm.Demag()`,
- `fm.Zeeman(...)`.

For this interaction set, the API should eventually support:

- `Zeeman` as either a uniform field, sampled field, or time signal,
- explicit unit semantics for the external field,
- no FDM-only leakage such as cell indices or FFT padding choices.

### 4.2 ProblemIR representation

The shared IR should remain backend-neutral:

- `EnergyTermIR::Exchange`,
- `EnergyTermIR::Demag`,
- `EnergyTermIR::Zeeman`.

However, the execution plan for FDM must carry more realized data than the current exchange-only
slice. In particular, a future `FdmPlanIR` for these interactions will need:

- active mask,
- realized material payloads (`M_s`, `A`, `alpha`),
- external field payload in `A/m`,
- demag realization metadata (open boundary, kernel geometry, padding policy),
- output scheduling for `H_demag`, `H_ext`, `E_demag`, `E_ext`.

These are execution-plan fields, not shared `ProblemIR` fields.

### 4.3 Planner and capability-matrix impact

The planner should own:

- Box/Cylinder/imported-geometry lowering to a regular grid,
- active mask construction,
- per-cell material realization,
- seeded/random `m0` realization,
- external-field sampling and unit normalization,
- demag kernel planning and padding decisions,
- precision propagation into the executable FDM plan.

The capability matrix should continue to distinguish clearly between:

- semantic legality,
- internal numerical reference,
- public executability.

For this topic, exchange is already partially executable in FDM, while demag and Zeeman remain to
be upgraded from semantic/shared status into executable backend support.

## 5. Validation strategy

### 5.1 Analytical checks

#### Exchange

- Uniform magnetization must give `H_ex = 0` and `E_ex = 0`.
- A one-dimensional sinusoidal state
  $$
  \mathbf{m}(x)=(\cos kx, \sin kx, 0)
  $$
  should satisfy
  $$
  \mathbf{H}_{\mathrm{ex}} = -\frac{2A}{\mu_0 M_s}k^2\mathbf{m}.
  $$
- For a two-material interface, the discrete face-flux form should converge under refinement and
  must not reduce to a cell-local `A_i \nabla_h^2 m_i` artifact.

#### Demag

- Uniformly magnetized ellipsoids should reproduce the expected demag tensor relation
  $$
  \mathbf{H}_{\mathrm{demag}} = -\mathbf{N}\mathbf{M}
  $$
  within discretization error.
- Thin-film and long-rod limiting cases should show the correct shape-anisotropy trend.
- The kernel symmetry
  $$
  N_{\alpha\beta}(\mathbf{r}) = N_{\beta\alpha}(\mathbf{r})
  $$
  and parity properties should be verified in precomputation tests.

#### Zeeman

- With Zeeman as the only field and high damping, magnetization should relax toward the external
  field direction.
- Unit tests must explicitly verify the `B -> H` conversion path if the public API keeps `B`.

### 5.2 Cross-backend checks

- FDM CPU double vs CUDA double for exchange-only remains the first calibration tier.
- After demag lands, compare FDM CPU vs CUDA on small deterministic problems with open boundary.
- Once FEM exists, compare FDM/FEM on the same physical geometry after projection to common
  observables (`E_ex`, `E_demag`, total magnetization, sampled fields).

### 5.3 Regression tests

- exchange stencil tests on tiny grids,
- heterogeneous-exchange interface test,
- Newell-kernel symmetry and self-term tests,
- FFT demag parity test against direct $O(N^2)$ summation on tiny grids,
- Zeeman unit-conversion tests,
- artifact tests for `H_demag`, `H_ext`, `E_demag`, `E_ext`,
- GPU parity suite:
  - CPU double vs GPU double,
  - GPU double vs GPU single.

## 6. Completeness checklist

- [x] Python API (shared semantics)
- [x] ProblemIR (shared semantics)
- [x] Planner-facing design
- [x] Capability-matrix implications documented
- [ ] FDM backend fully implemented for this whole interaction set
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables fully wired for this whole interaction set
- [ ] Tests / benchmarks complete
- [x] Documentation

## 7. Known limits and deferred work

- The current public executable FDM path is still exchange-only.
- The current repo does not yet expose production demag or Zeeman execution.
- Periodic demag, multilayer demag, and nonuniform FFT variants are deferred.
- Interface-specific exchange terms beyond ordinary material jumps are deferred.
- Public mixed precision is deferred.
- The current `Zeeman(B=...)` API should be treated as transitional until units are made explicit.
- The final scientific artifact layer should move beyond transitional JSON/CSV bootstrap storage.

## 8. References

1. W. F. Brown, *Micromagnetics*, Interscience, 1963.
2. A. Hubert and R. Schäfer, *Magnetic Domains*, Springer, 1998.
3. A. Aharoni, *Introduction to the Theory of Ferromagnetism*, 2nd ed., Oxford University Press.
4. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for
   nonuniform magnetization,” *J. Geophys. Res.* 98(B6), 9551–9555 (1993).
5. D. M. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,”
   *IEEE Trans. Magn.* 26(2), 415–417 (1990).
