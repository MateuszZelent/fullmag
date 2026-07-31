---
title: Anisotropy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0402-uniaxial-anisotropy.md and docs/physics/0403-cubic-anisotropy.md
---

(public-docs-physics-interactions-anisotropy-root)=
# Magnetocrystalline anisotropy

This is the canonical physical owner for FullMag magnetocrystalline anisotropy. It defines the
shared interaction contract once and separates the two implemented symmetry families into
{doc}`uniaxial` and {doc}`cubic`. The pages are not four copies for FDM CPU, FDM GPU, FEM CPU, and
FEM GPU: solver and device differences belong in the realization matrix below and in the
family-specific chapters.

The public compatibility objects `fullmag.UniaxialAnisotropy` and `fullmag.CubicAnisotropy` are
authoring forms. During lowering they are migrated to the target `Material`; they do not create a
second physical energy term in `ProblemIR`.

```{toctree}
:maxdepth: 1

uniaxial
cubic
```

(anisotropy-problem-statement)=
## Physical problem

Let $\Omega_m$ be the magnetic domain, $\mathbf M$ the magnetization,
$M_s>0$ the saturation magnetization, and $\mathbf m=\mathbf M/M_s$ the reduced
magnetization. Magnetocrystalline anisotropy is a local energy density that depends on the
orientation of $\mathbf m$ relative to a material frame. It is distinct from exchange and
demagnetization: it contains no spatial derivative and does not require a Poisson, convolution,
or boundary-value solve.

FullMag currently exposes two material-frame families:

* uniaxial anisotropy, with one easy-axis direction $\mathbf u$ and constants $K_{u1}$ and
  $K_{u2}$;
* cubic anisotropy, with two supplied crystal axes $\mathbf c_1$, $\mathbf c_2$, a derived
  $\mathbf c_3=\mathbf c_1\times\mathbf c_2$, and constants $K_{c1}$, $K_{c2}$, and $K_{c3}$.

The physical interaction is conservative. Its field is added to the effective-field assembly and
its energy is included in the anisotropy scalar observable. The LLG equation and magnetization
normalization are owned by the dynamics contract, not duplicated here.

(anisotropy-governing-equations)=
## Governing equations

The total anisotropy is the sum of the active family contributions:

```{math}
:label: eq-anisotropy-total-energy
E_{\mathrm{ani}}[\mathbf m]
=E_{\mathrm u}[\mathbf m]+E_{\mathrm c}[\mathbf m],
\qquad
\mathbf H_{\mathrm{ani}}
=\mathbf H_{\mathrm u}+\mathbf H_{\mathrm c}.
```

For uniaxial anisotropy, define the projection

```{math}
:label: eq-anisotropy-uniaxial-projection
q=\mathbf m\cdot\mathbf u.
```

The implemented FullMag energy convention is

```{math}
:label: eq-anisotropy-uniaxial-energy
w_{\mathrm u}=-K_{u1}q^2-K_{u2}q^4,
\qquad
E_{\mathrm u}=\int_{\Omega_m}w_{\mathrm u}\,\mathrm dV,
\qquad
\mathbf H_{\mathrm u}
=\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\,\mathbf u.
```

For cubic anisotropy, define the direction cosines and invariant

```{math}
:label: eq-anisotropy-cubic-frame
\mathbf c_3=\mathbf c_1\times\mathbf c_2,
\qquad
\alpha_a=\mathbf m\cdot\mathbf c_a,
\qquad
\Sigma=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2.
```

The implemented cubic density is

```{math}
:label: eq-anisotropy-cubic-energy
w_{\mathrm c}=K_{c1}\Sigma
+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2
+K_{c3}\Sigma^2,
\qquad
E_{\mathrm c}=\int_{\Omega_m}w_{\mathrm c}\,\mathrm dV.
```

The effective fields use the common FullMag SI variational convention

