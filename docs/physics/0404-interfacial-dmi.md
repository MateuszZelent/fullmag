---
title: Interfacial Dzyaloshinskii–Moriya interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: current implementation and this publication note
---

# Interfacial Dzyaloshinskii–Moriya interaction

This note is the canonical physical owner for FullMag interfacial Dzyaloshinskii–Moriya
interaction (iDMI). It defines the energy convention, chirality sign, interface normal,
effective field, natural boundary contribution, Python/`ProblemIR` representation, and the
four solver/device realizations. It does not duplicate bulk DMI; bulk DMI has its own canonical
reference.

The public `fullmag.InterfacialDMI` term remains an energy term in `energy_terms`. A material
may also provide `Dind` or a resolved `Dind_field`; the FEM planner uses those material-owned
values when no explicit term supplies the scalar coefficient. These are two input routes to one
physical interaction, not two terms that should be added together.

## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf m=\mathbf M/M_s$ the reduced magnetization,
and $\hat{\mathbf n}$ the unit vector normal to the interface that defines the structural
inversion-breaking direction. The current model is the isotropic interfacial form

```{math}
:label: eq-interfacial-dmi-density
w_{\mathrm i}(\mathbf m,\nabla\mathbf m;D,\hat{\mathbf n})
=D\left[(\mathbf m\cdot\hat{\mathbf n})\,\nabla\cdot\mathbf m
-\mathbf m\cdot\nabla(\mathbf m\cdot\hat{\mathbf n})\right].
```

For the common $\hat{\mathbf n}=\hat{\mathbf z}$ realization, the implemented density is

```{math}
:label: eq-interfacial-dmi-z-density
w_{\mathrm i}
=D\left[m_z(\partial_xm_x+\partial_ym_y)
-m_x\partial_xm_z-m_y\partial_ym_z\right].
```

The $z$-derivative terms cancel algebraically for this fixed axis. This is not a license to
drop a derivative in the arbitrary-normal FEM expression: the normalized $\hat{\mathbf n}$ is
contracted with the complete three-dimensional gradient there.

## Governing equations

The total iDMI energy is

```{math}
:label: eq-interfacial-dmi-energy
E_{\mathrm i}[\mathbf m]=\int_{\Omega_m}w_{\mathrm i}\,\mathrm dV.
```

For a variation $\mathbf m+\varepsilon\mathbf v$, write
$G_{ab}=\partial_bm_a$ and $m_n=\mathbf m\cdot\hat{\mathbf n}$. The exact first variation
used by the FEM residual is

```{math}
:label: eq-interfacial-dmi-variation
\delta E_{\mathrm i}(\mathbf m;\mathbf v)
=\int_{\Omega_m}\left[
D\left(\hat{\mathbf n}\,\nabla\cdot\mathbf m-(\nabla\mathbf m)^T\hat{\mathbf n}\right)\cdot\mathbf v
+D\left(m_n\,I-\hat{\mathbf n}\otimes\mathbf m\right):\nabla\mathbf v
\right]\mathrm dV.
```

The colon is the component contraction
$A:B=\sum_{a,b}A_{ab}B_{ab}$. The volume effective field obtained after integration by parts
is

```{math}
:label: eq-interfacial-dmi-effective-field
\mathbf H_{\mathrm i}
=-\frac{1}{\mu_0M_s}\frac{\delta E_{\mathrm i}}{\delta\mathbf m}
=\frac{2D}{\mu_0M_s}\left[
\nabla(\mathbf m\cdot\hat{\mathbf n})
-(\nabla\cdot\mathbf m)\hat{\mathbf n}
\right].
```

For $\hat{\mathbf n}=\hat{\mathbf z}$, this becomes

```{math}
:label: eq-interfacial-dmi-z-effective-field
\mathbf H_{\mathrm i}
=\frac{2D}{\mu_0M_s}
\begin{bmatrix}
\partial_xm_z\\
\partial_ym_z\\
-(\partial_xm_x+\partial_ym_y)
\end{bmatrix}.
```

