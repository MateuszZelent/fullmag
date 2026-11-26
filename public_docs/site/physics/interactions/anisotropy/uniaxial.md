---
title: Uniaxial anisotropy
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0402-uniaxial-anisotropy.md
---

(public-docs-physics-interactions-anisotropy-uniaxial)=
# Uniaxial magnetocrystalline anisotropy

Uniaxial anisotropy assigns an energetically preferred direction to the reduced magnetization.
FullMag implements first- and second-order constants, `Ku1` and `Ku2`, and an easy-axis vector.
The canonical physical model is shared by FDM and FEM; the storage, interpolation, masking,
precision, and reduction paths are documented separately below.

The public compatibility object `fullmag.UniaxialAnisotropy` is not a second native interaction
owner. Before canonical lowering, it is migrated to the target material's `Ku1`, `Ku2`, and
`anisU` fields. The full constructor, migration, validation, and copyable API examples are in
{doc}`../../../python-api/interactions/uniaxial-anisotropy`.

:::{admonition} Energy convention and $\sin^2/\sin^4 \to \cos^2/\cos^4$ parameter transform
:class: note

FullMag implements $w_{\mathrm u} = -K_{u1}q^2 - K_{u2}q^4$ with $q = \mathbf m\cdot\mathbf u = \cos\theta$.
When translating parameters $(\tilde K_{u1}, \tilde K_{u2})$ published in the angular convention
$\tilde w_{\mathrm u} = \tilde K_{u1}\sin^2\theta + \tilde K_{u2}\sin^4\theta = \tilde K_{u1}(1-q^2) + \tilde K_{u2}(1-q^2)^2$,
expanding $(1-q^2)^2 = 1 - 2q^2 + q^4$ yields the exact parameter mapping:

$$K_{u1} = \tilde K_{u1} + 2\tilde K_{u2}, \qquad K_{u2} = -\tilde K_{u2},$$

while the two energy densities differ by the angle-independent constant offset
$\tilde w_{\mathrm u} - w_{\mathrm u} = \tilde K_{u1} + \tilde K_{u2}$. With this mapping,
the effective field $\mathbf H_{\mathrm u}$ and all equilibrium angles are identical.
:::

## Solver and backend realizations

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Per-cell normalized-axis field (`fields/anisotropy.rs`), active-cell masking, and cell-volume energy integration (`fields/energy.rs`) in double precision. |
| FDM | GPU | implemented | FP64/FP32 anisotropy field kernels and scalar reductions; multilayer CUDA has a layer-local dispatch. |
| FEM | CPU | implemented | Nodal field and lumped energy, with saturation-weighted element quadrature for spatial material fields. |
| FEM | GPU | implemented | Device-resident `template <bool ComputeEnergy>` field/energy block kernels (`anisotropy_kernels.cu`, skipping energy reduction on intermediate RK stages) and single-launch fused `H_eff` accumulation (`fullmag_cuda_accumulate_heff_fused_xyz`); qualified on RTX 4080 SUPER. |

Implementation status is not equivalent to qualification for every precision, mesh, material-field
shape, or device. Resolved provenance must retain requested constants and axis, normalized axis,
resolved scalar/spatial material data, solver, device, precision, and output legality.

(uniaxial-problem-statement)=
## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf m=\mathbf M/M_s$ the reduced magnetization,
$\mathbf u$ the normalized easy-axis direction, and

```{math}
:label: eq-uniaxial-projection
q(\mathbf x)=\mathbf m(\mathbf x)\cdot\mathbf u(\mathbf x).
```

The signs and ratio of $K_{u1}$ and $K_{u2}$ partition equilibrium anisotropy landscapes into
three regimes:

- **Easy axis** ($q = \pm 1$): favored when $K_{u1} + 2K_{u2} > 0$ and $K_{u1} + K_{u2} > 0$
  (in particular $K_{u1} > 0$ with $K_{u2} \ge 0$).