```{math}
:label: eq-anisotropy-effective-field
\mathbf H_{\mathrm{ani}}
=-\frac{1}{\mu_0M_s}
\frac{\delta E_{\mathrm{ani}}}{\delta\mathbf m},
\qquad
\mathbf H_{\mathrm c}=g_1\mathbf c_1+g_2\mathbf c_2+g_3\mathbf c_3.
```

The complete $g_a$ expressions are recorded in {doc}`cubic`; they must not be replaced by a
single-axis approximation when the cubic family is active. Likewise, the complete uniaxial
parameter and field contract is recorded in {doc}`uniaxial`.

## Solver and backend realization matrix

| Solver | Device | Status | Realized contract and qualification boundary |
|---|---|---|---|
| FDM | CPU | reference | Cell-local uniaxial/cubic field evaluation, active-cell masking, and cell-volume energy reduction in the reference path. |
| FDM | GPU | implemented | Separate FP64 and FP32 local kernels plus scalar reductions; multilayer dispatch has its own kernel. Source availability is not executed-device qualification. |
| FEM | CPU | implemented | Nodal field evaluation with magnetic-node/lumped-volume reductions and material-field promotion; crystal-frame validation is planner-owned. |
| FEM | GPU | implemented | Device-resident uniaxial/cubic field and block-energy kernels with final reductions; missing device buffers fail closed and parity requires executed-device evidence. |

The matrix describes implementation evidence, not universal qualification. A resolved execution
record must retain the requested constants and axes, normalized or validated frame, scalar versus
spatial coefficient realization, solver, device, precision, mesh, and output legality.

(anisotropy-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\mathbf u$ | uniaxial easy-axis direction | $1$ |
| $q$ | uniaxial projection $\mathbf m\cdot\mathbf u$ | $1$ |
| $K_{u1}$ | first-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{u2}$ | second-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $\mathbf c_1$ | first supplied cubic crystal axis | $1$ |
| $\mathbf c_2$ | second supplied cubic crystal axis | $1$ |
| $\mathbf c_3$ | derived cubic crystal axis $\mathbf c_1\times\mathbf c_2$ | $1$ |
| $\alpha_a$ | cubic direction cosine $\mathbf m\cdot\mathbf c_a$ | $1$ |
| $\Sigma$ | first cubic invariant | $1$ |
| $K_{c1}$ | first cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c2}$ | second cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c3}$ | third cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $w_{\mathrm u}$ | uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $w_{\mathrm c}$ | cubic anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm u}$ | total uniaxial anisotropy energy | $\mathrm{J}$ |
| $E_{\mathrm c}$ | total cubic anisotropy energy | $\mathrm{J}$ |
| $E_{\mathrm{ani}}$ | total anisotropy energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm u}$ | uniaxial effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm c}$ | cubic effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{ani}}$ | total anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| $g_a$ | crystal-frame cubic field component | $\mathrm{A\,m^{-1}}$ |
| $i$ | discrete cell or node index | $1$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM magnetic-node lumped integration weight | $\mathrm{m^3}$ |

(anisotropy-assumptions-and-validity)=
## Assumptions and validity

* All constants are authored directly in SI energy density units
  $\mathrm{J\,m^{-3}}$. No CGS conversion or hidden $\mu_0$ factor is applied to the energy.
* $M_s$ is finite and positive. The field scales with $1/M_s$; the energy density does not.
* An active uniaxial axis must be finite and non-zero. Native lanes normalize the direction where
  their contract allows it; the resolved provenance must record the normalized value.
* The cubic frame is physically orthonormal. FEM planning validates the supplied axes strictly;
  FDM behavior that normalizes or derives axes is a lane-specific realization and is not evidence
  that arbitrary non-orthogonal frames are physically valid.
* Spatial coefficient fields are mesh-associated data. Their length, interpolation, and memory
  residency are validated by the selected planner; a Python list does not bypass those checks.
* The negative-power uniaxial energy convention and the cubic polynomial above define the absolute
  FullMag energy. A publication that adds a constant to the energy may have the same field but a
  different reported scalar energy.