Integration by parts also produces the natural surface variation

```{math}
:label: eq-interfacial-dmi-boundary-variation
\delta E_{\mathrm i}^{\partial\Omega}
=D\int_{\partial\Omega_m}
\left[(\hat{\mathbf n}\times\boldsymbol\nu)\times\mathbf m\right]\cdot\mathbf v\,\mathrm dS,
```

where $\boldsymbol\nu$ is the outward normal of the magnetic boundary. When exchange with
stiffness $A$ is present, the free-boundary stationarity condition is

```{math}
:label: eq-interfacial-dmi-exchange-boundary
2A\,\partial_{\boldsymbol\nu}\mathbf m
+D\left[(\hat{\mathbf n}\times\boldsymbol\nu)\times\mathbf m\right]=\mathbf0.
```

The native FEM path currently realizes the volume energy variation and its projected field. The
boundary term is part of the physical model and validation contract; a separate explicit DMI
boundary integrator must not be added on top of the same weak residual without proving that it is
not double-counting.

## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | physical magnetization $M_s\mathbf m$ | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf v$ | admissible variation/test field | $1$ |
| $\hat{\mathbf n}$ | normalized interface normal | $1$ |
| $\boldsymbol\nu$ | outward magnetic-boundary normal | $1$ |
| $D$ | interfacial DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $A$ | exchange stiffness in the coupled boundary law | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $G_{ab}$ | gradient component $\partial_bm_a$ | $\mathrm{m^{-1}}$ |
| $m_n$ | projection $\mathbf m\cdot\hat{\mathbf n}$ | $1$ |
| $w_{\mathrm i}$ | local iDMI energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm i}$ | total iDMI energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm i}$ | iDMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM lumped nodal integration weight | $\mathrm{m^3}$ |
| $g_i$ | assembled FEM residual at node $i$ | $\mathrm{J}$ |
| $i$ | discrete cell or node index | $1$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell sizes | $\mathrm{m}$ |
| $\partial_a$ | derivative with respect to coordinate $x_a$ | $\mathrm{m^{-1}}$ |
| $I$ | three-dimensional identity tensor | $1$ |

## Assumptions and validity

- `D` is an SI surface-energy coefficient in $\mathrm{J\,m^{-2}}$. It is not an exchange
  stiffness and must not be entered in $\mathrm{J\,m^{-1}}$ or $\mathrm{J\,m^{-3}}$.
- The reduced magnetization is expected to satisfy the surrounding LLG normalization contract.
- `M_s` is finite and positive. The field scales as $1/M_s$ while the energy density does not
  contain an extra hidden $\mu_0$ factor.
- The public vector is checked for length three and finite components. FEM normalizes every active
  non-zero normal. FDM accepts only a vector equivalent to the canonical $+\hat{\mathbf z}$ axis;
  it rejects other normals rather than silently rotating a stencil.
- A missing `interface_normal` resolves to $(0,0,1)$ in FEM and is the only executable FDM
  orientation.
- FDM is a cell-centered Cartesian approximation. The CPU reference derives its boundary
  contribution from oriented active-face energy and applies the resulting natural-boundary
  correction at non-periodic or inactive neighbors. The CUDA lane retains its own centered
  stencil contract until executed-device parity is qualified.
- FEM uses the weak residual over magnetic elements, quadrature evaluation, and lumped-mass field
  projection. It is not the same discrete operator as the FDM stencil.
- A material `Dind_field` is a FEM-resolved nodal coefficient field. Its length and finite values
  are validated downstream against the resolved mesh; it is not an arbitrary list of coefficients.

## Solver and backend realizations

| Solver | Device | Status | Realization and qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | Double-precision centered interior stencil plus oriented active-face energy, axis-aligned natural-boundary corrections, and cell-volume observables. |
| FDM | GPU | implemented | FP64 and FP32 CUDA effective-field kernels plus FP64/FP32-compatible scalar reduction; executed-device parity remains a separate gate. |
| FEM | CPU | implemented | MFEM element/quadrature weak residual, optional nodal `Dind_field`, lumped-mass projection, and energy accumulation. |
| FEM | GPU | implemented | Device tetrahedral weak-residual kernel, device field buffers, and final DMI energy reduction; device execution and parity require runtime evidence. |