- **Easy plane** ($q = 0$): favored when $K_{u1} < 0$ and $K_{u1} + K_{u2} < 0$.
- **Easy cone** ($0 < \lvert q\rvert < 1$): minimizing $w_{\mathrm u}(q) = -K_{u1}q^2 - K_{u2}q^4$
  gives $\mathrm dw_{\mathrm u}/\mathrm dq = -2q(K_{u1}+2K_{u2}q^2)=0$ and
  $\mathrm d^2w_{\mathrm u}/\mathrm dq^2\big|_{q_c} = 4K_{u1}$, so a strict easy-cone minimum
  exists if and only if $K_{u2} < 0$ and $0 < K_{u1} < -2K_{u2}$, at equilibrium polar angle

```{math}
:label: eq-uniaxial-easy-cone
\theta_c = \arccos\sqrt{-\frac{K_{u1}}{2K_{u2}}},
\qquad
K_{u2} < 0 \;\land\; 0 < K_{u1} < -2K_{u2}.
```

`Ku2` is never silently absorbed into `Ku1`.

(uniaxial-governing-equations)=
## Governing equations

The exact implemented continuum density and total energy are

```{math}
:label: eq-uniaxial-energy-density
w_{\mathrm u}(\mathbf x)
=
-K_{u1}(\mathbf x)\,q(\mathbf x)^2
-K_{u2}(\mathbf x)\,q(\mathbf x)^4,
\qquad
E_{\mathrm u}[\mathbf m]
=
\int_{\Omega_m}w_{\mathrm u}(\mathbf x)\,\mathrm dV.
```

With positive $M_s$, the effective field obtained from the FullMag convention is

```{math}
:label: eq-uniaxial-effective-field
\mathbf H_{\mathrm u}
=
-\frac{1}{\mu_0M_s}\frac{\delta E_{\mathrm u}}{\delta\mathbf m}
=
\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\,\mathbf u.
```

For an admissible variation $\boldsymbol\eta$, the directional derivative is

```{math}
:label: eq-uniaxial-directional-derivative
\delta E_{\mathrm u}[\mathbf m;\boldsymbol\eta]
=
-\int_{\Omega_m}
\left(2K_{u1}q+4K_{u2}q^3\right)
\left(\boldsymbol\eta\cdot\mathbf u\right)\,\mathrm dV
=
-\mu_0\int_{\Omega_m}M_s\mathbf H_{\mathrm u}\cdot\boldsymbol\eta\,\mathrm dV.
```

The field is parallel to the local easy axis. It is not a demagnetizing field, does not require a
Poisson solve, and has no boundary condition of its own. The LLG torque and magnetization
normalization are owned by the dynamics contract.

```{figure} /_static/diagrams/anisotropy-uniaxial-and-cubic-landscapes.svg
:alt: Two-panel anisotropy diagram highlighting panel (a) for Fullmag's uniaxial energy density -Ku1 q^2 - Ku2 q^4 across easy-axis, easy-plane, and easy-cone regimes, together with the constant energy offset against K_u1 sin^2(theta) forms and identical effective field H_u, alongside cubic landscapes in panel (b).
:width: 100%
:name: fig-uniaxial-anisotropy-landscape
:figclass: fm-physics-figure

Panel (a) shows Fullmag's uniaxial anisotropy regimes (easy axis, easy plane, and easy cone) and the constant energy offset against $\sin^2\theta$ conventions while keeping $\mathbf H_{\mathrm u}$ unchanged (Stoner & Wohlfarth 1948; Collings et al. 2023).
```

(uniaxial-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\mathbf u$ | normalized uniaxial easy-axis direction | $1$ |
| $q$ | projection $\mathbf m\cdot\mathbf u$ | $1$ |
| $\theta_c$ | equilibrium easy-cone polar angle | $\mathrm{rad}$ |
| $K_{u1}$ | first-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{u2}$ | second-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf H_{\mathrm u}$ | uniaxial anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| $w_{\mathrm u}$ | local uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm u}$ | total uniaxial anisotropy energy | $\mathrm{J}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\boldsymbol\eta$ | admissible reduced-magnetization variation | $1$ |
| $i$ | discrete cell or node index | $1$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM nodal lumped integration weight | $\mathrm{m^3}$ |

