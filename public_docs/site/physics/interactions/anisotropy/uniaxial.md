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

:::{admonition} Energy convention used by FullMag
:class: note

FullMag reports the implemented density $-K_{u1}q^2-K_{u2}q^4$. Many publications write the
equivalent angular form $K_{u1}(1-q^2)+K_{u2}(1-q^4)$. The two differ by the constant
$K_{u1}+K_{u2}$, so their effective fields are identical but their absolute reported energies
are not. This page and the source code use the FullMag convention.
:::

## Solver and backend realizations

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Per-cell normalized-axis field, active-cell masking, and cell-volume energy integration in double precision. |
| FDM | GPU | implemented | FP64/FP32 anisotropy field kernels and scalar reductions; multilayer CUDA has a layer-local dispatch. |
| FEM | CPU | implemented | Nodal field and lumped energy, with saturation-weighted element quadrature for spatial material fields. |
| FEM | GPU | implemented | Device-resident field/energy block kernels and final reductions; executed-device parity remains a qualification gate. |

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

The sign of `Ku1` has a physical meaning: positive `Ku1` favors $|q|=1$ (alignment with the
axis), while negative `Ku1` favors $q=0$ (the plane normal to the axis). `Ku2` adds a fourth-power
angular contribution and is not silently absorbed into `Ku1`.

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

(uniaxial-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\mathbf u$ | normalized uniaxial easy-axis direction | $1$ |
| $q$ | projection $\mathbf m\cdot\mathbf u$ | $1$ |
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

- `Ku1` and `Ku2` are SI energy-density constants in J/m^3. They are not exchange stiffnesses
  and are not supplied in J/m.
- The configured axis is required to be a finite non-zero direction for an active realization.
  Native paths normalize it; the stored public tuple is not silently treated as unit length.
- The reduced magnetization is expected to satisfy the surrounding dynamics normalization contract.
- `Ms` must be finite and positive. The field scales as $1/M_s$; the energy does not contain an
  additional hidden $\mu_0$ factor.
- Spatial `Ku_field` and `Ku2_field` override scalar material values only where the corresponding
  backend supports their cardinality and interpolation. They are not arbitrary-length arrays.
- The absolute energy uses the negative-power convention stated above. Comparing to a shifted
  publication convention requires adding the known constant before claiming equality.

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
# %% Copyable Python/Jupyter stage workflow
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
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=1.0e-6,
)
```

The anisotropy values belong to the material/geometry handle and the stage pipeline is the
executable user workflow. The compatibility constructor is documented separately as a lowering
inspection fixture, not as a way to launch a simulation.

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

For active cell $i$, the CPU reference uses the normalized cell axis $\mathbf u_i$ and computes

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
anisotropy buffers. The field kernel writes the local contribution and the energy kernel produces
block sums before a device reduction. Missing buffers are fail-closed runtime errors. No CPU
fallback is implied by the presence of a host reference implementation.

### Observables

| Observable | Kind | SI unit | Availability |
|---|---|---|---|
| `H_ani` | vector field | $\mathrm{A\,m^{-1}}$ | Active uniaxial anisotropy and materializable field path. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and materializable energy path. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and materializable spatial-energy path. |

(uniaxial-implementation-mapping)=
## Implementation mapping

The adjacent `uniaxial.source-map.json` records stable path-plus-symbol citations. Ownership is
split deliberately:

- Python `UniaxialAnisotropy` and `_migrate_legacy_anisotropy_energy_terms` own public migration.
- `Material` owns canonical values and serialization.
- `plan_fdm` and `plan_fem` own native resolution and legality.
- FDM CPU owns local projection and energy density.
- FDM CUDA owns precision-specific kernels and reductions.
- FEM CPU owns nodal/quadrature field and energy evaluation.
- FEM CUDA owns device field/energy kernels and reductions.

Line numbers are intentionally not the citation identity because source edits move them. Use the
stable symbol and inspect the current line range when reviewing a particular revision.

(uniaxial-validation)=
## Validation and qualification

For $\mathbf m=\mathbf u$, verify $q=1$ and
$\mathbf H_{\mathrm u}=(2K_{u1}+4K_{u2})\mathbf u/(\mu_0M_s)$. For $\mathbf m\perp\mathbf u$,
verify zero field and zero FullMag density. Reverse `Ku1` and verify the easy-axis/easy-plane
behavior. Compare finite differences of the reported energy with the analytic field.

Repeat with scalar and spatial coefficients on FDM CPU, qualified CUDA, FEM CPU, and FEM CUDA.
Compare `H_ani`, `E_ani`, and `eden_ani`; report precision and reduction order. Source or static
contract tests alone do not prove executed-device parity.

(uniaxial-limitations)=
## Limitations and deferred work

- Public axis fields are material-level vectors; arbitrary public per-node axis fields are not part
  of this contract.
- The compatibility energy object is restricted to a single material target during migration.
- The absolute energy convention intentionally retains the implementation's constant offset.
- GPU production qualification remains dependent on current executed-device evidence.

(uniaxial-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag internal source of truth: `docs/physics/0402-uniaxial-anisotropy.md`.
- FullMag material and compatibility implementation: `packages/fullmag-py/src/fullmag/model/structure.py` and `packages/fullmag-py/src/fullmag/model/energy.py`.

(uniaxial-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class UniaxialAnisotropy` | Compatibility constructor and legacy term lowering. |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical Ku1/Ku2/axis/spatial-field contract. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `_migrate_legacy_anisotropy_energy_terms` | Migration and conflict semantics. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `to_ir` | Canonical ProblemIR construction. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM native material resolution. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM native material resolution and validation. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `anisotropy_field` | FDM CPU field realization. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `anisotropy_energy_density_from_vectors` | FDM CPU energy-density realization. |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `anisotropy_field_fp64_kernel` | Standard FDM CUDA FP64 local anisotropy field. |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `anisotropy_field_fp32_kernel` | Standard FDM CUDA FP32 local anisotropy field. |
| `backends/fdm/gpu/cuda/interactions/multilayer_anisotropy.cu` | `multilayer_anisotropy_field_kernel` | Multilayer FDM CUDA local anisotropy field. |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_uniaxial_anisotropy_energy_fp64` | FDM CUDA FP64 energy reduction. |
| `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp` | `compute_uniaxial_anisotropy_field` | FEM CPU field and lumped energy. |
| `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp` | `uniaxial_anisotropy_energy_from_element_quadrature_material` | FEM CPU spatial-material energy. |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu` | `uniaxial_anisotropy_field_energy_blocks_kernel` | FEM CUDA local field/energy blocks. |
| `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu` | `gpu_rk_compute_anisotropy_field_contributions` | FEM CUDA RK field dispatch and fail-closed checks. |
| `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu` | `gpu_rk_reduce_final_anisotropy_energy_terms` | FEM CUDA final energy reduction. |