* Anisotropy is local and has no independent boundary condition. Any surface anisotropy or DMI
  boundary term is a different interaction and must not be folded into these constants.

(anisotropy-python-api)=
## Python authoring and complete parameter contract

The canonical authoring form stores anisotropy on `Material`. The compatibility constructors are
still public and are migrated only for a single material target.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `UniaxialAnisotropy.ku1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy` |
| `UniaxialAnisotropy.ku2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy_k2` |
| `UniaxialAnisotropy.axis` | `Sequence[float]` | `(0,0,1)` | $1$ | length 3 and finite; non-zero when active | uniaxial easy axis | FDM/FEM CPU/GPU after migration | `materials[].anisotropy_axis` |
| `CubicAnisotropy.kc1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc1` |
| `CubicAnisotropy.kc2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc2` |
| `CubicAnisotropy.kc3` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | third cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc3` |
| `CubicAnisotropy.axis1` | `Sequence[float]` | `(1,0,0)` | $1$ | length 3 and finite | first cubic crystal axis | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_axis1` |
| `CubicAnisotropy.axis2` | `Sequence[float]` | `(0,1,0)` | $1$ | length 3 and finite | second cubic crystal axis | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_axis2` |
| `Material.Ku1` | `float or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first-order uniaxial value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second-order uniaxial value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | `tuple[float,float,float] or None` | `None` | $1$ | length 3 and finite; non-zero when active | canonical uniaxial axis | FDM/FEM CPU/GPU | `materials[].anisotropy_axis` |
| `Material.Kc1` | `float or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical third cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple[float,float,float] or None` | `None` | $1$ | length 3 and finite | canonical first cubic axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple[float,float,float] or None` | `None` | $1$ | length 3 and finite | canonical second cubic axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis2` |
| `Material.Ku_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite values; mesh cardinality downstream | spatial $K_{u1}$ override | FEM and supported allocating FDM reference paths | `materials[].ku_field` |
| `Material.Ku2_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite values; mesh cardinality downstream | spatial $K_{u2}$ override | FEM and supported allocating FDM reference paths | `materials[].ku2_field` |
| `Material.Kc1_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite values; mesh cardinality downstream | spatial $K_{c1}$ override | FEM and supported allocating FDM reference paths | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite values; mesh cardinality downstream | spatial $K_{c2}$ override | FEM and supported allocating FDM reference paths | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite values; mesh cardinality downstream | spatial $K_{c3}$ override | FEM and supported allocating FDM reference paths | `materials[].kc3_field` |

```python
# %% Copyable Python/Jupyter example: canonical material-owned anisotropy
import json
import fullmag as fm

nm = 1.0e-9
material = fm.Material(
    name="anisotropic-film",
    Ms=800.0e3,
    A=13.0e-12,
    alpha=0.01,
    Ku1=0.5e6,
    Ku2=0.05e6,
    anisU=(0.0, 0.0, 1.0),
)
magnet = fm.Ferromagnet(
    name="film",
    geometry=fm.Box(size=(40 * nm, 20 * nm, 5 * nm), name="film-geometry"),
    material=material,
    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
)
problem = fm.Problem(
    name="uniaxial-example",
    magnets=[magnet],
    energy=[fm.Exchange()],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
)
print(json.dumps(problem.to_ir(include_geometry_assets=False), indent=2))