(uniaxial-assumptions-and-validity)=
## Assumptions and validity

- `Ku1` and `Ku2` are SI energy-density constants in $\mathrm{J\,m^{-3}}$. They are not exchange stiffnesses
  and are not supplied in $\mathrm{J\,m^{-1}}$.
- The configured axis is required to be a finite non-zero direction for an active realization.
  Native paths normalize it; the stored public tuple is not silently treated as unit length.
- The reduced magnetization is expected to satisfy the surrounding dynamics normalization contract.
- `Ms` must be finite and positive. The field scales as $1/M_s$; the energy does not contain an
  additional hidden $\mu_0$ factor.
- Spatial `Ku_field` and `Ku2_field` override scalar material values only where the corresponding
  backend supports their cardinality and interpolation. They are not arbitrary-length arrays.
- The absolute energy uses the negative-power convention stated above. Comparing to a
  $\sin^2\theta / \sin^4\theta$ publication convention requires applying
  $K_{u1} = \tilde K_{u1} + 2\tilde K_{u2}$, $K_{u2} = -\tilde K_{u2}$, and accounting for the
  constant offset $\tilde K_{u1} + \tilde K_{u2}$.

(uniaxial-python-api)=
## Python authoring and canonical ProblemIR

The interaction-facing parameter matrix is:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `UniaxialAnisotropy.ku1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy` |
| `UniaxialAnisotropy.ku2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy_k2` |
| `UniaxialAnisotropy.axis` | `Sequence[float]` | `(0,0,1)` | $1$ | length 3; finite; non-zero when active | easy-axis direction, normalized by native realization | FDM/FEM CPU/GPU | `materials[].anisotropy_axis` |
| `Material.Ku1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first-order material value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second-order material value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite; non-zero when active | canonical easy-axis direction | FDM/FEM CPU/GPU | `materials[].anisotropy_axis` |
| `Material.Ku_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; mesh cardinality validated downstream | spatial Ku1 override | FEM and allocating FDM reference paths where supported | `materials[].ku_field` |
| `Material.Ku2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; mesh cardinality validated downstream | spatial Ku2 override | FEM and allocating FDM reference paths where supported | `materials[].ku2_field` |

```python
# %% Copyable Python/Jupyter stage workflow with Ku1 and Ku2 on MagnetHandle
import fullmag as fm