The common physics is shared, but interface-normal legality, derivative stencil, coefficient
location, precision, boundary handling, and field recovery differ materially and are documented
below.

## Python API and canonical ProblemIR

The complete copyable constructor/API reference is in
{doc}`../../../python-api/interactions/interfacial-dmi`. In summary, the explicit term lowers to
one `energy_terms` entry; material-owned `Dind` lowers to `materials[].interfacial_dmi`, and FEM
planning may materialize `materials[].dind_field`.

## ProblemIR

The explicit term is serialized as:

```json
{
  "kind": "interfacial_dmi",
  "D": 0.003,
  "interface_normal": [0.0, 0.0, 1.0]
}
```

When the optional normal is omitted, the key is absent in Python IR and the FEM planner resolves
the native normal to $+\hat{\mathbf z}$. A material-owned coefficient is serialized separately:

```json
{
  "interfacial_dmi": 0.003,
  "dind_field": null
}
```

The explicit term and the material fallback are not summed. The planner resolves one scalar
coefficient for the selected material/backend and records requested intent separately from
resolved solver, device, precision, normalized normal, coefficient location, and output policy.

## Round-trip and failure semantics

Canonical script export preserves `InterfacialDMI(D=..., interface_normal=...)` when the user
authored an explicit term, and preserves `Material(Dind=..., Dind_field=...)` for material-owned
semantics. It must not invent a rotated FDM normal or silently turn an unsupported material field
into a scalar.

Validation errors include non-finite `D`, malformed or non-finite normals, zero FEM normals,
non-`+z` FDM normals, duplicate iDMI terms, invalid `Dind_field` cardinality/values, missing FEM
mesh data, missing MFEM context, and missing GPU-resident DMI buffers. Unsupported combinations
are planner/runtime errors; no CPU fallback is implied by a GPU source path.

## Discrete realization

### FDM CPU

The CPU reference evaluates the $+\hat{\mathbf z}$ form at active cell $i$ with centered
differences in the interior. Its energy is defined on oriented active faces; for an x-face
between active cells $L$ and $R$,

```{math}
:label: eq-interfacial-dmi-fdm-field
\mathbf H_{\mathrm i,i}^{\mathrm{int}}
=\frac{2D}{\mu_0M_{s,i}}
\begin{bmatrix}
\delta_xm_z\\
\delta_ym_z\\
-(\delta_xm_x+\delta_ym_y)
\end{bmatrix}_i,
\qquad
E_{\mathrm i}^{\mathrm{FDM}}
=\sum_{f\in\mathcal F_x^{\mathrm{act}}}D S_x
\left[\bar m_z\,\Delta_xm_x-\bar m_x\,\Delta_xm_z\right]_f
+\sum_{f\in\mathcal F_y^{\mathrm{act}}}D S_y
\left[\bar m_z\,\Delta_ym_y-\bar m_y\,\Delta_ym_z\right]_f.
```

Here $\delta_x$ and $\delta_y$ use $1/(2\Delta x)$ and $1/(2\Delta y)$, while
$\Delta_a m=m_R-m_L$ and $S_a$ is the face area. Periodic axes wrap neighbors and contribute
oriented periodic faces. An inactive or non-periodic missing neighbor contributes no face energy;
the CPU field adds the analytic variation of that missing face so that the discrete field and
energy satisfy the same directional derivative. This is the axis-aligned natural-boundary
realization for allocating and in-place AoS and SoA paths. Inactive cells return zero field and do
not contribute to energy.

### FDM GPU

The FP64 and FP32 `combine_effective_field` kernels retain the local centered-difference
calculation in the fused effective-field path. They compute neighbor indices from periodic flags,
clamp inactive neighbors to the current cell, and add the result to the effective field. The CUDA
reduction kernel independently evaluates its centered density and multiplies by cell volume before
block reduction. This CUDA closure is a separate qualification target; it must not be presented as
the CPU face-energy natural-boundary realization. FP32 changes arithmetic precision, not the
requested physical coefficient or CUDA stencil. A compiled kernel is not evidence of executed-device
parity.