# %% Compatibility form: migrated to the same material-owned representation
legacy = fm.Problem(
    name="legacy-anisotropy-example",
    magnets=[magnet],
    energy=[fm.UniaxialAnisotropy(ku1=0.5e6, ku2=0.05e6, axis=(0.0, 0.0, 1.0))],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
)
print(json.dumps(legacy.to_ir(include_geometry_assets=False), indent=2))
```

The code block is an authoring example, not device qualification. It shows the public lowering
contract and can be adapted to a cubic material by setting `Kc1`, `Kc2`, `Kc3`, `anisC1`, and
`anisC2`, or by using `fm.CubicAnisotropy` as the compatibility energy term.

(anisotropy-problem-ir)=
## ProblemIR and planner resolution

The canonical material fragment produced by the example is material-owned:

```json
{
  "uniaxial_anisotropy": 500000.0,
  "uniaxial_anisotropy_k2": 50000.0,
  "anisotropy_axis": [0.0, 0.0, 1.0],
  "cubic_anisotropy_kc1": null,
  "cubic_anisotropy_kc2": null,
  "cubic_anisotropy_kc3": null,
  "cubic_anisotropy_axis1": null,
  "cubic_anisotropy_axis2": null
}
```

The compatibility migration removes `UniaxialAnisotropy` and `CubicAnisotropy` from the final
energy-term list and merges their values into exactly one material. `_migrate_legacy_anisotropy_energy_terms`
rejects multiple material targets and conflicting existing values. `plan_fdm` and `plan_fem` then
resolve scalar or spatial material data, axis legality, masks, mesh cardinality, selected solver,
device, and precision. The planner may reject an unsupported combination; it must never drop an
anisotropy term while reporting a successful execution.

(anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the original Python constructor or material fields, including values before
axis normalization and before planner promotion of region values. Resolved execution is the
material-owned IR plus normalized/validated axes, resolved scalar versus spatial coefficients,
solver, device, precision, mesh, and output decisions. Script export must preserve the canonical
material form when no compatibility term is needed.

Validation errors include non-finite constants, malformed vectors, an active zero uniaxial axis,
conflicting legacy/material values, multiple material targets, invalid spatial-field cardinality,
invalid FEM cubic axes, and illegal output requests. Unsupported combinations are planner errors,
not silent fallbacks. Source presence or Python acceptance is not proof of GPU execution or parity.

(anisotropy-discrete-realization)=
## Discrete realization

### FDM CPU

The reference path evaluates each active cell locally. The uniaxial field and energy are the
pointwise formulas above multiplied by $V_i$ for the scalar reduction; the cubic path evaluates
the three crystal projections and the full polynomial at the cell. Inactive cells contribute zero
field and zero energy. Spatial coefficient arrays are only used by allocating reference paths when
their cardinality matches the realized grid.

### FDM GPU

The standard CUDA path has separate FP64 and FP32 kernels. Field and scalar-energy operations are
separate dispatches, and the multilayer path has a layer-local anisotropy kernel. CUDA context
uploads reject arrays with the wrong cell count. The precision-specific reduction order changes
round-off, so parity requires a declared tolerance and matched material/mask state. A compiled
kernel is not executed-device evidence.

### FEM CPU

The native FEM path evaluates local anisotropy at magnetic nodes and uses magnetic-node volumes or
element material quadrature for energy. Non-magnetic nodes are excluded. The planner promotes
region-varying constants to resolved fields and validates cubic axes before native evaluation.
FEM spatial interpolation and lumped/consistent integration are not interchangeable with the FDM
cell sum; comparisons must state the mesh and reduction rule.

### FEM GPU

The CUDA kernels keep magnetization, saturation, constants, optional spatial fields, axes, masks,
lumped masses, and block sums in device-resident buffers. Uniaxial and cubic field/energy kernels
are separate. A missing or incompatible buffer is a fail-closed runtime error; the host FEM path
is not an implicit fallback. Final energy reductions and RK field dispatch are separate runtime
responsibilities.

### Observables

| Observable | Kind | SI unit | Meaning |
|---|---|---|---|
| `H_ani` | vector field | $\mathrm{A\,m^{-1}}$ | uniaxial or total anisotropy effective field, according to the quantity catalog |
| `H_ani_cubic` | vector field | $\mathrm{A\,m^{-1}}$ | cubic anisotropy field where separately materialized |
| `E_ani` | scalar | $\mathrm{J}$ | total uniaxial plus cubic anisotropy energy |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | local anisotropy energy density where materialized |

(anisotropy-implementation-mapping)=
## Implementation mapping

The implementation is intentionally layered:

1. `UniaxialAnisotropy` and `CubicAnisotropy` own compatibility construction and serialization.
2. `Material` owns canonical scalar and spatial fields.
3. `_migrate_legacy_anisotropy_energy_terms` owns conflict-checked migration.
4. `plan_fdm` and `plan_fem` own backend-specific resolution and legality.
5. FDM CPU and CUDA own cell-local field and energy realization.
6. FEM CPU and CUDA own nodal/element or device-resident realization and reductions.

The adjacent source map gives every equation and implementation claim a repository-relative path
and stable symbol. Generated line links may be added for a particular immutable revision, but a
line range is never the source identity.

(anisotropy-validation)=
## Validation and qualification

The minimum scientific checks are:

* for uniaxial $\mathbf m=\mathbf u$, verify $q=1$, the analytic field, and the negative-power
  energy; for $\mathbf m\perp\mathbf u$, verify zero uniaxial field and density;
* for cubic high-symmetry directions, compare the full polynomial energy and finite-difference
  derivative with the crystal-frame field;
* compare scalar and spatial coefficient fields with scalar baselines after mesh cardinality and
  integration rules are fixed;
* test active masks, zero/inactive terms, migration conflicts, invalid axes, and output legality;
* compare FDM CPU, FDM CUDA FP64/FP32, FEM CPU, and FEM CUDA on the same physical state, recording
  mesh, precision, reduction order, device identity, and tolerances.

Python tests and static source validation establish API and structural contracts. They do not
establish executed-device GPU parity; that requires managed runtime evidence and a declared
qualification record.

(anisotropy-limitations)=
## Limitations and deferred qualification

The public API exposes material-level axes and spatial coefficient fields, not arbitrary public
per-node orientation fields. FEM strict crystal-frame validation and FDM normalization behavior
remain distinct lane contracts. The public documentation records implementation status separately
from executed-device qualification; it does not promote a source-only or skipped GPU test to
qualified parity.

(anisotropy-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown, *Micromagnetics*, Wiley, 1963.
2. FullMag canonical uniaxial model: `docs/physics/0402-uniaxial-anisotropy.md`.
3. FullMag canonical cubic model: `docs/physics/0403-cubic-anisotropy.md`.
4. FullMag material-region and parameter-field semantics:
   `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`.

(anisotropy-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class UniaxialAnisotropy` | Compatibility uniaxial constructor and serialization. |
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class CubicAnisotropy` | Compatibility cubic constructor and serialization. |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical anisotropy fields and material serialization. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `_migrate_legacy_anisotropy_energy_terms` | Conflict-checked compatibility migration. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM material and execution-plan resolution. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM material promotion and axis legality. |
| `crates/fullmag-engine/src/fem.rs` | `anisotropy_field_from_vectors` | FEM CPU combined anisotropy field. |
| `crates/fullmag-engine/src/fem.rs` | `uniaxial_anisotropy_energy_from_vectors` | FEM CPU uniaxial energy reduction. |
| `crates/fullmag-engine/src/fem.rs` | `cubic_anisotropy_energy_from_vectors` | FEM CPU cubic energy reduction. |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `anisotropy_field_fp64_kernel` | FDM CUDA FP64 local anisotropy field. |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `anisotropy_field_fp32_kernel` | FDM CUDA FP32 local anisotropy field. |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_uniaxial_anisotropy_energy_fp64` | FDM CUDA FP64 uniaxial energy reduction. |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_cubic_anisotropy_energy_fp64` | FDM CUDA FP64 cubic energy reduction. |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu` | `uniaxial_anisotropy_field_energy_blocks_kernel` | FEM CUDA uniaxial field and block energy. |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu` | `cubic_anisotropy_field_energy_blocks_kernel` | FEM CUDA cubic field and block energy. |