nm = 1.0e-9
study = fm.study("uniaxial-anisotropy")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.01
body.Ku1 = 0.5e6
body.Ku2 = 0.05e6
body.anisU = (0.0, 0.0, 1.0)
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=1.0e-6,
)
```

The stage-first handle (`MagnetHandle` in `packages/fullmag-py/src/fullmag/world.py`) exposes
`body.Ku1`, `body.Ku2`, and `body.anisU` directly; spatial `Ku_field` and `Ku2_field` arrays
belong to `fm.Material(...)`. The compatibility constructor `fm.UniaxialAnisotropy` is migrated
to canonical material fields before lowering.

The compatibility object is requested intent. The resolved IR is material-owned. Supplying both
conflicting legacy values and existing `Material` values raises a validation error rather than
silently choosing one.

(uniaxial-problem-ir)=
## ProblemIR and planner contract

The canonical material fragment is:

```json
{
  "uniaxial_anisotropy": 500000.0,
  "uniaxial_anisotropy_k2": 50000.0,
  "anisotropy_axis": [0.0, 0.0, 1.0]
}
```

FDM and FEM planners copy the material values into their native plan structures. FEM additionally
promotes heterogeneous region values to resolved fields and validates an active axis. A planner
may reject unsupported material-field shape or incompatible multi-region semantics; it must not
drop the anisotropy while reporting a successful resolved execution.

(uniaxial-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Canonical export preserves requested intent in the source model and material IR. Resolved
execution must additionally record normalized axis, scalar versus spatial coefficient realization,
solver, device, precision, and output decisions.

Validation errors include malformed vectors, non-finite constants, a zero active axis, conflicting
legacy and material values, incompatible region material promotion, and unsupported output requests.
Unsupported combinations are planner errors, not silent fallbacks.

(uniaxial-discrete-realization)=
## Discrete realization

### FDM CPU

For active cell $i$, the CPU reference (`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`
and `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`) uses the normalized cell axis
$\mathbf u_i$ and computes

```{math}
:label: eq-uniaxial-fdm-field
\mathbf H_{\mathrm u,i}
=
\frac{2K_{u1,i}q_i+4K_{u2,i}q_i^3}{\mu_0M_{s,i}}\,\mathbf u_i,
\qquad
E_{\mathrm u}^{\mathrm{FDM}}
=
\sum_i\left(-K_{u1,i}q_i^2-K_{u2,i}q_i^4\right)V_i.
```

Inactive cells produce zero field and zero energy. The field is added componentwise to `H_eff`.

### FDM GPU

Standard CUDA kernels implement the same local projection in FP64 and FP32. The scalar energy
reduction is a separate kernel path. Multilayer execution uses the layer-local anisotropy kernel
and dispatches by precision. GPU source presence does not establish executed-device qualification;
parity requires matching cell/material state and a declared precision tolerance.

### FEM CPU

The CPU path evaluates the nodal field using normalized axes and `Ms`, `Ku1`, and `Ku2` scalar or
spatial values. With lumped weights, the discrete energy is

```{math}
:label: eq-uniaxial-fem-lumped
E_{\mathrm u}^{\mathrm{FEM,lump}}
=
\sum_i\left(-K_{u1,i}q_i^2-K_{u2,i}q_i^4\right)w_i^{\mathrm{lump}}.
```

For spatial element material fields, the element-quadrature material path evaluates the same
polynomial under the element mass integration. Non-magnetic nodes are excluded.

### FEM GPU

The GPU lane requires device-resident `Ms`, `Ku`, `Ku2`, axis components, lumped mass, and
anisotropy buffers. `uniaxial_anisotropy_field_energy_blocks_kernel<ComputeEnergy>` gates
per-block `cub::BlockReduce` energy reductions on `block_sums != nullptr`: intermediate RK stages
pass `nullptr` to skip dead energy reductions while accepted steps emit block sums for the final
reduction, and `fullmag_cuda_accumulate_heff_fused_xyz` folds `h_ani` into `H_eff` in a single
order-preserving launch (`17.5×` faster than the legacy multi-launch path, verified on RTX 4080
SUPER with `fem_cuda_shortrange_kernels_contract`, `compute-sanitizer` 0 errors, and
`ΔE_ani = 0.0` over 50 RK4 steps). See {ref}`numerical-methods-performance-fem-gpu-kernels`.
Missing buffers are fail-closed runtime errors; no CPU fallback is implied.

### Observables

| Observable | Kind | SI unit | Availability |
|---|---|---|---|
| `H_ani` | vector field | $\mathrm{A\,m^{-1}}$ | Active uniaxial anisotropy and materializable field path. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and materializable energy path. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and materializable spatial-energy path. |

(uniaxial-implementation-mapping)=
## Implementation mapping

Responsibilities are split across Python authoring, planning, and native kernels:

- Python `MagnetHandle`, `UniaxialAnisotropy`, and `_migrate_legacy_anisotropy_energy_terms` own public authoring and migration.
- `Material` owns canonical values and serialization.
- `plan_fdm` and `plan_fem` own native resolution and legality.
- FDM CPU (`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`, `energy.rs`) owns local projection and energy density.
- FDM CUDA owns precision-specific kernels and reductions.
- FEM CPU owns nodal/quadrature field and energy evaluation.
- FEM CUDA owns template-gated device field/energy kernels, final reductions, and fused `H_eff` composition.

Refer to the symbol entries in the source-code index below when locating the current implementation across Python, planner, and backend kernels.

(uniaxial-validation)=
## Validation and qualification

For $\mathbf m=\mathbf u$, verify $q=1$ and
$\mathbf H_{\mathrm u}=(2K_{u1}+4K_{u2})\mathbf u/(\mu_0M_s)$. For $\mathbf m\perp\mathbf u$,
verify zero field and zero FullMag density. Verify the easy-cone stationary angle
$\theta_c = \arccos\sqrt{-K_{u1}/(2K_{u2})}$ when $K_{u2} < 0$ and $0 < K_{u1} < -2K_{u2}$, and
verify the $\sin^2/\sin^4$ parameter mapping against shifted energy baselines. Reverse `Ku1` and
verify easy-axis versus easy-plane behavior. Compare finite differences of the reported energy
with the analytic field.

Repeat with scalar and spatial coefficients on FDM CPU, qualified CUDA, FEM CPU, and FEM CUDA.
On FEM GPU (RTX 4080 SUPER, SM `89-real`), `fem_cuda_shortrange_kernels_contract` verifies
bitwise field equality (`memcmp == 0`) between `ComputeEnergy=true` and `ComputeEnergy=false`
with 0 `compute-sanitizer` errors and `ΔE_ani = 0.0` across 50 RK4 steps.

(uniaxial-limitations)=
## Limitations and deferred work

- Public axis fields are material-level vectors; arbitrary public per-node axis fields are not part
  of this contract.
- The compatibility energy object is restricted to a single material target during migration.
- The absolute energy convention intentionally retains the implementation's constant offset.
- FDM GPU production qualification remains dependent on current executed-device evidence.

(uniaxial-scientific-bibliography)=
## Scientific bibliography

1. E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948). [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
2. J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023). [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [Open-access PDF (White Rose)](https://eprints.whiterose.ac.uk/id/eprint/197787/1/PhysRevB.107.064413.pdf) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
3. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers / Wiley, New York (1963). [WorldCat record](https://search.worldcat.org/title/536451).

(uniaxial-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L512) | [`class UniaxialAnisotropy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L512) | Compatibility constructor and legacy term lowering. |
| [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | [`class Material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | Canonical Ku1/Ku2/axis/spatial-field contract. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | [`class MagnetHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | Stage-first direct `Ku1`, `Ku2`, and `anisU` authoring. |
| [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2197) | [`_migrate_legacy_anisotropy_energy_terms`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2197) | Migration and conflict semantics. |
| [`crates/fullmag-plan/src/fdm.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | [`plan_fdm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | FDM native material resolution. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | [`plan_fem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | FEM native material resolution and validation. |
| [`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | [`anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | FDM CPU field realization. |
| [`crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | [`anisotropy_energy_density_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | FDM CPU energy-density realization. |
| [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | [`anisotropy_field_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | Standard FDM CUDA FP64 local anisotropy field. |
| [`backends/fdm/gpu/cuda/interactions/demag_fp32.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L546) | [`anisotropy_field_fp32_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L546) | Standard FDM CUDA FP32 local anisotropy field. |
| [`backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu#L23) | [`multilayer_anisotropy_field_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu#L23) | Multilayer FDM CUDA local anisotropy field. |
| [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L1476) | [`reduce_uniaxial_anisotropy_energy_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L1476) | FDM CUDA FP64 energy reduction. |
| [`backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L167) | [`compute_uniaxial_anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L167) | FEM CPU field and lumped energy. |
| [`backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L231) | [`uniaxial_anisotropy_energy_from_element_quadrature_material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L231) | FEM CPU spatial-material energy. |
| [`backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L14) | [`uniaxial_anisotropy_field_energy_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L14) | FEM CUDA template-gated local field/energy blocks. |
| [`backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu#L38) | [`gpu_rk_compute_anisotropy_field_contributions`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu#L38) | FEM CUDA RK field dispatch and fail-closed checks. |
| [`backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu#L41) | [`gpu_rk_reduce_final_anisotropy_energy_terms`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu#L41) | FEM CUDA final energy reduction. |
| [`backends/fem/gpu/cuda/fields/vector_field_kernels.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | [`fullmag_cuda_accumulate_heff_fused_xyz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | FEM CUDA single-launch fused `H_eff` composition. |