### FEM CPU

The FEM CPU implementation evaluates the general-normal density at quadrature points. For each
element it interpolates $\mathbf m_q$ and $\nabla\mathbf m_q$, averages a nodal `Dind_field` when
present, and accumulates

```{math}
:label: eq-interfacial-dmi-fem-residual
R_{\mathrm i,h}(\mathbf m_h;\mathbf v_h)
=\sum_{e,q}w_{e,q}\left[
\frac{\partial w_{\mathrm i}}{\partial\mathbf m}\cdot\mathbf v_h
+\frac{\partial w_{\mathrm i}}{\partial\nabla\mathbf m}:\nabla\mathbf v_h
\right]_{e,q}.
```

The projected field is recovered by

```{math}
:label: eq-interfacial-dmi-fem-projection
\mathbf H_{\mathrm i,h,i}
=-\frac{\mathbf g_{\mathrm i,h,i}}
{\mu_0M_{s,i}w_i^{\mathrm{lump}}}.
```

The implementation fails closed when the MFEM context, finite-element space, mesh, or lumped
mass is unavailable. The reported FEM energy is the quadrature sum of $w_{\mathrm i}$; it is not
recomputed from a separately projected field.

### FEM GPU

The CUDA tetrahedral kernel computes element gradients, volume, quadrature magnetization, and the
same general-normal residual. It averages `Dind_field` over the four tetrahedral nodes when a field
is supplied, atomically accumulates residual components and energy, then the RK layer projects and
reduces the device result using device-resident `M_s`, lumped mass, mesh geometry, and buffers.
Missing device resources are explicit errors. The final energy path has separate interfacial and
bulk dispatch flags; it does not merge the two physical terms into one undocumented coefficient.

### Observables

| Observable | Kind | SI unit | Meaning |
|---|---|---|---|
| `H_dmi` | vector field | $\mathrm{A\,m^{-1}}$ | total DMI field surface exposed by the runtime; isolate iDMI in backend diagnostics where available |
| `H_DMI` | vector field | $\mathrm{A\,m^{-1}}$ | FEM interfacial DMI projected field |
| `E_dmi` | scalar | $\mathrm{J}$ | iDMI contribution when bulk DMI is disabled or reported separately |
| `eden_dmi` | spatial scalar | $\mathrm{J\,m^{-3}}$ | local iDMI density materialization |

## Implementation mapping

The adjacent `interfacial.source-map.json` binds every equation and nontrivial claim to a stable
path-plus-symbol identity. The ownership split is:

- `InterfacialDMI` and `Material` define public authoring and serialization;
- `plan_fdm` rejects non-`+z` normals and resolves the scalar term;
- `plan_fem` normalizes the normal, imports material coefficients, and resolves fields;
- FDM CPU owns the centered interior field, active-face energy, and natural-boundary correction;
- FDM CUDA owns FP64/FP32 fused fields and reductions;
- FEM CPU owns the MFEM weak residual, projection, and energy;
- FEM CUDA owns device residual, field dispatch, and final energy reduction.

Use stable symbols rather than handwritten line ranges; generated line links may be derived from
the immutable revision during publication.

## Validation and qualification

The minimum analytical checks are:

- uniform $\mathbf m$ gives zero volume iDMI field and zero volume density;
- a linear $m_z(x,y)$ profile reproduces the two transverse field components and their sign;
- reversing $D$ reverses $\mathbf H_{\mathrm i}$ and $E_{\mathrm i}$;
- reflecting a domain-wall profile changes the chiral energy sign as predicted by the convention;
- for FEM, the projected field action satisfies
  $-\mu_0\sum_iM_{s,i}w_i^{\mathrm{lump}}\mathbf H_i\cdot\mathbf v_i=R_{\mathrm i,h}(\mathbf m;\mathbf v)$;
- finite differences of FEM energy match the same residual action;
- a tilted nonzero FEM normal changes the field according to the normalized requested direction;
- a non-`+z` FDM normal is rejected rather than silently accepted.

Cross-lane qualification must compare identical material state, mesh/grid, $D$, normal, boundary
policy, and precision. Source contracts and static tests do not prove executed GPU parity; GPU
claims require device identity, executed kernels, and a documented tolerance.

## Limitations and deferred work

- FDM currently supports only the canonical `+z` interface normal.
- Arbitrary spatial interface-normal fields, curved-surface geometric DMI, tensor DMI, and
  region-interface coupling are not public iDMI semantics.
- FDM material `Dind_field` is not a supported native scalar-field realization in the current
  planner; use an explicit `InterfacialDMI` term for the FDM lane.
- FEM uses element-averaged nodal `Dind_field` in the native residual; a higher-order coefficient
  quadrature contract is deferred.
- Consistent-mass FEM field projection and a fully libCEED-specific production QFunction remain
  separate qualification targets.
- The coupled exchange+iDMI natural boundary law is documented physically; explicit user-selectable
  non-natural boundary operators remain outside this interaction page.

## Scientific bibliography

- Rohart, S. and Thiaville, A., “ skyrmion stability, and dynamics in ultrathin magnetic films,”
  *Physical Review B* **88**, 184422 (2013), DOI: `10.1103/PhysRevB.88.184422`.
- Bogdanov, A. N. and Rößler, U. K., “Chiral symmetry breaking in magnetic thin films and
  multilayers,” *Physical Review Letters* **87**, 037203 (2001), DOI: `10.1103/PhysRevLett.87.037203`.
- FullMag physical implementation notes: `docs/physics/0440-fdm-interfacial-dmi.md`,
  `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`, and
  `docs/physics/0813-native-fem-dmi-weak-residual.md`.

## Source-code index

| Claim/equation | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python term and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | public constructor and `interfacial_dmi` term serialization | Python |
| Material fallback | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | `Dind` and `Dind_field` serialization | Python/FEM |
| Vector validation | `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | length and finite vector validation | Python |
| FDM legality | `crates/fullmag-plan/src/fdm.rs` | `fdm_supports_interfacial_dmi_normal` | canonical `+z` normal check | FDM CPU/GPU |
| FDM plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | scalar term resolution and duplicate/unsupported checks | FDM |
| FEM normal | `crates/fullmag-plan/src/fem.rs` | `resolve_interfacial_dmi_normal` | default and normalization of active normal | FEM |
| FEM material fields | `crates/fullmag-plan/src/fem.rs` | `build_region_material_fields` | resolved `Dind_field` material realization | FEM |
| FDM CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `interfacial_dmi_field` | allocating centered-interior field plus face-boundary correction | FDM CPU |
| FDM CPU energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `dmi_energy_from_soa` | oriented active-face iDMI energy | FDM CPU |
| FDM FP64 field | `backends/fdm/gpu/cuda/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused FP64 iDMI field | FDM GPU |
| FDM FP32 field | `backends/fdm/gpu/cuda/demag_fp32.cu` | `combine_effective_field_fp32_kernel` | fused FP32 iDMI field | FDM GPU |
| FDM GPU energy | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `dmi_energy_blocks_kernel` | FP64/FP32 templated scalar density reduction | FDM GPU |
| FEM CPU residual | `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp` | `compute_interfacial_dmi_field` | quadrature residual, projection, and energy | FEM CPU |
| FEM residual helper | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_interfacial_residual` | first-variation component action | FEM CPU/GPU contract |
| FEM GPU residual | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | tetrahedral device residual and energy | FEM GPU |
| FEM GPU field dispatch | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` | `gpu_rk_compute_dmi_field_contributions` | device-resident interfacial field launch | FEM GPU |
| FEM GPU energy | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu` | `gpu_rk_reduce_final_dmi_energy_terms` | final interfacial energy reduction | FEM GPU |
